import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PAT,
  PatDetector,
  TOUCH_REGIONS,
  findTouchedRegion,
  pickReactionMotion
} from '../src/renderer/avatar/touch'

/** 중심 주위를 도는 커서를 흉내낸다. */
function circle(detector: PatDetector, turns: number, steps = 64, startAt = 0): number {
  let fired = 0
  let t = startAt
  for (let i = 1; i <= steps * turns; i++) {
    t += 10
    if (detector.update((i / steps) * Math.PI * 2, t)) fired++
  }
  return fired
}

describe('PatDetector', () => {
  it('한 바퀴 조금 못 미쳐 발동한다', () => {
    // threshold 가 1.5π 라 3/4 바퀴에서 걸린다.
    const d = new PatDetector()
    expect(circle(d, 1)).toBe(1)
  })

  it('두 바퀴 돌리면 두 번 발동한다', () => {
    const d = new PatDetector()
    expect(circle(d, 2)).toBe(2)
  })

  it('직선으로 지나가는 것은 인정하지 않는다', () => {
    // 영역 위를 가로지르면 각도가 조금밖에 안 변한다. 창을 옮기려고 마우스를
    // 움직일 때마다 아바타가 좋아하면 곤란하다.
    const d = new PatDetector()
    let fired = false
    // -20도에서 +20도까지 훑고 지나가는 정도
    for (let i = 0; i <= 40; i++) {
      if (d.update(((i - 20) * Math.PI) / 180, i * 10)) fired = true
    }
    expect(fired).toBe(false)
  })

  it('±π 경계에서 한 바퀴가 갑자기 쌓이지 않는다', () => {
    // atan2 는 여기서 튄다. 그대로 빼면 아주 조금 움직여도 즉시 발동한다.
    const d = new PatDetector()
    expect(d.update(Math.PI - 0.01, 0)).toBe(false)
    expect(d.update(-Math.PI + 0.01, 10)).toBe(false)
    expect(d.progress).toBeLessThan(0.05)
  })

  it('손을 멈추면 누적이 사라진다', () => {
    const d = new PatDetector()
    d.update(0, 0)
    d.update(1, 10)
    expect(d.progress).toBeGreaterThan(0)
    // idleResetMs 를 넘겨 다시 들어오면 처음부터다.
    d.update(2, 10 + DEFAULT_PAT.idleResetMs + 1)
    expect(d.progress).toBe(0)
  })

  it('왕복으로 문질러도 인정된다', () => {
    // 각도 변화량의 절댓값을 더하므로 방향이 바뀌어도 쌓인다.
    const d = new PatDetector()
    let fired = false
    let t = 0
    for (let rep = 0; rep < 6; rep++) {
      for (const a of [0, 0.8, 0, -0.8]) {
        t += 10
        if (d.update(a, t)) fired = true
      }
    }
    expect(fired).toBe(true)
  })

  it('reset 후에는 진행도가 0 이다', () => {
    const d = new PatDetector()
    d.update(0, 0)
    d.update(1.2, 10)
    d.reset()
    expect(d.progress).toBe(0)
  })
})

describe('findTouchedRegion', () => {
  const bones = new Map([
    ['head', { x: 100, y: 100 }],
    ['rightHand', { x: 140, y: 200 }],
    ['leftHand', { x: 60, y: 200 }]
  ])
  const H = 400

  it('영역 안이면 찾는다', () => {
    const hit = findTouchedRegion({ x: 105, y: 105 }, bones, H)
    expect(hit?.region.bone).toBe('head')
  })

  it('영역 밖이면 null 이다', () => {
    expect(findTouchedRegion({ x: 300, y: 300 }, bones, H)).toBeNull()
  })

  it('본 좌표가 없으면 건너뛴다', () => {
    // 모델에 그 본이 없을 수 있다. 없는 걸 만졌다고 하면 안 된다.
    expect(findTouchedRegion({ x: 100, y: 100 }, new Map(), H)).toBeNull()
  })

  it('겹치면 중심에 가까운 쪽을 고른다', () => {
    // 머리와 손이 겹쳐 보일 때 둘 다 반응하면 어색하다.
    const overlapping = new Map([
      ['head', { x: 100, y: 100 }],
      ['rightHand', { x: 110, y: 100 }]
    ])
    const hit = findTouchedRegion({ x: 109, y: 100 }, overlapping, H)
    expect(hit?.region.bone).toBe('rightHand')
  })

  it('창이 작아지면 판정 반경도 같이 줄어든다', () => {
    // 비율로 잡아야 창 크기를 바꿔도 체감이 같다.
    const far = { x: 100, y: 145 }
    expect(findTouchedRegion(far, bones, 400)).not.toBeNull()
    expect(findTouchedRegion(far, bones, 200)).toBeNull()
  })

  it('중심에서의 각도를 준다', () => {
    const hit = findTouchedRegion({ x: 110, y: 100 }, bones, H)
    expect(hit!.angle).toBeCloseTo(0, 5)
  })

  it('창 높이가 0 이어도 죽지 않는다', () => {
    expect(findTouchedRegion({ x: 100, y: 100 }, bones, 0)).toBeNull()
  })
})

describe('pickReactionMotion', () => {
  const head = TOUCH_REGIONS.find((r) => r.bone === 'head')!

  it('모델이 가진 것 중에서만 고른다', () => {
    const m = pickReactionMotion(head, ['giggle', 'walk'], 0.5)
    expect(m).toBe('giggle')
  })

  it('가진 게 없으면 null 이다', () => {
    // 없는 모션을 부르면 아무 일도 안 일어난다. 그럴 바엔 표정만 바꾼다.
    expect(pickReactionMotion(head, ['walk'], 0)).toBeNull()
  })

  it('random 이 1 이어도 범위를 넘지 않는다', () => {
    const m = pickReactionMotion(head, ['blush', 'giggle'], 0.999999)
    expect(['blush', 'giggle']).toContain(m)
  })
})

describe('TOUCH_REGIONS 구성', () => {
  it('머리와 양손만 둔다', () => {
    // 다른 부위까지 반응을 붙이면 만질 곳을 찾는 게임이 된다.
    expect(TOUCH_REGIONS.map((r) => r.bone).sort()).toEqual(['head', 'leftHand', 'rightHand'])
  })

  it('머리만 쓰다듬기 판정을 쓴다', () => {
    expect(TOUCH_REGIONS.filter((r) => r.kind === 'pat').map((r) => r.bone)).toEqual(['head'])
  })

  it('모든 영역에 쿨다운이 있다', () => {
    // 없으면 커서를 올려둔 동안 반응이 쏟아진다.
    for (const r of TOUCH_REGIONS) expect(r.cooldownMs).toBeGreaterThan(0)
  })
})
