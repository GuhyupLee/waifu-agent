import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type WaifuConfig } from '@shared/protocol'
import {
  monitorAt,
  monitorKey,
  placementFor,
  withPlacement,
  type MonitorInfo
} from '../src/main/avatar/monitorLayout'

const laptop: MonitorInfo = {
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  scaleFactor: 1
}
const external: MonitorInfo = {
  bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
  scaleFactor: 1.25
}

function config(patch: Partial<WaifuConfig['avatar']> = {}): WaifuConfig {
  return {
    ...DEFAULT_CONFIG,
    avatar: { ...DEFAULT_CONFIG.avatar, ...patch }
  }
}

describe('모니터 식별자', () => {
  it('크기·위치·배율이 같으면 같은 키다', () => {
    expect(monitorKey(laptop)).toBe(monitorKey({ ...laptop }))
  })

  it('같은 크기라도 자리가 다르면 다른 키다', () => {
    // 같은 모델 모니터를 두 대 쓰는 경우가 실제로 있다.
    const twin: MonitorInfo = { ...laptop, bounds: { ...laptop.bounds, x: 1920 } }
    expect(monitorKey(twin)).not.toBe(monitorKey(laptop))
  })

  it('DPI 가 바뀌면 다른 키다', () => {
    // 같은 자리 같은 크기라도 배율이 달라지면 체감 크기가 달라진다.
    expect(monitorKey({ ...laptop, scaleFactor: 2 })).not.toBe(monitorKey(laptop))
  })
})

describe('배치 조회', () => {
  it('저장된 것이 없으면 전역 기본값을 쓴다', () => {
    const placement = placementFor(config(), laptop)
    expect(placement.anchor).toEqual(DEFAULT_CONFIG.avatar.anchor)
    expect(placement.scale).toBe(DEFAULT_CONFIG.avatar.scale)
  })

  it('모니터별 기억이 꺼져 있으면 저장된 것을 무시한다', () => {
    const saved = config({
      rememberPerMonitor: false,
      perMonitor: { [monitorKey(laptop)]: { anchor: { x: 0.1, y: 0.9 }, scale: 2 } }
    })
    expect(placementFor(saved, laptop).anchor).toEqual(DEFAULT_CONFIG.avatar.anchor)
  })

  it('모니터마다 다른 배치를 돌려준다', () => {
    const saved = config({
      perMonitor: {
        [monitorKey(laptop)]: { anchor: { x: 0.1, y: 0 }, scale: 1 },
        [monitorKey(external)]: { anchor: { x: 0.9, y: 0.2 }, scale: 1.5 }
      }
    })
    expect(placementFor(saved, laptop).anchor.x).toBe(0.1)
    expect(placementFor(saved, external).scale).toBe(1.5)
  })

  it('범위를 벗어난 앵커는 잘라낸다', () => {
    // 손으로 고친 설정 파일이 들어올 수 있다. 그대로 쓰면 아바타가 화면 밖에 선다.
    const saved = config({
      perMonitor: { [monitorKey(laptop)]: { anchor: { x: 5, y: -3 }, scale: 1 } }
    })
    const placement = placementFor(saved, laptop)
    expect(placement.anchor.x).toBe(1)
    expect(placement.anchor.y).toBe(0)
  })

  it('말이 안 되는 배율을 잘라낸다', () => {
    // 상한이 없으면 화면을 덮고, 하한이 없으면 사라진다. 둘 다 되찾기 어렵다.
    const huge = config({ perMonitor: { [monitorKey(laptop)]: { anchor: { x: 0, y: 0 }, scale: 99 } } })
    expect(placementFor(huge, laptop).scale).toBe(4)

    const zero = config({ perMonitor: { [monitorKey(laptop)]: { anchor: { x: 0, y: 0 }, scale: 0 } } })
    expect(placementFor(zero, laptop).scale).toBe(1)
  })

  it('NaN 이 들어와도 무너지지 않는다', () => {
    const broken = config({
      perMonitor: { [monitorKey(laptop)]: { anchor: { x: NaN, y: NaN }, scale: NaN } }
    })
    const placement = placementFor(broken, laptop)
    expect(Number.isFinite(placement.anchor.x)).toBe(true)
    expect(Number.isFinite(placement.scale)).toBe(true)
  })
})

describe('배치 저장', () => {
  it('원본 설정을 바꾸지 않는다', () => {
    const original = config()
    const next = withPlacement(original, laptop, { anchor: { x: 0.4, y: 0.1 }, scale: 1.2 })

    expect(original.avatar.perMonitor).toEqual({})
    expect(next[monitorKey(laptop)]).toEqual({ anchor: { x: 0.4, y: 0.1 }, scale: 1.2 })
  })

  it('다른 모니터의 기록을 지우지 않는다', () => {
    const saved = config({
      perMonitor: { [monitorKey(external)]: { anchor: { x: 0.9, y: 0 }, scale: 1.5 } }
    })
    const next = withPlacement(saved, laptop, { anchor: { x: 0.1, y: 0 }, scale: 1 })

    expect(Object.keys(next)).toHaveLength(2)
    expect(next[monitorKey(external)].scale).toBe(1.5)
  })

  it('저장할 때도 값을 잘라낸다', () => {
    const next = withPlacement(config(), laptop, { anchor: { x: -1, y: 2 }, scale: 100 })
    expect(next[monitorKey(laptop)]).toEqual({ anchor: { x: 0, y: 1 }, scale: 4 })
  })
})

describe('점이 속한 모니터', () => {
  it('그 모니터를 찾는다', () => {
    expect(monitorAt({ x: 100, y: 100 }, [laptop, external])).toBe(laptop)
    expect(monitorAt({ x: 3000, y: 500 }, [laptop, external])).toBe(external)
  })

  it('경계는 왼쪽·위를 포함하고 오른쪽·아래를 제외한다', () => {
    // 두 모니터가 붙어 있을 때 겹치면 안 된다.
    expect(monitorAt({ x: 1920, y: 0 }, [laptop, external])).toBe(external)
    expect(monitorAt({ x: 1919, y: 0 }, [laptop, external])).toBe(laptop)
  })

  it('어디에도 없으면 null 이다', () => {
    // 모니터를 뽑은 직후 창이 사라진 영역에 있을 수 있다. 그때는 저장하지 않는다.
    expect(monitorAt({ x: -500, y: -500 }, [laptop, external])).toBeNull()
  })
})
