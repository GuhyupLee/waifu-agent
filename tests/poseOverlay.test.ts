import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { VRMHumanoid } from '@pixiv/three-vrm'
import { applyIdlePose, applyLivelinessOverlay } from '../src/renderer/avatar/pose'

/**
 * 최소 humanoid 흉내.
 *
 * 실제 VRM 을 띄우지 않고도 오버레이의 누적 여부를 볼 수 있다. 이 테스트가 잡는 것은
 * "정규화 본을 아무도 초기화해 주지 않을 때 곱셈 오버레이가 매 프레임 쌓이는" 문제다.
 * VRMHumanoid.update() 는 정규화 본을 읽어 raw 에 쓸 뿐 되돌리지 않으므로,
 * VRMA 에 트랙이 없는 본(어깨가 대표적)에서 실제로 일어난다.
 */
function fakeHumanoid(names: string[]): {
  humanoid: VRMHumanoid
  bones: Map<string, THREE.Object3D>
} {
  const bones = new Map<string, THREE.Object3D>()
  for (const n of names) bones.set(n, new THREE.Object3D())
  const humanoid = {
    getNormalizedBoneNode: (name: string) => bones.get(name) ?? null
  } as unknown as VRMHumanoid
  return { humanoid, bones }
}

const OVERLAY_BONES = [
  'spine',
  'chest',
  'leftShoulder',
  'rightShoulder',
  'neck',
  'head',
  'leftUpperArm',
  'rightUpperArm',
  'leftLowerArm',
  'rightLowerArm'
]

/** 쿼터니언이 나타내는 회전각(라디안). */
function angleOf(q: THREE.Quaternion): number {
  return 2 * Math.acos(Math.min(1, Math.abs(q.w)))
}

describe('applyLivelinessOverlay', () => {
  it('믹서가 본을 건드리지 않아도 회전이 누적되지 않는다', () => {
    // 이게 이 파일의 존재 이유다. 되돌리기가 없으면 어깨가 몇 초 만에 한 바퀴 돈다.
    const { humanoid, bones } = fakeHumanoid(OVERLAY_BONES)

    for (let i = 0; i < 60 * 60; i++) {
      applyLivelinessOverlay(humanoid, {
        elapsed: i / 60,
        weight: 1,
        yaw: 0.2,
        pitch: 0.1,
        motionPlaying: true
      })
    }

    for (const [name, bone] of bones) {
      expect(angleOf(bone.quaternion), `${name} 이 누적됐다`).toBeLessThan(0.35)
    }
  })

  it('믹서가 매 프레임 덮어쓰는 본은 그 값을 기준으로 얹는다', () => {
    const { humanoid, bones } = fakeHumanoid(OVERLAY_BONES)
    const authored = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, 0, 0))
    const spine = bones.get('spine')!

    for (let i = 0; i < 600; i++) {
      // 믹서가 하는 일: 절대값 대입
      spine.quaternion.copy(authored)
      applyLivelinessOverlay(humanoid, {
        elapsed: i / 60,
        weight: 1,
        yaw: 0,
        pitch: 0,
        motionPlaying: true
      })
    }

    // 저작된 0.4 근처에 머물러야 한다. 덮어쓰면 0 으로, 누적되면 발산한다.
    expect(angleOf(spine.quaternion)).toBeGreaterThan(0.3)
    expect(angleOf(spine.quaternion)).toBeLessThan(0.5)
  })

  it('applyIdlePose 가 쓴 절대값을 지우지 않는다', () => {
    const { humanoid, bones } = fakeHumanoid(OVERLAY_BONES)

    for (let i = 0; i < 600; i++) {
      applyIdlePose(humanoid, { yaw: 0.4, pitch: 0.2 })
      applyLivelinessOverlay(humanoid, {
        elapsed: i / 60,
        weight: 1,
        yaw: 0.4,
        pitch: 0.2,
        motionPlaying: false
      })
    }

    // 모션이 없으면 applyIdlePose 가 머리 추적 전량을 넣는다. 0.4 × 0.65 ≈ 0.26
    const head = bones.get('head')!
    const e = new THREE.Euler().setFromQuaternion(head.quaternion)
    expect(e.y).toBeCloseTo(0.26, 1)
    // 팔은 오버레이가 건드리지 않으므로 T 포즈가 풀린 채로 유지된다.
    expect(angleOf(bones.get('leftUpperArm')!.quaternion)).toBeGreaterThan(1)
  })

  it('weight 가 0 이면 얹었던 것을 걷어낸다', () => {
    // 여기서 그냥 return 해버리면 마지막 프레임 자세로 굳는다.
    const { humanoid, bones } = fakeHumanoid(OVERLAY_BONES)
    const base = { elapsed: 3, yaw: 0, pitch: 0, motionPlaying: true }

    applyLivelinessOverlay(humanoid, { ...base, weight: 1 })
    const moved = angleOf(bones.get('chest')!.quaternion)
    expect(moved).toBeGreaterThan(1e-4)

    applyLivelinessOverlay(humanoid, { ...base, weight: 0 })
    expect(angleOf(bones.get('chest')!.quaternion)).toBeLessThan(1e-6)
  })

  it('없는 본은 조용히 건너뛴다', () => {
    // 어깨가 없는 VRM 도 정상적인 모델이다.
    const { humanoid } = fakeHumanoid(['spine', 'head'])
    expect(() =>
      applyLivelinessOverlay(humanoid, {
        elapsed: 1,
        weight: 1,
        yaw: 0,
        pitch: 0,
        motionPlaying: true
      })
    ).not.toThrow()
  })

  it('숨쉬기가 실제로 움직인다', () => {
    // 누적을 막다가 아예 아무것도 안 하게 되면 고친 게 아니다.
    const { humanoid, bones } = fakeHumanoid(OVERLAY_BONES)
    const chest = bones.get('chest')!
    const seen: number[] = []

    for (let i = 0; i < 60 * 6; i++) {
      applyLivelinessOverlay(humanoid, {
        elapsed: i / 60,
        weight: 1,
        yaw: 0,
        pitch: 0,
        motionPlaying: true
      })
      seen.push(new THREE.Euler().setFromQuaternion(chest.quaternion).x)
    }

    expect(Math.max(...seen) - Math.min(...seen)).toBeGreaterThan(0.005)
  })
})
