import { describe, expect, it } from 'vitest'
import { easeInOut, restingSpot } from '../src/main/roaming'

// screen 을 쓰는 함수들은 electron 런타임이 필요해 여기서 다루지 않는다.
// 순수 계산 부분만 잠근다 — 틀리면 아바타가 화면 밖으로 나가거나 순간이동한다.

describe('easeInOut', () => {
  it('0 과 1 을 정확히 지킨다', () => {
    // 끝값이 어긋나면 도착 위치가 미묘하게 틀어진다.
    expect(easeInOut(0)).toBe(0)
    expect(easeInOut(1)).toBe(1)
  })

  it('중간에서 절반이다', () => {
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 6)
  })

  it('단조 증가한다', () => {
    // 뒤로 갔다 오면 걷다가 미끄러지는 것처럼 보인다.
    let prev = -1
    for (let t = 0; t <= 1; t += 0.02) {
      const v = easeInOut(t)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })

  it('출발과 도착이 느리다', () => {
    // 등속이면 순간이동처럼 보인다. 양 끝의 변화량이 중앙보다 작아야 한다.
    const startDelta = easeInOut(0.05) - easeInOut(0)
    const midDelta = easeInOut(0.525) - easeInOut(0.475)
    expect(startDelta).toBeLessThan(midDelta)
  })
})

describe('restingSpot', () => {
  const display = (x: number, y: number, w: number, h: number) =>
    ({ workArea: { x, y, width: w, height: h } }) as never

  it('작업 영역의 오른쪽 아래에 여백을 두고 앉힌다', () => {
    const spot = restingSpot(display(0, 0, 1920, 1040), { width: 420, height: 640 }, 24)
    expect(spot).toEqual({ x: 1920 - 420 - 24, y: 1040 - 640 - 24, width: 420, height: 640 })
  })

  it('원점이 0 이 아닌 보조 모니터에서도 맞는다', () => {
    // workAreaSize 만 쓰면 여기서 창이 주 모니터로 튄다.
    const spot = restingSpot(display(1920, -180, 2560, 1400), { width: 420, height: 640 }, 24)
    expect(spot.x).toBe(1920 + 2560 - 420 - 24)
    expect(spot.y).toBe(-180 + 1400 - 640 - 24)
  })

  it('음수 좌표 모니터(왼쪽에 붙은 보조 화면)도 맞는다', () => {
    const spot = restingSpot(display(-1920, 0, 1920, 1040), { width: 420, height: 640 }, 24)
    expect(spot.x).toBe(-1920 + 1920 - 420 - 24)
  })

  it('창이 작업 영역보다 크면 좌표가 밖으로 나간다 (인지하는 한계)', () => {
    // 이런 화면에서는 애초에 아바타가 다 안 들어간다. 여기서 억지로 가두면
    // 오히려 잘린 채로 붙어 있게 된다.
    const spot = restingSpot(display(0, 0, 300, 300), { width: 420, height: 640 }, 24)
    expect(spot.x).toBeLessThan(0)
  })
})
