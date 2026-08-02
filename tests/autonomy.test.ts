import { describe, expect, it } from 'vitest'
import {
  IDLE_GESTURES,
  IDLE_THRESHOLD_MS,
  decideIdleAction,
  nextIdleDelayMs
} from '../src/main/autonomy'
import type { IdleContext } from '../src/main/autonomy'

const ctx = (over: Partial<IdleContext> = {}): IdleContext => ({
  idleMs: IDLE_THRESHOLD_MS + 1,
  busy: false,
  dragging: false,
  cursorOnOtherDisplay: false,
  motions: [...IDLE_GESTURES],
  ...over
})

describe('decideIdleAction — 끼어들지 않는다', () => {
  it('에이전트가 일하는 중이면 아무것도 안 한다', () => {
    // 작업 중에 화면을 가로지르면 방해가 된다.
    expect(decideIdleAction(ctx({ busy: true }), 0).kind).toBe('none')
  })

  it('사용자가 잡고 있으면 아무것도 안 한다', () => {
    expect(decideIdleAction(ctx({ dragging: true }), 0).kind).toBe('none')
  })

  it('대화 직후에는 아무것도 안 한다', () => {
    // 방금 말을 주고받았는데 딴짓하면 무시당하는 느낌을 준다.
    expect(decideIdleAction(ctx({ idleMs: 1000 }), 0).kind).toBe('none')
  })

  it('문턱 직전까지는 조용하다', () => {
    expect(decideIdleAction(ctx({ idleMs: IDLE_THRESHOLD_MS - 1 }), 0).kind).toBe('none')
  })
})

describe('decideIdleAction — 커서 따라가기', () => {
  it('커서가 다른 화면에 있으면 따라간다', () => {
    expect(decideIdleAction(ctx({ cursorOnOtherDisplay: true }), 0.1).kind).toBe('follow')
  })

  it('매번 따라가지는 않는다', () => {
    // 늘 따라가면 화면을 오가느라 정신없다.
    expect(decideIdleAction(ctx({ cursorOnOtherDisplay: true }), 0.9).kind).toBe('none')
  })

  it('일하는 중이면 커서가 딴 데 있어도 안 움직인다', () => {
    expect(decideIdleAction(ctx({ cursorOnOtherDisplay: true, busy: true }), 0).kind).toBe('none')
  })
})

describe('decideIdleAction — 몸짓', () => {
  it('가끔 몸짓을 한다', () => {
    const a = decideIdleAction(ctx(), 0.1)
    expect(a.kind).toBe('gesture')
    if (a.kind === 'gesture') expect(IDLE_GESTURES).toContain(a.motion)
  })

  it('대부분은 아무것도 하지 않는다', () => {
    // 늘 뭔가 하면 산만하다.
    expect(decideIdleAction(ctx(), 0.9).kind).toBe('none')
  })

  it('쓸 수 있는 몸짓이 없으면 조용하다', () => {
    expect(decideIdleAction(ctx({ motions: [] }), 0).kind).toBe('none')
  })

  it('혼자 하면 이상한 몸짓은 고르지 않는다', () => {
    // 인사·박수는 상대가 있어야 말이 되고, 화내기는 이유 없이 하면 이상하다.
    for (const bad of ['goodbye', 'clapping', 'angry', 'wave-left', 'salute', 'welcome']) {
      expect(IDLE_GESTURES).not.toContain(bad)
    }
  })

  it('목록에 없는 모션은 고르지 않는다', () => {
    // 모델이 가진 것 중에서만 고른다. 없는 이름을 부르면 아무 일도 안 일어난다.
    const a = decideIdleAction(ctx({ motions: ['walk', 'jump'] }), 0.1)
    expect(a.kind).toBe('none')
  })

  it('모든 random 값에서 유효한 결과를 준다', () => {
    for (let r = 0; r < 1; r += 0.01) {
      const a = decideIdleAction(ctx(), r)
      if (a.kind === 'gesture') expect(ctx().motions).toContain(a.motion)
    }
  })
})

describe('nextIdleDelayMs', () => {
  it('범위 안에 든다', () => {
    for (const r of [0, 0.5, 1]) {
      const d = nextIdleDelayMs(r)
      expect(d).toBeGreaterThanOrEqual(45_000)
      expect(d).toBeLessThanOrEqual(180_000)
    }
  })

  it('고정 간격이 아니다', () => {
    // 시계처럼 규칙적이면 기계처럼 보인다.
    expect(nextIdleDelayMs(0)).not.toBe(nextIdleDelayMs(1))
  })
})
