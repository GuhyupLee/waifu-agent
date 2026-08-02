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

/** 우리 Emotion 은 VRM 1.0 프리셋 이름과 1:1 이다. v0 의 joy/fun/sorrow 는 3.x 에 없다. */
const EMOTION_EXPRESSIONS: readonly Emotion[] = [
  'happy',
  'angry',
  'sad',
  'relaxed',
  'surprised'
] as const

const VISEME_EXPRESSIONS: readonly Exclude<Viseme, 'sil'>[] = ['aa', 'ih', 'ou', 'ee', 'oh'] as const

export interface LoadResult {
  hasExpressions: boolean
  hasLookAt: boolean
  /** 모델이 실제로 들고 있는 프리셋 이름들. 없는 표정에 setValue 해도 조용히 무시되므로 확인용. */
  presets: string[]
}

export class VrmScene {
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  private readonly renderer: THREE.WebGLRenderer
  private readonly clock = new THREE.Clock()

  private vrm: VRM | null = null
  private mixer: THREE.AnimationMixer | null = null
  private currentAction: THREE.AnimationAction | null = null
  /** 시선 타깃. 카메라 자식으로 붙여야 화면 좌표를 그대로 쓸 수 있다. */
  private readonly lookTarget = new THREE.Object3D()

  private readonly clips = new Map<string, THREE.AnimationClip>()

  /** 표정 가중치. 매 프레임 여기 값을 그대로 밀어 넣는다. */
  private emotion: Emotion = 'neutral'
  private emotionWeight = 1
  /** 이 모델이 실제로 들고 있는 프리셋. 없는 이름에 setValue 하면 조용히 무시된다. */
  private available = new Set<string>()
  private readonly warned = new Set<string>()
  private viseme: Viseme = 'sil'
  private visemeWeight = 0

  private blinkTimer = 0
  private nextBlinkAt = 2 + Math.random() * 3
  private elapsed = 0

  private pointer: { x: number; y: number } | null = null
  private readonly pixel = new Uint8Array(4)

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      // alpha:true 여야 clearAlpha 가 0 이 된다. 없으면 검은 사각형이 뜬다.
      alpha: true,
      antialias: true,
      // 렌더 직후 같은 프레임에서 readPixels 하므로 버퍼 보존은 불필요하다.
      preserveDrawingBuffer: false,
      // three 기본값은 true 인데, 컴포지터가 가장자리 픽셀을 되돌리는 방식과 어긋나면
      // 실루엣 둘레에 어두운 테두리가 생긴다. 오버레이에서는 false 가 안전하다.
      premultipliedAlpha: false
    })
    this.renderer.setClearAlpha(0)
    this.renderer.setPixelRatio(window.devicePixelRatio)
    // 배경에 Color/Texture 를 넣는 순간 창이 불투명해진다. null 을 유지한다.
    this.scene.background = null

    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 20)
    this.camera.position.set(0, 1.32, 2.1)
    this.camera.lookAt(0, 1.28, 0)
    // 시선 타깃을 카메라 자식으로 두면 커서 위치를 카메라 로컬 좌표로 바로 옮길 수 있다.
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

    // 최적화. 인자 타입이 서로 달라 헷갈리기 쉽다 —
    // combineSkeletons/removeUnnecessaryVertices 는 Object3D, combineMorphs 는 VRM 을 받는다.
    // (removeUnnecessaryJoints 는 3.x 에서 deprecated 이고 combineSkeletons 가 대체다.)
    VRMUtils.removeUnnecessaryVertices(gltf.scene)
    VRMUtils.combineSkeletons(gltf.scene)
    VRMUtils.combineMorphs(vrm)
    // VRM 0.x 는 뒤를 보고 서 있다. metaVersion 이 '0' 일 때만 동작하므로 무조건 불러도 된다.
    VRMUtils.rotateVRM0(vrm)

    // VRMA 의 시선 트랙이 동작하려면 프록시가 vrm.scene 의 **직속 자식**이고 이름이 비어 있지 않아야 한다.
    // (createVRMAnimationClip 이 children.find 로 얕게만 찾는다.) 미리 달아두면 경고도 안 뜬다.
    if (vrm.lookAt) {
      const proxy = new VRMLookAtQuaternionProxy(vrm.lookAt)
      proxy.name = 'VRMLookAtQuaternionProxy'
      vrm.scene.add(proxy)
    }

    vrm.scene.traverse((o) => {
      o.frustumCulled = false
    })

    this.scene.add(vrm.scene)
    this.vrm = vrm
    // 믹서는 반드시 vrm.scene 에 뿌리내려야 한다. 클립 트랙 이름이 `Normalized_<bone>.quaternion`
    // 인데 그 노드들이 vrm.scene 아래에 있기 때문이다. 최상위 Scene 에 걸면 조용히 아무 일도 안 한다.
    this.mixer = new THREE.AnimationMixer(vrm.scene)

    if (vrm.lookAt) vrm.lookAt.target = this.lookTarget

    // presetExpressionMap 은 Map 이 아니라 `{ [preset]?: VRMExpression }` 형태의 평범한 객체다.
    // 값이 undefined 인 키도 들어 있으므로 걸러야 실제로 가진 표정만 남는다.
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

    // VRMA 의 시선 트랙과 살아 있는 lookAt.target 이 서로 덮어쓴다.
    // 클립이 도는 동안에는 자동 추적을 끈다.
    if (this.vrm?.lookAt) this.vrm.lookAt.autoUpdate = false
    return true
  }

  stopMotion(): void {
    this.currentAction?.fadeOut(0.3)
    this.currentAction = null
    if (this.vrm?.lookAt) this.vrm.lookAt.autoUpdate = true
  }

  setEmotion(emotion: Emotion, weight = 1): void {
    this.emotion = emotion
    this.emotionWeight = Math.max(0, Math.min(1, weight))
  }

  setViseme(viseme: Viseme, weight: number): void {
    this.viseme = viseme
    this.visemeWeight = Math.max(0, Math.min(1, weight))
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
  }

  render(): { pointerOverAvatar: boolean } {
    const delta = this.clock.getDelta()
    this.elapsed += delta

    this.updateLookTarget()

    // 순서가 중요하다. vrm.update 안의 humanoid.update() 가 정규화 본을 실제 본으로 복사하므로,
    // 그 뒤에 정규화 본을 건드리면 그 프레임에서는 조용히 버려진다.
    //   1) 믹서(VRMA)  2) 절차적 보정  3) vrm.update  4) render
    this.mixer?.update(delta)
    this.applyIdleMotion()
    this.applyExpressions(delta)
    this.vrm?.update(delta)

    this.renderer.render(this.scene, this.camera)

    return { pointerOverAvatar: this.pointer ? this.readAlphaAt(this.pointer) : false }
  }

  /** 커서를 카메라 로컬 좌표의 한 점으로 옮겨 시선이 따라오게 한다. */
  private updateLookTarget(): void {
    if (!this.pointer) return
    const w = this.canvas.clientWidth
    const h = this.canvas.clientHeight
    if (w === 0 || h === 0) return
    const nx = (this.pointer.x / w) * 2 - 1
    const ny = -((this.pointer.y / h) * 2 - 1)
    // 카메라 앞 1.5m 지점. 눈이 화면 밖까지 돌아가지 않도록 범위를 좁게 잡는다.
    this.lookTarget.position.set(nx * 0.7, ny * 0.5, -1.5)
  }

  /**
   * 숨쉬기 + 미세한 상체 흔들림.
   *
   * 정규화 본은 rest 회전이 항등이라 같은 값이 모든 모델에서 같은 의미를 갖는다.
   * (raw 본은 모델마다 rest 방향이 달라 같은 값이 다르게 뒤틀린다.)
   *
   * 주의: VRMA 가 재생 중이면 여기서 rotation 을 **대입**하는 순간 믹서 결과를 덮어쓴다.
   * 그래서 클립이 도는 동안에는 건너뛴다.
   */
  private applyIdleMotion(): void {
    const humanoid = this.vrm?.humanoid
    if (!humanoid || this.currentAction) return

    const breathe = Math.sin(this.elapsed * 1.1) * 0.012
    const sway = Math.sin(this.elapsed * 0.43) * 0.02

    const spine = humanoid.getNormalizedBoneNode('spine')
    if (spine) {
      spine.rotation.x = breathe
      spine.rotation.z = sway * 0.5
    }
    const chest = humanoid.getNormalizedBoneNode('chest')
    if (chest) chest.rotation.x = breathe * 0.6
    const head = humanoid.getNormalizedBoneNode('head')
    if (head) head.rotation.z = -sway * 0.6
  }

  private applyExpressions(delta: number): void {
    // expressionManager 는 optional 이다. 표정을 안 가진 VRM 도 정상적인 모델이다.
    const em = this.vrm?.expressionManager
    if (!em) return

    // 모델이 안 가진 표정을 요청하면 setValue 가 조용히 무시되어 무표정으로 굳는다.
    // (예: AvatarSample_A 에는 surprised 가 없다.) 한 번만 알리고 neutral 로 떨어뜨린다.
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
        // 0 -> 1 -> 0 삼각파
        blink = t < 0.5 ? t * 2 : (1 - t) * 2
      }
    }
    em.setValue('blink', blink)
  }

  /**
   * 커서 아래 픽셀의 알파를 읽는다.
   *
   * 씬 전체가 하나의 <canvas> 라 document.elementFromPoint 는 항상 캔버스를 돌려준다 —
   * 실루엣 판정에 쓸 수 없다.
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
    // 클릭이 전달되지 않으므로, 커서가 실루엣에 닿기 전에 전환이 끝나 있어야 첫 클릭을 잃지 않는다.
    return (this.pixel[3] ?? 0) > 8
  }

  private disposeVrm(): void {
    if (!this.vrm) return
    this.scene.remove(this.vrm.scene)
    VRMUtils.deepDispose(this.vrm.scene)
    this.vrm = null
    this.mixer = null
    this.currentAction = null
    this.clips.clear()
  }

  dispose(): void {
    this.disposeVrm()
    this.renderer.dispose()
  }
}
