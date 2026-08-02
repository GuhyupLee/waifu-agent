import type { Emotion } from '@shared/protocol'

/**
 * 몸을 만지면 반응한다.
 *
 * 3D 콜라이더나 레이캐스트를 쓰지 않는다. 본의 월드 좌표를 화면에 투영해서 커서와의
 * **화면상 거리**만 본다. 리그가 어떻게 생겼든 똑같이 동작하고, 매 프레임 레이캐스트를
 * 돌리는 것보다 훨씬 싸다.
 *
 * 쓰다듬기는 단순히 "위에 있다" 가 아니라 **원을 그리는 동작**이어야 인정한다.
 * 그냥 커서가 머리 위를 지나가는 것과 구분하려는 것이다 — 안 그러면 창을 옮기려고
 * 마우스를 움직일 때마다 아바타가 좋아한다.
 */

export type TouchKind = 'pat' | 'poke'

export interface TouchRegion {
  /** VRM 휴머노이드 본 이름. */
  bone: string
  kind: TouchKind
  /** 창 높이에 대한 비율. 창 크기가 바뀌어도 체감이 같도록. */
  radiusRatio: number
  emotion: Emotion
  /** 반응 모션 후보. 있는 것 중에서 고른다. */
  motions: readonly string[]
  /** 같은 부위가 연달아 반응하지 않도록 하는 간격. */
  cooldownMs: number
}

/**
 * 어디를 만지면 무엇이 나오는지.
 *
 * 머리와 손만 둔다. 다른 부위까지 반응을 붙이면 만질 곳을 찾는 게임이 되는데,
 * 이 앱은 그런 물건이 아니다.
 */
export const TOUCH_REGIONS: readonly TouchRegion[] = [
  {
    bone: 'head',
    kind: 'pat',
    radiusRatio: 0.13,
    emotion: 'happy',
    motions: ['blush', 'giggle', 'happy-bounce', 'idle-shy'],
    cooldownMs: 3500
  },
  {
    bone: 'rightHand',
    kind: 'poke',
    radiusRatio: 0.07,
    emotion: 'surprised',
    motions: ['curious-head-tilt', 'idle-curious'],
    cooldownMs: 5000
  },
  {
    bone: 'leftHand',
    kind: 'poke',
    radiusRatio: 0.07,
    emotion: 'surprised',
    motions: ['curious-head-tilt', 'idle-curious'],
    cooldownMs: 5000
  }
]

export interface PatConfig {
  /** 이만큼 돌아야 한 번 인정한다(라디안). 2π 면 정확히 한 바퀴. */
  threshold: number
  /** 이 시간 동안 각도 변화가 없으면 누적을 버린다. */
  idleResetMs: number
}

export const DEFAULT_PAT: PatConfig = {
  // 한 바퀴를 다 돌게 하면 답답하다. 3/4 바퀴 정도가 "쓰다듬었다" 는 느낌과 맞는다.
  threshold: Math.PI * 1.5,
  idleResetMs: 400
}

/**
 * 커서가 한 점 주위를 도는 정도를 누적한다.
 *
 * 각도의 **변화량 절댓값**을 더한다. 왕복으로 문질러도 인정되고, 직선으로 지나가면
 * 각도 변화가 작아서 인정되지 않는다.
 */
export class PatDetector {
  private lastAngle: number | null = null
  private accumulated = 0
  private lastUpdateAt = 0

  constructor(private readonly config: PatConfig = DEFAULT_PAT) {}

  get progress(): number {
    return Math.min(1, this.accumulated / this.config.threshold)
  }

  /**
   * 영역 중심 기준 커서 각도를 넣는다.
   * @returns 이번에 쓰다듬기가 완성됐으면 true
   */
  update(angle: number, now: number): boolean {
    // 손을 멈추고 있으면 누적을 버린다. 안 그러면 며칠에 걸쳐 조금씩 모여도 발동한다.
    if (this.lastAngle !== null && now - this.lastUpdateAt > this.config.idleResetMs) {
      this.reset()
    }
    this.lastUpdateAt = now

    if (this.lastAngle === null) {
      this.lastAngle = angle
      return false
    }

    // atan2 는 ±π 에서 튄다. 그대로 빼면 한 바퀴가 갑자기 쌓인다.
    let delta = angle - this.lastAngle
    while (delta > Math.PI) delta -= Math.PI * 2
    while (delta < -Math.PI) delta += Math.PI * 2

    this.lastAngle = angle
    this.accumulated += Math.abs(delta)

    if (this.accumulated >= this.config.threshold) {
      this.reset()
      return true
    }
    return false
  }

  reset(): void {
    this.lastAngle = null
    this.accumulated = 0
  }
}

export interface TouchHit {
  region: TouchRegion
  /** 영역 중심 기준 커서 각도(라디안). 쓰다듬기 판정에 쓴다. */
  angle: number
  /** 중심으로부터의 거리를 반지름으로 나눈 값. 0 이 중심. */
  normalized: number
}

/**
 * 화면 좌표에서 어느 영역을 만지고 있는지 찾는다.
 *
 * 겹치면 **중심에 가까운 쪽**을 고른다. 머리와 손이 겹쳐 보일 때 둘 다 반응하면 어색하다.
 */
export function findTouchedRegion(
  cursor: { x: number; y: number },
  bonePositions: ReadonlyMap<string, { x: number; y: number }>,
  windowHeight: number,
  regions: readonly TouchRegion[] = TOUCH_REGIONS
): TouchHit | null {
  let best: TouchHit | null = null

  for (const region of regions) {
    const pos = bonePositions.get(region.bone)
    if (!pos) continue

    const radius = region.radiusRatio * windowHeight
    if (radius <= 0) continue

    const dx = cursor.x - pos.x
    const dy = cursor.y - pos.y
    const normalized = Math.hypot(dx, dy) / radius
    if (normalized > 1) continue

    if (!best || normalized < best.normalized) {
      best = { region, angle: Math.atan2(dy, dx), normalized }
    }
  }

  return best
}

/** 반응 모션을 고른다. 모델이 가진 것 중에서만. */
export function pickReactionMotion(
  region: TouchRegion,
  available: readonly string[],
  random: number
): string | null {
  const usable = region.motions.filter((m) => available.includes(m))
  if (usable.length === 0) return null
  return usable[Math.min(usable.length - 1, Math.floor(random * usable.length))]!
}
