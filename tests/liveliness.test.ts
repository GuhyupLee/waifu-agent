import { describe, expect, it } from 'vitest'
import {
  BlinkModel,
  DEFAULT_BLINK,
  SaccadeModel,
  Spring,
  blinkDuration,
  blinkWeight,
  breathCurve,
  drift,
  loopVariation,
  nextBlinkInterval
} from '../src/renderer/avatar/liveliness'

/** 고정된 값을 순서대로 돌려주는 난수. 확률 분기를 결정적으로 만든다. */
function seq(values: number[]): () => number {
  let i = 0
  return () => values[i++ % values.length]!
}

describe('Spring', () => {
  it('목표에 수렴한다', () => {
    const s = new Spring(0)
    for (let i = 0; i < 300; i++) s.update(1, 1 / 60)
    expect(s.value).toBeCloseTo(1, 3)
    expect(s.velocity).toBeCloseTo(0, 2)
  })

  it('감쇠가 약하면 지나쳤다 돌아온다', () => {
    // 지수 감쇠로는 절대 나오지 않는 동작이다. 이게 스프링을 쓰는 이유다.
    const s = new Spring(0, 2.2, 0.45)
    let max = 0
    for (let i = 0; i < 120; i++) max = Math.max(max, s.update(1, 1 / 60))
    expect(max).toBeGreaterThan(1)
  })

  it('임계감쇠면 지나치지 않는다', () => {
    const s = new Spring(0, 2.2, 1)
    let max = 0
    for (let i = 0; i < 300; i++) max = Math.max(max, s.update(1, 1 / 60))
    expect(max).toBeLessThanOrEqual(1 + 1e-6)
  })

  it('프레임이 크게 튀어도 발산하지 않는다', () => {
    // 창을 끌거나 절전에서 깨어나면 delta 가 실제로 초 단위로 튄다.
    // 명시적 오일러였다면 여기서 폭발한다.
    const s = new Spring(0)
    for (let i = 0; i < 20; i++) s.update(1, 2)
    expect(Number.isFinite(s.value)).toBe(true)
    expect(Math.abs(s.value)).toBeLessThan(2)
  })

  it('delta 가 0 이면 아무 일도 없다', () => {
    const s = new Spring(0.3)
    expect(s.update(1, 0)).toBe(0.3)
  })

  it('snap 은 속도까지 버린다', () => {
    const s = new Spring(0)
    s.update(1, 1 / 60)
    s.snap(0.5)
    expect(s.value).toBe(0.5)
    expect(s.velocity).toBe(0)
  })

  it('프레임레이트가 달라도 비슷한 시간에 도달한다', () => {
    const fast = new Spring(0)
    const slow = new Spring(0)
    for (let i = 0; i < 60; i++) fast.update(1, 1 / 60)
    for (let i = 0; i < 15; i++) slow.update(1, 1 / 15)
    expect(Math.abs(fast.value - slow.value)).toBeLessThan(0.12)
  })
})

describe('drift', () => {
  it('범위를 크게 벗어나지 않는다', () => {
    for (let t = 0; t < 200; t += 0.07) expect(Math.abs(drift(t))).toBeLessThanOrEqual(1.2)
  })

  it('짧은 주기로 반복하지 않는다', () => {
    // 사인 하나면 여기서 값이 같아진다. 그게 눈에 보이는 이유다.
    const a = drift(1)
    expect(Math.abs(drift(1 + Math.PI * 2) - a)).toBeGreaterThan(0.05)
  })

  it('seed 가 다르면 다른 신호다', () => {
    expect(Math.abs(drift(3, 0) - drift(3, 1))).toBeGreaterThan(0.05)
  })

  it('연속이다', () => {
    for (let t = 0; t < 20; t += 0.1) {
      expect(Math.abs(drift(t + 0.01) - drift(t))).toBeLessThan(0.1)
    }
  })
})

describe('breathCurve', () => {
  it('0..1 안에 있다', () => {
    for (let p = 0; p < 3; p += 0.013) {
      const v = breathCurve(p)
      expect(v).toBeGreaterThanOrEqual(-1e-9)
      expect(v).toBeLessThanOrEqual(1 + 1e-9)
    }
  })

  it('들숨이 날숨보다 짧다', () => {
    // 사인파는 5:5 라 기계로 부풀리는 느낌이 난다.
    let peak = 0
    let peakAt = 0
    for (let p = 0; p < 1; p += 0.001) {
      const v = breathCurve(p)
      if (v > peak) {
        peak = v
        peakAt = p
      }
    }
    expect(peakAt).toBeLessThan(0.5)
    expect(peak).toBeCloseTo(1, 2)
  })

  it('주기 경계에서 이어진다', () => {
    expect(breathCurve(0.9999)).toBeCloseTo(breathCurve(0), 2)
  })

  it('반복된다', () => {
    expect(breathCurve(0.3)).toBeCloseTo(breathCurve(5.3), 10)
  })
})

describe('blinkWeight', () => {
  it('감기가 뜨기보다 빠르다', () => {
    // 대칭 삼각형으로 만들면 눈이 아니라 셔터로 보인다.
    expect(DEFAULT_BLINK.closeSec).toBeLessThan(DEFAULT_BLINK.openSec)
    expect(blinkWeight(DEFAULT_BLINK.closeSec * 0.5)).toBeLessThan(
      1 - blinkWeight(blinkDuration() - DEFAULT_BLINK.openSec * 0.5)
    )
  })

  it('완전히 감기고 완전히 뜬다', () => {
    expect(blinkWeight(0)).toBe(0)
    expect(blinkWeight(DEFAULT_BLINK.closeSec)).toBeCloseTo(1, 6)
    expect(blinkWeight(blinkDuration())).toBe(0)
  })

  it('끝난 뒤에는 0 이다', () => {
    expect(blinkWeight(blinkDuration() + 1)).toBe(0)
    expect(blinkWeight(-1)).toBe(0)
  })

  it('0..1 을 벗어나지 않는다', () => {
    for (let t = 0; t < 0.5; t += 0.001) {
      const w = blinkWeight(t)
      expect(w).toBeGreaterThanOrEqual(0)
      expect(w).toBeLessThanOrEqual(1)
    }
  })

  it('한 번의 깜빡임이 0.3초를 넘지 않는다', () => {
    expect(blinkDuration()).toBeLessThan(0.3)
  })
})

describe('nextBlinkInterval', () => {
  it('최소 간격 아래로 내려가지 않는다', () => {
    expect(nextBlinkInterval(0)).toBeGreaterThanOrEqual(1.1)
  })

  it('짧은 간격이 긴 간격보다 흔하다', () => {
    // 지수분포의 요점이다. 균등분포면 "규칙적으로 깜빡인다" 는 인상이 남는다.
    const samples: number[] = []
    for (let i = 1; i < 1000; i++) samples.push(nextBlinkInterval(i / 1000))
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length
    const median = samples.slice().sort((a, b) => a - b)[Math.floor(samples.length / 2)]!
    expect(median).toBeLessThan(mean)
  })

  it('평균이 사람 값 근처다', () => {
    const samples: number[] = []
    for (let i = 1; i < 10000; i++) samples.push(nextBlinkInterval(i / 10000))
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length
    // 분당 17회 ≈ 3.5초
    expect(mean).toBeGreaterThan(2.5)
    expect(mean).toBeLessThan(5)
  })
})

describe('BlinkModel', () => {
  it('가만두면 언젠가 깜빡인다', () => {
    const m = new BlinkModel(seq([0.5]))
    let peak = 0
    for (let i = 0; i < 60 * 20; i++) peak = Math.max(peak, m.update(1 / 60))
    expect(peak).toBeGreaterThan(0.9)
  })

  it('깜빡이는 동안에만 값이 0 이 아니다', () => {
    const m = new BlinkModel(seq([0.5]))
    let closedFrames = 0
    const frames = 60 * 20
    for (let i = 0; i < frames; i++) if (m.update(1 / 60) > 0) closedFrames++
    // 20초에 대여섯 번 × 0.24초 ≈ 전체의 10% 아래
    expect(closedFrames / frames).toBeLessThan(0.15)
    expect(closedFrames).toBeGreaterThan(0)
  })

  it('시선 이동이 깜빡임을 앞당길 수 있다', () => {
    // random 이 0.1 이면 20% 문턱을 통과한다.
    const m = new BlinkModel(seq([0.9, 0.1]))
    m.onGazeShift()
    expect(m.update(1 / 60)).toBeGreaterThan(0)
  })

  it('확률에 걸리지 않으면 앞당기지 않는다', () => {
    const m = new BlinkModel(seq([0.9, 0.9]))
    m.onGazeShift()
    expect(m.update(1 / 60)).toBe(0)
  })

  it('깜빡이는 도중의 시선 이동은 무시한다', () => {
    // 감고 있는 눈을 다시 감으라고 하면 중간에 튄다.
    const m = new BlinkModel(seq([0.001]))
    m.update(1 / 60)
    const before = m.update(1 / 60)
    m.onGazeShift()
    expect(m.update(1 / 60)).toBeGreaterThanOrEqual(before)
  })

  it('큰 delta 가 들어와도 값이 0..1 이다', () => {
    const m = new BlinkModel(seq([0.5]))
    for (let i = 0; i < 50; i++) {
      const v = m.update(3)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })
})

describe('SaccadeModel', () => {
  const R = () => 0.5

  it('작은 어긋남에는 눈을 움직이지 않는다', () => {
    // 매 프레임 따라가면 도약이 아니라 떨림이 된다.
    const m = new SaccadeModel(R)
    const r = m.update(1 / 60, { x: 0.02, y: 0 })
    expect(r.jumped).toBe(false)
    expect(Math.abs(r.x)).toBeLessThan(0.02)
  })

  it('큰 어긋남에는 도약한다', () => {
    const m = new SaccadeModel(R)
    expect(m.update(1 / 60, { x: 0.6, y: 0 }).jumped).toBe(true)
  })

  it('도약은 100ms 안에 끝난다', () => {
    const m = new SaccadeModel(R)
    m.update(1 / 60, { x: 0.6, y: 0 })
    let t = 1 / 60
    for (let i = 0; i < 6; i++) {
      m.update(1 / 60, { x: 0.6, y: 0 })
      t += 1 / 60
    }
    expect(t).toBeLessThan(0.15)
    expect(m.update(0, { x: 0.6, y: 0 }).x).toBeCloseTo(0.6, 1)
  })

  it('연달아 도약하지 않는다', () => {
    // 도약 직후 다음 도약까지 최소 간격이 있다. 없으면 눈이 진동한다.
    const m = new SaccadeModel(R)
    m.update(1 / 60, { x: 0.6, y: 0 })
    for (let i = 0; i < 10; i++) m.update(1 / 60, { x: 0.6, y: 0 })
    let jumps = 0
    for (let i = 0; i < 4; i++) if (m.update(1 / 60, { x: -0.6, y: 0 }).jumped) jumps++
    expect(jumps).toBe(0)
  })

  it('결국은 목표에 도달한다', () => {
    const m = new SaccadeModel(R)
    for (let i = 0; i < 120; i++) m.update(1 / 60, { x: 0.6, y: -0.4 })
    const r = m.update(0, { x: 0.6, y: -0.4 })
    expect(r.x).toBeCloseTo(0.6, 1)
    expect(r.y).toBeCloseTo(-0.4, 1)
  })

  it('고정 중에도 완전히 멈추지 않는다', () => {
    // 멈추면 그림이 된다.
    const m = new SaccadeModel(R)
    for (let i = 0; i < 200; i++) m.update(1 / 60, { x: 0, y: 0 })
    const a = m.update(1 / 60, { x: 0, y: 0 })
    const b = m.update(1 / 60, { x: 0, y: 0 })
    expect(a.x).not.toBe(b.x)
    expect(Math.abs(a.x)).toBeLessThan(0.02)
  })

  it('snap 은 도약 없이 붙인다', () => {
    const m = new SaccadeModel(R)
    m.snap({ x: 0.5, y: 0.5 })
    const r = m.update(1 / 60, { x: 0.5, y: 0.5 })
    expect(r.jumped).toBe(false)
    expect(r.x).toBeCloseTo(0.5, 1)
  })
})

describe('loopVariation', () => {
  it('속도를 ±6% 안에서 흔든다', () => {
    // 이보다 크면 걷기에서 발이 미끄러지는 게 보인다.
    for (const u of [0, 0.5, 1]) {
      const v = loopVariation(u)
      expect(v.timeScale).toBeGreaterThanOrEqual(0.94)
      expect(v.timeScale).toBeLessThanOrEqual(1.06)
    }
  })

  it('같은 클립이 매번 다르게 시작한다', () => {
    expect(loopVariation(0.1).phase).not.toBe(loopVariation(0.9).phase)
  })
})
