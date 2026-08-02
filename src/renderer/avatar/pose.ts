import * as THREE from 'three'
import type { VRMHumanoid } from '@pixiv/three-vrm'

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
  /** 초 단위 누적 시간. 숨쉬기 위상에 쓴다. */
  elapsed: number
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
  const { elapsed, yaw, pitch } = input

  const breathe = Math.sin(elapsed * 1.1) * 0.012
  const sway = Math.sin(elapsed * 0.43) * 0.02

  // 팔은 z 축 회전이 주축이다. 왼팔(+X)은 음수, 오른팔(-X)은 양수로 내려간다.
  setRot(humanoid, 'leftUpperArm', 0, ARM_FORWARD, -ARM_DOWN)
  setRot(humanoid, 'rightUpperArm', 0, -ARM_FORWARD, ARM_DOWN)
  setRot(humanoid, 'leftLowerArm', 0, -ELBOW_BEND, 0)
  setRot(humanoid, 'rightLowerArm', 0, ELBOW_BEND, 0)

  setRot(humanoid, 'spine', breathe, 0, sway * 0.5)
  setRot(humanoid, 'chest', breathe * 0.6, 0, 0)

  // 목과 머리에 나눠 준다. 목이 먼저 조금 돌고 머리가 더 크게 도는 편이 자연스럽다.
  // 눈은 vrm.lookAt 이 나머지를 채운다 — 머리가 이미 돌아간 만큼 눈은 덜 돌아간다.
  setRot(humanoid, 'neck', pitch * 0.35, yaw * 0.35, -sway * 0.3)
  setRot(humanoid, 'head', pitch * 0.65, yaw * 0.65, -sway * 0.3)
}

type BoneName = Parameters<VRMHumanoid['getNormalizedBoneNode']>[0]

function setRot(humanoid: VRMHumanoid, name: BoneName, x: number, y: number, z: number): void {
  const bone = humanoid.getNormalizedBoneNode(name)
  if (bone) bone.rotation.set(x, y, z)
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
