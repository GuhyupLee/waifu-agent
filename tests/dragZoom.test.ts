import { describe, expect, it } from 'vitest'
import { DRAG_ZOOM_MAX, DRAG_ZOOM_MIN, dragZoomTarget } from '../src/renderer/avatar/pose'

/**
 * 드래그로 손을 커서에 고정하면 몸이 아래·오른쪽으로 뻗어 좁은 창 밖으로 잘린다.
 * dragZoomTarget 은 앵커 위치로 필요한 축소율을 잡는다 — 이 테스트는 그 값이
 * 항상 안전 구간 안에 있고, 공간이 좁아질수록(앵커가 아래·오른쪽) 더 축소하는지 본다.
 * scene.ts 는 이 값으로 camera.zoom 을 끌어당길 뿐이라 카메라 없이 여기서 검증할 수 있다.
 */
describe('dragZoomTarget', () => {
  // 실제로 잘리던 조건: 420×645 창에서 손을 중앙 상단쯤(≈266px)에 잡았다.
  const FAIL_CASE = { canvasWidth: 420, canvasHeight: 645, anchorX: 218, anchorY: 266 }

  it('잘리던 캡처 조건에서 실제로 축소한다(구간 안, 상한 미만)', () => {
    const z = dragZoomTarget(FAIL_CASE)
    expect(z).toBeGreaterThanOrEqual(DRAG_ZOOM_MIN)
    expect(z).toBeLessThan(DRAG_ZOOM_MAX)
    // 세로가 제약이고, 흔들리는 옷·머리카락까지 끝에 붙지 않도록 15% 여백을 둔다(≈0.50).
    expect(z).toBeCloseTo(0.5, 2)
  })

  it('어떤 앵커에서도 [MIN, MAX] 를 벗어나지 않고 NaN 이 되지 않는다', () => {
    for (let ax = -50; ax <= 470; ax += 30) {
      for (let ay = -50; ay <= 695; ay += 30) {
        const z = dragZoomTarget({ canvasWidth: 420, canvasHeight: 645, anchorX: ax, anchorY: ay })
        expect(Number.isFinite(z)).toBe(true)
        expect(z).toBeGreaterThanOrEqual(DRAG_ZOOM_MIN)
        expect(z).toBeLessThanOrEqual(DRAG_ZOOM_MAX)
      }
    }
  })

  it('앵커가 아래로 내려갈수록 더 축소한다', () => {
    const base = { canvasWidth: 420, canvasHeight: 645, anchorX: 210 }
    const high = dragZoomTarget({ ...base, anchorY: 250 })
    const mid = dragZoomTarget({ ...base, anchorY: 300 })
    const low = dragZoomTarget({ ...base, anchorY: 350 })
    expect(high).toBeGreaterThan(mid)
    expect(mid).toBeGreaterThan(low)
  })

  it('앵커가 오른쪽 끝에 붙을수록 더 축소한다', () => {
    // 세로 공간이 넉넉하도록 높은 앵커를 써서 가로가 제약이 되게 한다.
    const base = { canvasWidth: 420, canvasHeight: 645, anchorY: 100 }
    const left = dragZoomTarget({ ...base, anchorX: 210 })
    const right = dragZoomTarget({ ...base, anchorX: 300 })
    const edge = dragZoomTarget({ ...base, anchorX: 360 })
    expect(left).toBeGreaterThan(right)
    // 안전 하한에 먼저 닿으면 그 뒤에는 같은 값으로 포화될 수 있다.
    expect(right).toBeGreaterThanOrEqual(edge)
  })

  it('공간이 넉넉해도 항상 조금은 축소해 전신 여유를 둔다(상한에서 포화)', () => {
    // 손을 아주 높이 중앙에 잡으면 아래 공간이 넘치지만 상한까지만 축소한다.
    const z = dragZoomTarget({ canvasWidth: 420, canvasHeight: 645, anchorX: 210, anchorY: 20 })
    expect(z).toBe(DRAG_ZOOM_MAX)
  })

  it('구석에 바짝 붙으면 하한에서 멈춘다', () => {
    const z = dragZoomTarget({ canvasWidth: 420, canvasHeight: 645, anchorX: 400, anchorY: 600 })
    expect(z).toBe(DRAG_ZOOM_MIN)
  })

  it('캔버스 크기가 0 이면 안전하게 상한을 돌려준다', () => {
    expect(dragZoomTarget({ canvasWidth: 0, canvasHeight: 0, anchorX: 10, anchorY: 10 })).toBe(
      DRAG_ZOOM_MAX
    )
  })
})
