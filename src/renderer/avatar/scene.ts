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

export interface LoadResult {
  hasExpressions: boolean
  hasLookAt: boolean
  presets: string[]
}

export class VrmScene {
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  private readonly renderer: THREE.WebGLRenderer
  private readonly clock = new THREE.Clock()

  private vrm: VRM | null = null
  /** 모델을 담는 피벗. 머리 위 한 점을 원점으로 삼아 여기서 흔든다. */
  private hanger: THREE.Group | null = null
  private hangerRestY = 0

  private mixer: THREE.AnimationMixer | null = null
  private currentAction: THREE.AnimationAction | null = null
  private currentMotionName: string | null = null
  private currentMotionLoop = false
  private readonly clips = new Map<string, THREE.AnimationClip>()

  /**
   * 커서와 손을 화면 좌표에서 붙이는 드래그 앵커.
   * VRMA 는 자세를 만들고, 이 보정은 매 프레임 실제 손 본을 커서에 고정한다.
   */
  private dragAnchor: { x: number; y: number } | null = null
  private dragGrip: THREE.Object3D | null = null
  private readonly dragOffset = new THREE.Vector3()
  private dragReleaseRemaining = 0
  private dragRestoreMotion: { name: string; loop: boolean } | null = null
  private readonly dragGripWorld = new THREE.Vector3()
  private readonly dragTargetWorld = new THREE.Vector3()
  private readonly dragProjected = new THREE.Vector3()

  /** 시선 타깃. 카메라 자식으로 붙여야 화면 좌표를 그대로 쓸 수 있다. */
  private readonly lookTarget = new THREE.Object3D()
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
    this.renderer.setPixelRatio(window.devicePixelRatio)
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

  async loadVRM(url: string): Promise<LoadResult> {
    const loader = new GLTFLoader()
    loader.register((parser) => new VRMLoaderPlugin(parser))

    const gltf = await loader.loadAsync(url)
    // 평범한 .glb 나 손상된 .vrm 도 promise 는 성공으로 끝난다. userData.vrm 이 없을 뿐이다.
    const vrm = gltf.userData.vrm as VRM | undefined
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
    this.mixer = new THREE.AnimationMixer(vrm.scene)

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

    const loader = new GLTFLoader()
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser))
    const gltf = await loader.loadAsync(url)

    const animations = gltf.userData.vrmAnimations as unknown[] | undefined
    const first = animations?.[0]
    if (!first) throw new Error(`${name}: VRMA 에 애니메이션이 없다`)

    this.clips.set(name, createVRMAnimationClip(first as never, vrm))
  }

  get motionNames(): string[] {
    return [...this.clips.keys()]
  }

  playMotion(name: string, loop: boolean): boolean {
    const clip = this.clips.get(name)
    if (!clip || !this.mixer) return false

    const next = this.mixer.clipAction(clip)
    next.reset()
    next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1)
    next.clampWhenFinished = !loop

    if (this.currentAction && this.currentAction !== next) this.currentAction.fadeOut(0.3)
    next.fadeIn(0.3).play()
    this.currentAction = next
    this.currentMotionName = name
    this.currentMotionLoop = loop

    // VRMA 의 시선 트랙과 살아 있는 lookAt.target 이 서로 덮어쓴다.
    // 클립이 도는 동안에는 자동 추적을 끈다.
    if (this.vrm?.lookAt) this.vrm.lookAt.autoUpdate = false
    return true
  }

  stopMotion(): void {
    this.currentAction?.fadeOut(0.3)
    this.currentAction = null
    this.currentMotionName = null
    this.currentMotionLoop = false
    if (this.vrm?.lookAt) this.vrm.lookAt.autoUpdate = true
  }

  /**
   * 전용 매달림 VRMA 를 켜고 오른손 끝을 현재 커서에 붙인다.
   * 모션 또는 손 본이 없으면 false 를 돌려 기존 루트 진자만 사용하게 한다.
   */
  beginPointerDrag(x: number, y: number): boolean {
    const vrm = this.vrm
    if (!vrm || !this.hanger || !this.clips.has(DRAG_MOTION)) return false

    const grip =
      vrm.humanoid.getNormalizedBoneNode('rightMiddleDistal') ??
      vrm.humanoid.getNormalizedBoneNode('rightHand')
    if (!grip) return false

    this.dragRestoreMotion =
      this.currentMotionName && this.currentMotionName !== DRAG_MOTION
        ? { name: this.currentMotionName, loop: this.currentMotionLoop }
        : null
    if (!this.playMotion(DRAG_MOTION, true)) return false

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
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.fitCamera()
  }

  private fitCamera(): void {
    if (!this.hanger) return
    const h = this.canvas.clientHeight || 1
    fitCameraToObject(this.camera, this.hanger, (this.canvas.clientWidth || 1) / h)
  }

  render(): { pointerOverAvatar: boolean } {
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
    if (this.hanger) {
      this.hanger.rotation.z = this.hang.swing
      this.hanger.position.set(
        this.dragOffset.x,
        this.hangerRestY - this.hang.droop + this.dragOffset.y,
        this.dragOffset.z
      )
    }

    // 순서가 중요하다. vrm.update 안의 humanoid.update() 가 정규화 본을 실제 본으로
    // 복사하므로, 그 뒤에 정규화 본을 건드리면 그 프레임에서는 조용히 버려진다.
    //   1) 믹서(VRMA)  2) 절차적 보정  3) vrm.update  4) render
    this.mixer?.update(delta)
    // VRMA 가 도는 동안 여기서 rotation 을 대입하면 믹서 결과를 덮어쓴다.
    if (!this.currentAction && this.vrm?.humanoid) {
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
    return (this.pixel[3] ?? 0) > 8
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
    if (restore && this.clips.has(restore.name)) this.playMotion(restore.name, restore.loop)
    else this.stopMotion()
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
    this.dragAnchor = null
    this.dragGrip = null
    this.dragOffset.set(0, 0, 0)
    this.dragReleaseRemaining = 0
    this.dragRestoreMotion = null
    this.clips.clear()
  }

  dispose(): void {
    this.disposeVrm()
    this.renderer.dispose()
  }
}
