import * as THREE from 'three'
// @pixiv 의 .d.ts 가 참조하는 것과 **같은 경로**로 가져와야 한다.
// 'three/addons/...' 도 런타임에는 해석되지만 GLTFParser 타입이 구조적으로 분리되어
// loader.register((parser) => new VRMLoaderPlugin(parser)) 가 타입 에러를 낸다.
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'
import type { VRM } from '@pixiv/three-vrm'
import {
  VRMAnimationLoaderPlugin,
  VRMLookAtQuaternionProxy,
  createVRMAnimationClip
} from '@pixiv/three-vrm-animation'
import type { Emotion, Viseme } from '@shared/protocol'
import { applyIdlePose, clampAngle, damp, fitCameraToObject } from './pose'
import { HangPhysics } from './hang'
import {
  DEFAULT_AMBIENT_MOTION,
  ambientHoldSeconds,
  effectiveMotionLoop,
  isInteractiveMotion,
  motionRole,
  pickAmbientMotion,
  transitionSeconds
} from './motionTransitions'
import type { MotionRole } from './motionTransitions'

/** 우리 Emotion 은 VRM 1.0 프리셋 이름과 1:1 이다. v0 의 joy/fun/sorrow 는 3.x 에 없다. */
const EMOTION_EXPRESSIONS: readonly Emotion[] = ['happy', 'angry', 'sad', 'relaxed', 'surprised']

const VISEME_EXPRESSIONS: readonly Exclude<Viseme, 'sil'>[] = ['aa', 'ih', 'ou', 'ee', 'oh']

/** 머리가 돌아갈 수 있는 한계. 넘어가면 목이 꺾여 보인다. */
const MAX_YAW = 0.5
const MAX_PITCH = 0.32
/** 머리가 커서를 따라가는 속도. 클수록 즉각적이고, 낮으면 느긋하다. */
const HEAD_STIFFNESS = 7

/** 드래그 중 재생하는 전용 VRMA. 파일이 없으면 기존 드래그 동작으로 안전하게 폴백한다. */
const DRAG_MOTION = 'mouse-tether-right'
/** 손을 놓은 뒤 앵커 보정을 원점으로 되돌리는 짧은 완충 시간. */
const DRAG_RELEASE_SECONDS = 0.32
const DRAG_OFFSET_STIFFNESS = 14
/** 진행 방향으로 아주 조금만 기울인다. 큰 값은 걷기보다 넘어지는 것처럼 보인다. */
const ROAM_LEAN = THREE.MathUtils.degToRad(4)
const ROAM_LEAN_STIFFNESS = 8

export interface LoadResult {
  hasExpressions: boolean
  hasLookAt: boolean
  presets: string[]
}

interface MotionSnapshot {
  name: string
  loop: boolean
  time: number
}

interface PendingMotionRequest {
  name: string
  loop: boolean
}

interface MotionBlendState {
  sources: Map<THREE.AnimationAction, number>
  target: THREE.AnimationAction
  elapsed: number
  duration: number
}

type MotionStartReason = 'request' | 'ambient' | 'interactive' | 'restore' | 'roam'

export class VrmScene {
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  private readonly renderer: THREE.WebGLRenderer
  private rendererPixelRatio = 1
  private readonly clock = new THREE.Clock()

  private vrm: VRM | null = null
  /** 늦게 끝난 이전 모델/모션 load가 최신 모델 상태를 덮지 못하게 하는 세대 번호. */
  private modelLoadGeneration = 0
  /** 모델을 담는 피벗. 머리 위 한 점을 원점으로 삼아 여기서 흔든다. */
  private hanger: THREE.Group | null = null
  private hangerRestY = 0

  private mixer: THREE.AnimationMixer | null = null
  private currentAction: THREE.AnimationAction | null = null
  private currentMotionName: string | null = null
  private currentMotionLoop = false
  private currentMotionRole: MotionRole | null = null
  /** 단발 동작이 끝난 뒤 이어서 재생할 이전 반복 동작. */
  private resumeMotion: MotionSnapshot | null = null
  private ambientRemaining = 0
  private cursorLookWeight = 1
  private cursorLookFrom = 1
  private cursorLookTo = 1
  private cursorLookElapsed = 0
  private cursorLookDuration = 0
  private lastSwitchMixerTime = Number.NaN
  /** 같은 mixer tick의 요청은 중간 포즈를 만들지 않고 마지막 하나만 다음 tick에 실행한다. */
  private pendingMotionRequest: PendingMotionRequest | null = null
  /** 활성 action 가중치 합을 항상 1로 유지해 원본 T-pose가 틈새에 섞이지 않게 한다. */
  private readonly actionWeights = new Map<THREE.AnimationAction, number>()
  private motionBlend: MotionBlendState | null = null
  private readonly clips = new Map<string, THREE.AnimationClip>()

  /** 로밍은 일반 지속 모션과 달리 끝나면 반드시 출발 전 상태로 돌아가는 transient다. */
  private roaming = false
  private roamMotionActive = false
  private roamRestoreMotion: MotionSnapshot | null = null
  private roamPendingMotion: PendingMotionRequest | null = null
  private roamLean = 0
  private roamLeanTarget = 0

  /**
   * 커서와 손을 화면 좌표에서 붙이는 드래그 앵커.
   * VRMA 는 자세를 만들고, 이 보정은 매 프레임 실제 손 본을 커서에 고정한다.
   */
  private dragAnchor: { x: number; y: number } | null = null
  private dragGrip: THREE.Object3D | null = null
  private readonly dragOffset = new THREE.Vector3()
  private dragReleaseRemaining = 0
  private dragRestoreMotion: MotionSnapshot | null = null
  private refitAfterDrag = false
  private readonly dragGripWorld = new THREE.Vector3()
  private readonly dragTargetWorld = new THREE.Vector3()
  private readonly dragProjected = new THREE.Vector3()

  /** 시선 타깃. 카메라 자식으로 붙여야 화면 좌표를 그대로 쓸 수 있다. */
  private readonly lookTarget = new THREE.Object3D()
  private readonly lookTargetWorld = new THREE.Vector3()
  readonly hang = new HangPhysics()

  private emotion: Emotion = 'neutral'
  private emotionWeight = 1
  private viseme: Viseme = 'sil'
  private visemeWeight = 0
  /** 이 모델이 실제로 들고 있는 프리셋. 없는 이름에 setValue 하면 조용히 무시된다. */
  private available = new Set<string>()
  private readonly warned = new Set<string>()

  private blinkTimer = 0
  private nextBlinkAt = 2 + Math.random() * 3
  private elapsed = 0

  /** 창 중심 기준 정규화 커서 방향. x 오른쪽 +, y 아래 +. 창 밖이면 ±1 을 넘는다. */
  private gaze = { x: 0, y: 0 }
  private headYaw = 0
  private headPitch = 0

  private pointer: { x: number; y: number } | null = null
  private readonly pixel = new Uint8Array(4)
  /** 클릭 판정 알파 임계값. 설정에서 조절한다. */
  private hitAlpha = 8
  /** 유휴 시 자율 행동을 켤지. 설정에서 조절한다. */
  private ambientEnabled = true

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      // alpha:true 여야 clearAlpha 가 0 이 된다. 없으면 검은 사각형이 뜬다.
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: false,
      // three 기본값은 true 인데, 컴포지터가 가장자리를 되돌리는 방식과 어긋나면
      // 실루엣 둘레에 어두운 테두리가 생긴다. 오버레이에서는 false 가 안전하다.
      premultipliedAlpha: false
    })
    this.renderer.setClearAlpha(0)
    this.rendererPixelRatio = window.devicePixelRatio
    this.renderer.setPixelRatio(this.rendererPixelRatio)
    // 배경에 Color/Texture 를 넣는 순간 창이 불투명해진다. null 을 유지한다.
    this.scene.background = null

    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 20)
    // 시선 타깃을 카메라 자식으로 두면 커서 방향을 카메라 로컬 좌표로 바로 옮길 수 있다.
    this.camera.add(this.lookTarget)
    this.scene.add(this.camera)

    this.scene.add(new THREE.AmbientLight(0xffffff, 1.4))
    const key = new THREE.DirectionalLight(0xffffff, 1.6)
    key.position.set(1, 2, 1.6)
    this.scene.add(key)
    const rim = new THREE.DirectionalLight(0xaabbff, 0.5)
    rim.position.set(-1.2, 1.4, -1.5)
    this.scene.add(rim)

    this.resize()
  }

  async loadVRM(url: string): Promise<LoadResult | null> {
    const generation = ++this.modelLoadGeneration
    const loader = new GLTFLoader()
    loader.register((parser) => new VRMLoaderPlugin(parser))

    const gltf = await loader.loadAsync(url).catch((error: unknown) => {
      if (generation !== this.modelLoadGeneration) return null
      throw error
    })
    if (!gltf) return null
    // 평범한 .glb 나 손상된 .vrm 도 promise 는 성공으로 끝난다. userData.vrm 이 없을 뿐이다.
    const vrm = gltf.userData.vrm as VRM | undefined
    if (generation !== this.modelLoadGeneration) {
      if (vrm) VRMUtils.deepDispose(vrm.scene)
      return null
    }
    if (!vrm) throw new Error('VRM 데이터가 없다 (meta/humanoid 파싱 실패이거나 일반 glTF)')

    this.disposeVrm()

    // 인자 타입이 서로 달라 헷갈리기 쉽다 —
    // combineSkeletons/removeUnnecessaryVertices 는 Object3D, combineMorphs 는 VRM 을 받는다.
    // (removeUnnecessaryJoints 는 3.x 에서 deprecated 이고 combineSkeletons 가 대체다.)
    VRMUtils.removeUnnecessaryVertices(gltf.scene)
    VRMUtils.combineSkeletons(gltf.scene)
    VRMUtils.combineMorphs(vrm)
    // VRM 0.x 는 뒤를 보고 서 있다. metaVersion 이 '0' 일 때만 동작하므로 무조건 불러도 된다.
    VRMUtils.rotateVRM0(vrm)

    // VRMA 의 시선 트랙이 동작하려면 프록시가 vrm.scene 의 **직속 자식**이고 이름이 비어 있지
    // 않아야 한다 (createVRMAnimationClip 이 children.find 로 얕게만 찾는다).
    if (vrm.lookAt) {
      const proxy = new VRMLookAtQuaternionProxy(vrm.lookAt)
      proxy.name = 'VRMLookAtQuaternionProxy'
      vrm.scene.add(proxy)
    }

    vrm.scene.traverse((o) => {
      o.frustumCulled = false
    })

    // 매달림 피벗을 머리 위에 둔다. 모델을 그만큼 내려 달아두면 월드 위치는 그대로이면서
    // hanger.rotation.z 가 "위에서 매달려 흔들리는" 회전이 된다.
    const box = new THREE.Box3().setFromObject(vrm.scene)
    const top = box.max.y
    const hanger = new THREE.Group()
    hanger.position.y = top
    vrm.scene.position.y -= top
    hanger.add(vrm.scene)
    this.scene.add(hanger)

    this.hanger = hanger
    this.hangerRestY = top
    this.vrm = vrm
    // 믹서는 반드시 vrm.scene 에 뿌리내려야 한다. 클립 트랙 이름이 `Normalized_<bone>.quaternion`
    // 인데 그 노드들이 vrm.scene 아래에 있기 때문이다. 다른 곳에 걸면 조용히 아무 일도 안 한다.
    const mixer = new THREE.AnimationMixer(vrm.scene)
    mixer.addEventListener('finished', ({ action }) => this.handleMotionFinished(action))
    this.mixer = mixer

    if (vrm.lookAt) vrm.lookAt.target = this.lookTarget

    // 모델마다 키가 달라 카메라를 고정값으로 둘 수 없다. 전신이 들어오도록 맞춘다.
    this.fitCamera()

    // presetExpressionMap 은 Map 이 아니라 `{ [preset]?: VRMExpression }` 형태의 평범한 객체다.
    const presets = vrm.expressionManager
      ? Object.entries(vrm.expressionManager.presetExpressionMap)
          .filter(([, v]) => v != null)
          .map(([k]) => k)
      : []
    this.available = new Set(presets)
    this.warned.clear()

    return {
      hasExpressions: vrm.expressionManager != null,
      hasLookAt: vrm.lookAt != null,
      presets
    }
  }

  /** .vrma 를 읽어 이름으로 등록한다. 파일 하나에 애니메이션이 여러 개일 수 있다. */
  async loadMotion(name: string, url: string): Promise<void> {
    const vrm = this.vrm
    if (!vrm) throw new Error('모션을 붙이려면 VRM 이 먼저 로드되어야 한다')
    const generation = this.modelLoadGeneration

    const loader = new GLTFLoader()
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser))
    const gltf = await loader.loadAsync(url).catch((error: unknown) => {
      if (generation !== this.modelLoadGeneration || this.vrm !== vrm) return null
      throw error
    })
    if (!gltf) return

    // 구 모델 기준 normalized track을 새 mixer에 넣으면 target 없는 action이 idle까지 막는다.
    if (generation !== this.modelLoadGeneration || this.vrm !== vrm) return

    const animations = gltf.userData.vrmAnimations as unknown[] | undefined
    const first = animations?.[0]
    if (!first) throw new Error(`${name}: VRMA 에 애니메이션이 없다`)

    this.clips.set(name, createVRMAnimationClip(first as never, vrm))

    // 첫 생활 idle이 도착하는 즉시 절차적 자세에서 VRMA 상태기로 넘긴다.
    if (name === DEFAULT_AMBIENT_MOTION && !this.currentAction) {
      this.switchMotion(name, true, 'ambient')
    }
  }

  get motionNames(): string[] {
    // tether는 포인터 좌표 제약과 함께만 의미가 있다. LLM이 일반 모션으로 부르지 못하게 숨긴다.
    return [...this.clips.keys()].filter((name) => !isInteractiveMotion(name))
  }

  playMotion(name: string, requestedLoop: boolean): boolean {
    const clip = this.clips.get(name)
    if (!clip || !this.mixer) return false
    if (isInteractiveMotion(name)) {
      console.warn(`[avatar] '${name}'은 포인터 드래그 전용이라 일반 모션으로 재생하지 않는다.`)
      return false
    }
    const loop = effectiveMotionLoop(name, requestedLoop)
    if (requestedLoop && !loop) {
      console.warn(`[avatar] '${name}'은 이음새 없는 반복용 모션이 아니므로 한 번만 재생한다.`)
    }

    // 걷는 도중 받은 표정 동작을 바로 재생하면 발은 멈췄는데 창만 미끄러진다.
    // 마지막 요청 하나를 도착 직후 재생하고, 단발이면 출발 전 loop로 돌아가게 한다.
    if (this.roaming) {
      this.roamPendingMotion = { name, loop }
      return true
    }

    // 대화 중 새 모션이 와도 손을 놓기 전까지는 tether 를 끊지 않는다. 마지막 요청을 복귀 대상으로 둔다.
    if (this.dragGrip && name !== DRAG_MOTION) {
      this.queueMotionAfterDrag(name, loop)
      return true
    }

    return this.switchMotion(name, loop, 'request')
  }

  /** 출발 전 loop를 보존한 채 로밍 전용 모션과 방향 기울임을 시작한다. */
  beginRoamMotion(name: string | null, direction: -1 | 0 | 1): boolean {
    this.roamLeanTarget = -direction * ROAM_LEAN

    if (!this.roaming) {
      this.roamRestoreMotion =
        this.currentMotionLoop && this.currentMotionRole !== 'interactive'
          ? this.currentSnapshot()
          : this.resumeMotion
      this.roamPendingMotion = null
      this.roamMotionActive = false
    }
    this.roaming = true

    if (!name || !this.clips.has(name) || !effectiveMotionLoop(name, true)) return false
    if (this.currentMotionName === name && this.currentMotionLoop) {
      this.roamMotionActive = true
      return true
    }
    const started = this.switchMotion(name, true, 'roam')
    if (started) this.roamMotionActive = true
    return started
  }

  /** 도착·취소 모두 같은 경로로 정리해 walk만 내리고 이전 상태로 crossfade한다. */
  endRoamMotion(): void {
    this.roamLeanTarget = 0
    if (!this.roaming) return

    const ownedMotion = this.roamMotionActive
    const restore = this.roamRestoreMotion
    const pending = this.roamPendingMotion
    this.roaming = false
    this.roamMotionActive = false
    this.roamRestoreMotion = null
    this.roamPendingMotion = null

    // 로밍 모션을 못 찾았으면 현재 action은 건드리지 않는다. lean만 원위치로 감쇠한다.
    if (!ownedMotion) return

    // 사용자가 이동 중 잡았다면 tether가 손을 놓을 때 복귀/보류 동작을 처리하게 한다.
    if (this.dragGrip || this.dragReleaseRemaining > 0) {
      this.dragRestoreMotion = restore
      if (pending) this.queueMotionAfterDrag(pending.name, pending.loop)
      return
    }

    if (pending && this.clips.has(pending.name)) {
      this.resumeMotion = pending.loop ? null : restore
      if (this.switchMotion(pending.name, pending.loop, 'restore')) return
    }

    this.resumeMotion = null
    if (restore && this.clips.has(restore.name)) {
      this.switchMotion(restore.name, restore.loop, 'restore', restore.time)
    } else this.startAmbient(true)
  }

  stopMotion(): void {
    this.mixer?.stopAllAction()
    this.actionWeights.clear()
    this.motionBlend = null
    this.currentAction = null
    this.currentMotionName = null
    this.currentMotionLoop = false
    this.currentMotionRole = null
    this.resumeMotion = null
    this.ambientRemaining = 0
    this.cursorLookWeight = 1
    this.cursorLookFrom = 1
    this.cursorLookTo = 1
    this.cursorLookElapsed = 0
    this.cursorLookDuration = 0
    this.pendingMotionRequest = null
    this.roaming = false
    this.roamMotionActive = false
    this.roamRestoreMotion = null
    this.roamPendingMotion = null
    this.roamLeanTarget = 0
    if (this.vrm?.lookAt) this.vrm.lookAt.autoUpdate = true
  }

  private queueMotionAfterDrag(name: string, loop: boolean): void {
    const previousRestore = this.dragRestoreMotion
    if (loop) this.resumeMotion = null
    else if (!this.resumeMotion && previousRestore?.loop) this.resumeMotion = previousRestore
    this.dragRestoreMotion = { name, loop, time: 0 }
  }

  /**
   * AnimationMixer의 action을 실제 상태 그래프에 연결한다.
   * 단발 동작은 이전 loop를 복귀 지점으로 보존하고, ambient끼리는 호흡 위상을 맞춘다.
   */
  private switchMotion(
    name: string,
    loop: boolean,
    reason: MotionStartReason,
    startTime = 0
  ): boolean {
    const clip = this.clips.get(name)
    const mixer = this.mixer
    if (!clip || !mixer) return false

    // 같은 tick의 일반 요청은 화면에 나타난 적 없는 중간 포즈를 만들지 않고 latest만 보류한다.
    if (reason === 'request' && this.lastSwitchMixerTime === mixer.time) {
      this.pendingMotionRequest = { name, loop }
      return true
    }

    const previous = this.currentAction
    const previousRole = this.currentMotionRole
    const nextRole = motionRole(name, loop)

    if (reason === 'request') {
      if (loop) {
        // 명시적인 지속 모션은 앞으로 돌아갈 새 기준 상태다.
        this.resumeMotion = null
      } else if (
        previous &&
        this.currentMotionName &&
        this.currentMotionLoop &&
        previousRole !== 'interactive'
      ) {
        this.resumeMotion = this.currentSnapshot()
      }
    } else if (reason === 'ambient') {
      this.resumeMotion = null
    }

    const next = mixer.clipAction(clip)
    if (
      previous === next &&
      loop &&
      this.currentMotionLoop &&
      (reason === 'request' || reason === 'roam')
    ) return true
    if (previous === next && !loop && !this.currentMotionLoop && reason === 'request') return true

    const blendSeconds = transitionSeconds(previousRole, nextRole)
    let nextTime = startTime
    if (previous && previous !== next && previousRole === 'ambient' && nextRole === 'ambient') {
      const previousDuration = previous.getClip().duration
      if (previousDuration > 0 && clip.duration > 0) {
        nextTime = ((previous.time % previousDuration) / previousDuration) * clip.duration
      }
    }

    const wasActive = this.actionWeights.has(next)
    const restartFinishedSource = wasActive && next.paused && reason === 'request'
    if (!wasActive || restartFinishedSource) next.reset()
    next
      .stopFading()
      .setEffectiveTimeScale(1)
      .setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1)
    next.enabled = true
    next.paused = false
    next.clampWhenFinished = !loop
    if ((!wasActive || restartFinishedSource) && clip.duration > 0) {
      next.time = loop
        ? ((nextTime % clip.duration) + clip.duration) % clip.duration
        : Math.max(0, Math.min(nextTime, Math.max(0, clip.duration - 1e-4)))
    }
    next.play()
    this.beginMotionBlend(next, blendSeconds)

    this.currentAction = next
    this.currentMotionName = name
    this.currentMotionLoop = loop
    this.currentMotionRole = nextRole
    this.lastSwitchMixerTime = mixer.time
    this.ambientRemaining =
      nextRole === 'ambient' ? ambientHoldSeconds(Math.random()) : Number.POSITIVE_INFINITY

    // 생활 idle은 커서를 보고, 의미 있는 동작은 authored 시선을 쓴다. boolean으로 즉시
    // 바꾸면 눈이 한 프레임에 튀므로 모션 crossfade와 같은 시간축으로 yaw/pitch를 섞는다.
    if (this.vrm?.lookAt) {
      this.beginCursorLookBlend(nextRole === 'ambient' ? 1 : 0, blendSeconds)
      this.vrm.lookAt.autoUpdate = false
    }
    return true
  }

  private currentSnapshot(): MotionSnapshot | null {
    if (!this.currentAction || !this.currentMotionName) return null
    return {
      name: this.currentMotionName,
      loop: this.currentMotionLoop,
      time: this.currentAction.time
    }
  }

  private beginMotionBlend(target: THREE.AnimationAction, duration: number): void {
    const sources = new Map(this.actionWeights)
    if (sources.size === 0 && this.currentAction && this.currentAction !== target) {
      sources.set(this.currentAction, 1)
    }

    let total = 0
    for (const weight of sources.values()) total += Math.max(0, weight)
    if (total > 1e-8) {
      for (const [action, weight] of sources) sources.set(action, Math.max(0, weight) / total)
    } else {
      sources.clear()
    }

    if (duration <= 0 || sources.size === 0) {
      for (const action of this.actionWeights.keys()) {
        if (action !== target) action.stop()
      }
      target.setEffectiveWeight(1)
      this.actionWeights.clear()
      this.actionWeights.set(target, 1)
      this.motionBlend = null
      return
    }

    if (!sources.has(target)) target.setEffectiveWeight(0)
    this.motionBlend = { sources, target, elapsed: 0, duration }
    this.applyMotionBlendWeights(0)
  }

  /**
   * source 합 (1-ease) + target ease 구조라 중간에 다시 전환해도 전체 weight 합은 항상 1이다.
   * Three의 독립 fadeIn/fadeOut처럼 남는 비율을 원본(rest/T-pose)으로 채우지 않는다.
   */
  private applyMotionBlendWeights(ease: number): void {
    const blend = this.motionBlend
    if (!blend) return
    const weights = new Map<THREE.AnimationAction, number>()
    for (const [action, sourceWeight] of blend.sources) {
      weights.set(action, sourceWeight * (1 - ease))
    }
    weights.set(blend.target, (weights.get(blend.target) ?? 0) + ease)

    this.actionWeights.clear()
    for (const [action, weight] of weights) {
      action.setEffectiveWeight(weight)
      this.actionWeights.set(action, weight)
    }
  }

  private advanceMotionBlend(delta: number): void {
    const blend = this.motionBlend
    if (!blend) return
    blend.elapsed = Math.min(blend.duration, blend.elapsed + delta)
    const t = blend.duration > 0 ? blend.elapsed / blend.duration : 1
    const ease = t * t * (3 - 2 * t)
    this.applyMotionBlendWeights(ease)

    if (t >= 1) {
      for (const action of blend.sources.keys()) {
        if (action !== blend.target) action.stop()
      }
      blend.target.setEffectiveWeight(1)
      this.actionWeights.clear()
      this.actionWeights.set(blend.target, 1)
      this.motionBlend = null
    }
  }

  private beginCursorLookBlend(target: number, duration: number): void {
    this.cursorLookFrom = this.cursorLookWeight
    this.cursorLookTo = target
    this.cursorLookElapsed = 0
    this.cursorLookDuration = duration
    if (duration <= 0) this.cursorLookWeight = target
  }

  private advanceCursorLookBlend(delta: number): void {
    if (this.cursorLookDuration <= 0 || this.cursorLookWeight === this.cursorLookTo) return
    this.cursorLookElapsed = Math.min(this.cursorLookDuration, this.cursorLookElapsed + delta)
    const t = this.cursorLookElapsed / this.cursorLookDuration
    const ease = t * t * (3 - 2 * t)
    this.cursorLookWeight = THREE.MathUtils.lerp(this.cursorLookFrom, this.cursorLookTo, ease)
  }

  /** VRMA proxy가 기록한 authored yaw/pitch와 현재 커서 목표를 연속적으로 보간한다. */
  private applyCursorLookBlend(): void {
    const lookAt = this.vrm?.lookAt
    if (!lookAt || !this.currentAction || this.cursorLookWeight <= 0) return

    const authoredYaw = lookAt.yaw
    const authoredPitch = lookAt.pitch
    lookAt.lookAt(this.lookTarget.getWorldPosition(this.lookTargetWorld))
    const cursorYaw = lookAt.yaw
    const cursorPitch = lookAt.pitch
    lookAt.yaw = THREE.MathUtils.lerp(authoredYaw, cursorYaw, this.cursorLookWeight)
    lookAt.pitch = THREE.MathUtils.lerp(authoredPitch, cursorPitch, this.cursorLookWeight)
  }

  private handleMotionFinished(action: THREE.AnimationAction): void {
    if (action !== this.currentAction || this.currentMotionLoop || this.currentMotionRole === 'interactive') {
      return
    }

    const restore = this.resumeMotion
    this.resumeMotion = null
    if (restore && this.clips.has(restore.name)) {
      this.switchMotion(restore.name, restore.loop, 'restore', restore.time)
      return
    }
    this.startAmbient(true)
  }

  private startAmbient(preferDefault: boolean): boolean {
    const name =
      preferDefault && this.clips.has(DEFAULT_AMBIENT_MOTION)
        ? DEFAULT_AMBIENT_MOTION
        : pickAmbientMotion(this.clips, this.currentMotionName, Math.random())
    if (!name) {
      this.stopMotion()
      return false
    }
    return this.switchMotion(name, true, 'ambient')
  }

  private updateMotionDirector(delta: number): void {
    if (this.pendingMotionRequest && !this.dragGrip) {
      const pending = this.pendingMotionRequest
      this.pendingMotionRequest = null
      this.switchMotion(pending.name, pending.loop, 'request')
    }

    // ambientEnabled 가 꺼져 있으면 지금 돌고 있는 것만 계속 재생하고 다음으로 넘기지 않는다.
    // 여기서 검사하지 않으면 설정 화면의 스위치가 아무 일도 하지 않는다.
    if (this.currentMotionRole === 'ambient' && !this.dragGrip && this.ambientEnabled) {
      this.ambientRemaining -= delta
      if (this.ambientRemaining <= 0) {
        const next = pickAmbientMotion(this.clips, this.currentMotionName, Math.random())
        if (next && next !== this.currentMotionName) this.switchMotion(next, true, 'ambient')
        else this.ambientRemaining = ambientHoldSeconds(Math.random())
      }
    }

    if (!this.currentAction && this.actionWeights.size === 0 && this.vrm?.lookAt) {
      this.vrm.lookAt.autoUpdate = true
    }
  }

  /**
   * 전용 매달림 VRMA 를 켜고 오른손 끝을 현재 커서에 붙인다.
   * 모션 또는 손 본이 없으면 false 를 돌려 기존 루트 진자만 사용하게 한다.
   */
  beginPointerDrag(x: number, y: number): boolean {
    const vrm = this.vrm
    if (!vrm || !this.hanger || !this.clips.has(DRAG_MOTION)) return false

    // vrm.update() 이후 실제 mesh를 움직이는 raw 본을 잡아야 투영점과 보이는 손이 일치한다.
    const grip =
      vrm.humanoid.getRawBoneNode('rightMiddleDistal') ??
      vrm.humanoid.getRawBoneNode('rightMiddleIntermediate') ??
      vrm.humanoid.getRawBoneNode('rightMiddleProximal') ??
      vrm.humanoid.getRawBoneNode('rightHand')
    if (!grip) return false

    this.dragRestoreMotion =
      this.dragRestoreMotion ??
      (this.currentMotionLoop && this.currentMotionName !== DRAG_MOTION
        ? this.currentSnapshot()
        : this.resumeMotion)
    if (this.pendingMotionRequest) {
      const pending = this.pendingMotionRequest
      this.pendingMotionRequest = null
      this.queueMotionAfterDrag(pending.name, pending.loop)
    }
    // 단발 동작의 한가운데로 돌아가면 팔이 순간적으로 재개돼 어색하다. 드래그는 그 동작의
    // 복귀 loop를 보존하고, loop가 없으면 놓은 뒤 기본 생활 idle로 정착한다.
    if (!this.switchMotion(DRAG_MOTION, true, 'interactive')) return false

    this.dragGrip = grip
    this.dragAnchor = { x, y }
    this.dragReleaseRemaining = 0
    this.dragOffset.set(0, 0, 0)
    return true
  }

  updatePointerDrag(x: number, y: number): void {
    if (this.dragAnchor) this.dragAnchor = { x, y }
  }

  /** 손은 즉시 놓되, 몸과 카메라 안 위치는 짧게 감쇠시킨 뒤 이전 모션으로 돌아간다. */
  endPointerDrag(): void {
    if (!this.dragAnchor) return
    this.dragAnchor = null
    this.dragReleaseRemaining = DRAG_RELEASE_SECONDS
  }

  setEmotion(emotion: Emotion, weight = 1): void {
    this.emotion = emotion
    this.emotionWeight = Math.max(0, Math.min(1, weight))
  }

  setViseme(viseme: Viseme, weight: number): void {
    this.viseme = viseme
    this.visemeWeight = Math.max(0, Math.min(1, weight))
  }

  /** 화면 전역 커서 방향. main 이 폴링해서 넣어준다. */
  setGaze(x: number, y: number): void {
    this.gaze.x = x
    this.gaze.y = y
  }

  setPointer(p: { x: number; y: number } | null): void {
    this.pointer = p
  }

  resize(): void {
    const w = this.canvas.clientWidth
    const h = this.canvas.clientHeight
    if (w === 0 || h === 0) return
    const nextPixelRatio = window.devicePixelRatio
    if (Math.abs(nextPixelRatio - this.rendererPixelRatio) > 1e-6) {
      this.rendererPixelRatio = nextPixelRatio
      this.renderer.setPixelRatio(nextPixelRatio)
    }
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    if (this.dragGrip || this.dragReleaseRemaining > 0) this.refitAfterDrag = true
    else this.fitCamera()
  }

  private fitCamera(): void {
    if (!this.hanger) return
    const h = this.canvas.clientHeight || 1
    fitCameraToObject(this.camera, this.hanger, (this.canvas.clientWidth || 1) / h)
  }

  render(): { pointerOverAvatar: boolean } {
    // Chromium이 mixed-DPI 경계를 넘을 때 항상 resize를 보내는 것은 아니다.
    // backing buffer만 이전 배율에 남으면 모델이 흐려지므로 프레임 시작에 값만 비교한다.
    if (Math.abs(window.devicePixelRatio - this.rendererPixelRatio) > 1e-6) this.resize()

    const delta = this.clock.getDelta()
    this.elapsed += delta

    if (!this.dragAnchor && this.dragOffset.lengthSq() > 1e-10) {
      this.dragOffset.multiplyScalar(Math.exp(-DRAG_OFFSET_STIFFNESS * delta))
    }
    if (this.dragReleaseRemaining > 0) {
      this.dragReleaseRemaining -= delta
      if (this.dragReleaseRemaining <= 0) this.finishPointerDrag()
    }

    this.updateHead(delta)
    this.hang.update(delta)
    this.roamLean = damp(this.roamLean, this.roamLeanTarget, ROAM_LEAN_STIFFNESS, delta)
    if (this.hanger) {
      this.hanger.rotation.z = this.hang.swing + this.roamLean
      this.hanger.position.set(
        this.dragOffset.x,
        this.hangerRestY - this.hang.droop + this.dragOffset.y,
        this.dragOffset.z
      )
    }

    // 순서가 중요하다. vrm.update 안의 humanoid.update() 가 정규화 본을 실제 본으로
    // 복사하므로, 그 뒤에 정규화 본을 건드리면 그 프레임에서는 조용히 버려진다.
    //   1) 믹서(VRMA)  2) 절차적 보정  3) vrm.update  4) render
    this.advanceMotionBlend(delta)
    this.advanceCursorLookBlend(delta)
    this.mixer?.update(delta)
    this.applyCursorLookBlend()
    this.updateMotionDirector(delta)
    // VRMA 가 도는 동안 여기서 rotation 을 대입하면 믹서 결과를 덮어쓴다.
    if (!this.currentAction && this.actionWeights.size === 0 && this.vrm?.humanoid) {
      applyIdlePose(this.vrm.humanoid, {
        elapsed: this.elapsed,
        yaw: this.headYaw,
        pitch: this.headPitch
      })
    }
    this.applyExpressions(delta)
    this.vrm?.update(delta)

    // 믹서와 humanoid 복사가 끝난 실제 손 위치를 사용해야 한 프레임도 미끄러지지 않는다.
    this.pinDragGripToCursor()
    if (this.refitAfterDrag && !this.dragGrip && this.dragReleaseRemaining <= 0) {
      this.refitAfterDrag = false
      this.fitCamera()
    }

    this.renderer.render(this.scene, this.camera)

    return { pointerOverAvatar: this.pointer ? this.readAlphaAt(this.pointer) : false }
  }

  /**
   * 머리 각도를 감쇠로 따라가게 한다.
   *
   * 커서 위치를 그대로 대입하면 마우스를 빠르게 휙 던졌을 때 머리가 순간이동한다.
   * 지수 감쇠를 쓰면 프레임레이트와 무관하게 같은 "따라가는 느낌"이 나온다.
   */
  private updateHead(delta: number): void {
    const targetYaw = clampAngle(this.gaze.x * MAX_YAW, MAX_YAW)
    // 화면 좌표는 아래가 +y 이고, 머리를 숙이는 회전도 +x 다. 부호가 그대로 맞는다.
    const targetPitch = clampAngle(this.gaze.y * MAX_PITCH, MAX_PITCH)

    this.headYaw = damp(this.headYaw, targetYaw, HEAD_STIFFNESS, delta)
    this.headPitch = damp(this.headPitch, targetPitch, HEAD_STIFFNESS, delta)

    // 눈은 머리가 돌고 남은 만큼을 채운다. 카메라 로컬에서 위가 +y 라 y 부호를 뒤집는다.
    this.lookTarget.position.set(
      Math.sin(this.headYaw) * 1.5,
      -this.headPitch * 1.2,
      -1.5 * Math.cos(this.headYaw)
    )
  }

  private applyExpressions(delta: number): void {
    // expressionManager 는 optional 이다. 표정을 안 가진 VRM 도 정상적인 모델이다.
    const em = this.vrm?.expressionManager
    if (!em) return

    // 모델이 안 가진 표정을 요청하면 setValue 가 조용히 무시되어 무표정으로 굳는다.
    // 한 번만 알리고 neutral 로 떨어뜨린다.
    let target: Emotion | null = this.emotion
    if (target !== 'neutral' && !this.available.has(target)) {
      if (!this.warned.has(target)) {
        this.warned.add(target)
        console.warn(`[avatar] 이 모델에는 '${target}' 표정이 없다. 무표정으로 대체한다.`)
      }
      target = null
    }
    for (const name of EMOTION_EXPRESSIONS) {
      em.setValue(name, name === target ? this.emotionWeight : 0)
    }
    for (const name of VISEME_EXPRESSIONS) {
      em.setValue(name, name === this.viseme ? this.visemeWeight : 0)
    }

    // 눈 깜빡임. 말하는 중에도 깜빡여야 살아 있어 보인다.
    this.blinkTimer += delta
    let blink = 0
    if (this.blinkTimer >= this.nextBlinkAt) {
      const t = (this.blinkTimer - this.nextBlinkAt) / 0.12
      if (t >= 1) {
        this.blinkTimer = 0
        this.nextBlinkAt = 2 + Math.random() * 4
      } else {
        blink = t < 0.5 ? t * 2 : (1 - t) * 2
      }
    }
    em.setValue('blink', blink)
  }

  /**
   * 커서 아래 픽셀의 알파를 읽는다.
   *
   * 씬 전체가 하나의 <canvas> 라 document.elementFromPoint 는 항상 캔버스를 돌려준다.
   *  - GL 원점은 좌하단이라 CSS 의 y 와 뒤집혀 있다.
   *  - 드로잉 버퍼는 devicePixelRatio 배율이다 (Win11 125%/150% 에서 어긋난다).
   */
  private readAlphaAt(p: { x: number; y: number }): boolean {
    const gl = this.renderer.getContext()
    const dpr = this.renderer.getPixelRatio()
    const x = Math.round(p.x * dpr)
    const y = Math.round((this.canvas.clientHeight - p.y) * dpr)
    if (x < 0 || y < 0 || x >= gl.drawingBufferWidth || y >= gl.drawingBufferHeight) return false
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.pixel)
    // 임계값을 낮게 둬서 안티에일리어싱 가장자리를 포함시킨다. forward:true 상태에서는
    // 클릭이 전달되지 않으므로, 커서가 실루엣에 닿기 전에 전환이 끝나야 첫 클릭을 잃지 않는다.
    return (this.pixel[3] ?? 0) > this.hitAlpha
  }

  /**
   * 설정 화면에서 조절한 값을 반영한다.
   *
   * 재시작을 요구하면 슬라이더를 움직이며 맞출 수가 없다. 여기 오는 것들은
   * 전부 다음 프레임부터 바로 적용된다.
   */
  applyTuning(t: { hitAlpha: number; swayStrength: number; ambientMotion: boolean }): void {
    this.hitAlpha = t.hitAlpha
    this.hang.strength = t.swayStrength
    this.ambientEnabled = t.ambientMotion
    // 크기는 여기서 다루지 않는다. 카메라가 모델 바운딩 박스에 자동으로 맞추므로
    // 모델을 키운 뒤 다시 맞추면 화면상 크기가 그대로다 — 서로 상쇄된다.
    // 겉보기 크기는 **창 크기**로 바꾼다 (main 의 applyAvatarScale).
  }

  /**
   * 손의 현재 clip-space 깊이를 유지한 채 커서 NDC 를 같은 월드 평면으로 역투영한다.
   * 두 점의 차이만큼 hanger 전체를 옮기면 손은 고정되고 자식인 몸만 진자처럼 회전한다.
   */
  private pinDragGripToCursor(): void {
    const anchor = this.dragAnchor
    const grip = this.dragGrip
    const hanger = this.hanger
    if (!anchor || !grip || !hanger) return

    const rect = this.canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const ndcX = ((anchor.x - rect.left) / rect.width) * 2 - 1
    const ndcY = -((anchor.y - rect.top) / rect.height) * 2 + 1

    this.scene.updateMatrixWorld(true)
    grip.getWorldPosition(this.dragGripWorld)
    this.dragProjected.copy(this.dragGripWorld).project(this.camera)
    if (!Number.isFinite(this.dragProjected.z)) return

    this.dragTargetWorld.set(ndcX, ndcY, this.dragProjected.z).unproject(this.camera)
    this.dragTargetWorld.sub(this.dragGripWorld)
    this.dragOffset.add(this.dragTargetWorld)
    hanger.position.add(this.dragTargetWorld)
    hanger.updateMatrixWorld(true)
  }

  private finishPointerDrag(): void {
    this.dragReleaseRemaining = 0
    this.dragGrip = null
    this.dragOffset.set(0, 0, 0)
    const restore = this.dragRestoreMotion
    this.dragRestoreMotion = null
    if (restore && this.clips.has(restore.name)) {
      this.switchMotion(restore.name, restore.loop, 'restore', restore.time)
    } else this.startAmbient(true)
  }

  /**
   * 절전에서 깨어난 뒤 호출한다.
   *
   * 자는 동안 시계는 계속 흘렀다. 그 delta 를 한 번에 적분하면 스프링 본이 발산해서
   * 머리카락과 옷자락이 날아간다. 시계를 다시 잡고 스프링을 초기 상태로 되돌린다.
   */
  wake(): void {
    // getDelta 를 한 번 버려서 누적된 시간을 흘려보낸다.
    this.clock.getDelta()
    this.vrm?.springBoneManager?.reset()
  }

  private disposeVrm(): void {
    if (!this.vrm) return
    if (this.hanger) this.scene.remove(this.hanger)
    VRMUtils.deepDispose(this.vrm.scene)
    this.vrm = null
    this.hanger = null
    this.mixer = null
    this.currentAction = null
    this.currentMotionName = null
    this.currentMotionLoop = false
    this.currentMotionRole = null
    this.resumeMotion = null
    this.ambientRemaining = 0
    this.cursorLookWeight = 1
    this.cursorLookFrom = 1
    this.cursorLookTo = 1
    this.cursorLookElapsed = 0
    this.cursorLookDuration = 0
    this.lastSwitchMixerTime = Number.NaN
    this.pendingMotionRequest = null
    this.actionWeights.clear()
    this.motionBlend = null
    this.dragAnchor = null
    this.dragGrip = null
    this.dragOffset.set(0, 0, 0)
    this.dragReleaseRemaining = 0
    this.dragRestoreMotion = null
    this.refitAfterDrag = false
    this.roaming = false
    this.roamMotionActive = false
    this.roamRestoreMotion = null
    this.roamPendingMotion = null
    this.roamLean = 0
    this.roamLeanTarget = 0
    this.clips.clear()
  }

  dispose(): void {
    this.modelLoadGeneration += 1
    this.disposeVrm()
    this.renderer.dispose()
  }
}
