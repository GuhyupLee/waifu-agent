import * as THREE from 'three'
import type { VRMHumanoid } from '@pixiv/three-vrm'
import { breathCurve, drift } from './liveliness'

/**
 * VRM 의 rest pose 는 T 포즈다. 모션이 하나도 없으면 팔을 벌린 채로 서 있게 되므로,
 * VRMA 가 없을 때를 위한 절차적 기본 자세가 필요하다.
 *
 * 정규화 본을 쓰는 이유: rest 회전이 항등이라 같은 값이 모든 모델에서 같은 의미를 갖는다.
 * raw 본은 모델마다 rest 방향이 제각각이라 같은 각도가 다르게 뒤틀린다.
 *
 * 좌표계는 Y 위, 캐릭터 왼팔이 +X 방향이다. +Z 축 회전은 +X 를 +Y 로 보내므로,
 * 왼팔을 내리려면 음수, 오른팔(-X)을 내리려면 양수를 준다.
 */

/** T 포즈에서 팔을 내린 정도(라디안). 1.25 ≈ 72도. */
const ARM_DOWN = 1.25
const ELBOW_BEND = 0.12
const ARM_FORWARD = 0.08

export interface IdlePoseInput {
  /** 감쇠를 거친 머리 좌우 각(라디안). */
  yaw: number
  /** 감쇠를 거친 머리 상하 각(라디안). */
  pitch: number
}

/**
 * 기본 자세 + 숨쉬기 + 머리 추적을 한 번에 적용한다.
 *
 * `vrm.update(delta)` **전에** 불러야 한다. vrm.update 안의 humanoid.update() 가
 * 정규화 본을 실제 본으로 복사하므로, 그 뒤에 쓴 값은 그 프레임에서 조용히 버려진다.
 *
 * VRMA 가 재생 중일 때는 호출하지 마라 — 여기서 rotation 을 대입하는 순간
 * 믹서가 쓴 값을 덮어쓴다.
 */
export function applyIdlePose(humanoid: VRMHumanoid, input: IdlePoseInput): void {
  const { yaw, pitch } = input

  // 팔은 z 축 회전이 주축이다. 왼팔(+X)은 음수, 오른팔(-X)은 양수로 내려간다.
  setRot(humanoid, 'leftUpperArm', 0, ARM_FORWARD, -ARM_DOWN)
  setRot(humanoid, 'rightUpperArm', 0, -ARM_FORWARD, ARM_DOWN)
  setRot(humanoid, 'leftLowerArm', 0, -ELBOW_BEND, 0)
  setRot(humanoid, 'rightLowerArm', 0, ELBOW_BEND, 0)

  // 목과 머리에 나눠 준다. 목이 먼저 조금 돌고 머리가 더 크게 도는 편이 자연스럽다.
  // 눈은 vrm.lookAt 이 나머지를 채운다 — 머리가 이미 돌아간 만큼 눈은 덜 돌아간다.
  setRot(humanoid, 'neck', pitch * 0.35, yaw * 0.35, 0)
  setRot(humanoid, 'head', pitch * 0.65, yaw * 0.65, 0)
  // 숨쉬기와 표류는 applyLivelinessOverlay 가 얹는다. 여기서 또 넣으면 두 번 들어간다.
}

/** 안정 호흡 한 번에 걸리는 시간(초). 분당 약 14회. */
const BREATH_PERIOD = 4.2

export interface OverlayInput {
  elapsed: number
  /**
   * 0..1. VRMA 가 크게 움직이는 동안에는 낮춰 저작된 동작을 방해하지 않는다.
   * 반대로 서 있는 동안에는 1 로 둬야 정지 화면이 되지 않는다.
   */
  weight: number
  /** 감쇠를 거친 머리 좌우 각. VRMA 위에 부분적으로만 얹는다. */
  yaw: number
  /** 감쇠를 거친 머리 상하 각. */
  pitch: number
  /** VRMA 가 재생 중인가. 재생 중이면 머리 추적을 훨씬 약하게 얹는다. */
  motionPlaying: boolean
}

/**
 * 숨쉬기·표류·머리 추적을 **더한다**.
 *
 * 대입이 아니라 곱셈(쿼터니언 누적)인 것이 핵심이다. `rotation.set` 을 쓰면 믹서가
 * 쓴 VRMA 가 그 프레임에서 사라진다. 그래서 지금까지는 클립이 하나라도 돌면
 * 숨쉬기를 통째로 껐고, 결과적으로 **모션 중에는 호흡이 멈춘 캐릭터**가 됐다.
 * 사람은 걸으면서도 숨을 쉰다. 이게 인형처럼 보이는 가장 큰 이유였다.
 *
 * `vrm.update(delta)` **전에**, 믹서 갱신 **후에** 불러야 한다.
 */
export function applyLivelinessOverlay(humanoid: VRMHumanoid, input: OverlayInput): void {
  const { elapsed, weight, yaw, pitch, motionPlaying } = input

  // weight 가 0 이어도 빠져나가지 않는다. 지난 프레임에 얹은 오프셋을 걷어내는 것도
  // addRot 의 일이라, 여기서 건너뛰면 마지막 자세가 그대로 굳는다.

  // 0..1 을 -0.5..0.5 로 옮겨 중립 자세를 기준으로 부풀렸다 꺼지게 한다.
  const breath = (breathCurve(elapsed / BREATH_PERIOD) - 0.5) * weight
  // 사인 하나로 흔들면 메트로놈이 된다. 서로 안 나누어떨어지는 신호를 겹친다.
  const swayZ = drift(elapsed * 0.31, 3) * 0.016 * weight
  const swayX = drift(elapsed * 0.24, 7) * 0.010 * weight

  addRot(humanoid, 'spine', breath * 0.020 + swayX * 0.4, swayX * 0.5, swayZ * 0.5)
  addRot(humanoid, 'chest', breath * 0.014, 0, swayZ * 0.3)
  // 들이쉬면 어깨가 조금 올라간다. 가슴만 움직이면 풍선처럼 보인다.
  addRot(humanoid, 'leftShoulder', 0, 0, -breath * 0.030)
  addRot(humanoid, 'rightShoulder', 0, 0, breath * 0.030)

  // 저작된 모션이 이미 고개를 쓰고 있을 수 있으므로 크게 얹지 않는다.
  // 그래도 0 으로 두면 모션 중에는 커서를 완전히 무시해서 남처럼 보인다.
  // 모션이 없을 때는 applyIdlePose 가 이미 전량을 넣었으므로 여기서는 0 이다.
  const track = motionPlaying ? 0.35 * weight : 0
  addRot(humanoid, 'neck', pitch * 0.35 * track, yaw * 0.35 * track, 0)
  addRot(humanoid, 'head', pitch * 0.5 * track, yaw * 0.5 * track, -swayZ * 0.6)
}

type BoneName = Parameters<VRMHumanoid['getNormalizedBoneNode']>[0]

function setRot(humanoid: VRMHumanoid, name: BoneName, x: number, y: number, z: number): void {
  const bone = humanoid.getNormalizedBoneNode(name)
  if (bone) bone.rotation.set(x, y, z)
}

// 매 프레임 본마다 새로 만들면 초당 수백 개가 GC 로 간다.
const scratchEuler = new THREE.Euler()
const scratchQuat = new THREE.Quaternion()

interface OverlayState {
  /** 오버레이를 얹기 **전** 값. 믹서가 이 본을 안 건드렸을 때 여기로 되돌린다. */
  base: THREE.Quaternion
  /** 지난 프레임에 우리가 남긴 값. 그대로면 아무도 덮어쓰지 않았다는 뜻이다. */
  applied: THREE.Quaternion
}

/** 모델을 바꾸면 본 노드째로 사라지므로 WeakMap 이 알아서 비운다. */
const overlayState = new WeakMap<THREE.Object3D, OverlayState>()

/**
 * 오버레이 회전을 얹는다.
 *
 * 그냥 `quaternion.multiply` 만 하면 안 된다. `VRMHumanoid.update()` 는 정규화 본을
 * 읽어 raw 본에 쓸 뿐 **정규화 본을 초기화하지 않는다.** 그래서 믹서가 트랙을 갖고
 * 있지 않은 본(어깨는 VRMA 에 트랙이 없는 경우가 흔하다)에서는 우리 오프셋이
 * 매 프레임 누적되어 몇 초 만에 몸이 접힌다.
 *
 * 그래서 지난 프레임에 남긴 값이 그대로면 먼저 걷어내고 새로 얹는다.
 * 값이 달라졌다면 믹서(또는 applyIdlePose)가 덮어쓴 것이므로 그것을 기준으로 삼는다.
 */
function addRot(humanoid: VRMHumanoid, name: BoneName, x: number, y: number, z: number): void {
  const bone = humanoid.getNormalizedBoneNode(name)
  if (!bone) return

  let state = overlayState.get(bone)
  if (!state) {
    state = { base: new THREE.Quaternion(), applied: new THREE.Quaternion(-2, 0, 0, 0) }
    overlayState.set(bone, state)
  } else if (bone.quaternion.equals(state.applied)) {
    bone.quaternion.copy(state.base)
  }

  state.base.copy(bone.quaternion)
  bone.quaternion.multiply(scratchQuat.setFromEuler(scratchEuler.set(x, y, z)))
  state.applied.copy(bone.quaternion)
}

/**
 * 프레임레이트에 무관한 지수 감쇠.
 *
 * `current + (target - current) * rate` 를 그냥 쓰면 60fps 와 30fps 에서 반응 속도가 달라진다.
 * delta 를 지수에 넣어야 어느 프레임레이트에서도 같은 시간 상수를 갖는다.
 *
 * @param stiffness 클수록 빨리 따라간다. 8 정도면 머리 추적에 자연스럽다.
 */
export function damp(current: number, target: number, stiffness: number, delta: number): number {
  return current + (target - current) * (1 - Math.exp(-stiffness * delta))
}

/** 마우스를 화면 끝까지 던져도 목이 꺾이지 않도록 각도를 제한한다. */
export function clampAngle(v: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, v))
}

/** 드래그 축소 범위. 어떤 위치에서 잡아도 전신이 들어오되 너무 작아지지 않는 구간. */
export const DRAG_ZOOM_MIN = 0.45
export const DRAG_ZOOM_MAX = 0.65
/**
 * 손 아래로 매달린 몸을 캔버스 높이의 이 배수로 본다. 1 이면 캔버스만큼 길다고
 * 가정하는 셈이라 실제보다 조금 크게 잡는다 — 살짝 과하게 축소해 잘리지 않는 쪽으로 기운다.
 */
const DRAG_BODY_SPAN_Y = 1
/** 손 오른쪽으로 뻗는 몸 폭을 캔버스 폭의 이 배수로 본다. 세로보다 좁아 앵커가 끝에 붙을 때만 제약이 된다. */
const DRAG_BODY_SPAN_X = 0.6
/** 알파 실루엣과 흔들리는 옷·머리카락도 끝에 붙지 않도록 15% 안전 여백을 둔다. */
const DRAG_FIT_SAFETY = 0.85

export interface DragZoomInput {
  canvasWidth: number
  canvasHeight: number
  /** 손이 고정될 커서 위치(캔버스 좌상단 기준 CSS px). */
  anchorX: number
  anchorY: number
}

/**
 * 드래그로 오른손을 커서에 고정하면 몸이 그 지점에서 아래·오른쪽으로 뻗어
 * 좁은 오버레이 창 밖으로 잘린다. 카메라를 다시 맞추는(fitCamera) 대신 드래그 동안만
 * `camera.zoom` 을 줄여(=축소) 전신이 들어오게 한다.
 *
 * 커서가 캔버스에서 얼마나 내려오고 오른쪽으로 치우쳤는지로 필요한 축소율을 잡는다.
 * 손 위·왼쪽에는 몸이 거의 없으므로 몸이 실제로 뻗는 두 방향(아래, tether 방향=오른쪽)만 본다.
 * 값이 작을수록 더 축소한다. 결과는 [DRAG_ZOOM_MIN, DRAG_ZOOM_MAX] 로 눌러
 * 어떤 위치에서도 몸이 지나치게 작아지지도, 여전히 잘리지도 않게 한다.
 */
export function dragZoomTarget(input: DragZoomInput): number {
  const { canvasWidth, canvasHeight, anchorX, anchorY } = input
  if (canvasWidth <= 0 || canvasHeight <= 0) return DRAG_ZOOM_MAX
  // 앵커 아래 남은 공간에 캔버스 높이만큼 긴 몸을 담으려면 그 비율만큼 축소한다.
  const belowFit = Math.max(0, canvasHeight - anchorY) / (canvasHeight * DRAG_BODY_SPAN_Y)
  // 오른쪽으로 남은 공간에 몸 폭을 담는다. 앵커가 오른쪽 끝에 붙을수록 더 축소.
  const rightFit = Math.max(0, canvasWidth - anchorX) / (canvasWidth * DRAG_BODY_SPAN_X)
  const fit = Math.min(belowFit, rightFit) * DRAG_FIT_SAFETY
  return Math.max(DRAG_ZOOM_MIN, Math.min(DRAG_ZOOM_MAX, fit))
}

/** 모델 전체가 화면에 들어오도록 카메라를 맞춘다. 모델마다 키가 달라 고정값을 쓸 수 없다. */
export function fitCameraToObject(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  aspect: number,
  margin = 1.08
): void {
  const box = new THREE.Box3().setFromObject(object)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())

  const vFov = (camera.fov * Math.PI) / 180
  const distForHeight = (size.y * margin) / (2 * Math.tan(vFov / 2))
  // 창이 세로로 길면 높이가, 가로로 넓으면 폭이 제약이 된다. 둘 중 먼 쪽을 쓴다.
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect)
  const distForWidth = (size.x * margin) / (2 * Math.tan(hFov / 2))

  const dist = Math.max(distForHeight, distForWidth)
  camera.position.set(center.x, center.y, center.z + dist)
  camera.lookAt(center)
  camera.near = Math.max(0.01, dist - size.length())
  camera.far = dist + size.length() * 2
  camera.updateProjectionMatrix()
}
