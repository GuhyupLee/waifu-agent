import { describe, expect, it } from 'vitest'
import { isQuiet, parseTimeOfDay, quietEndsAt } from '../src/main/reminders/quietHours'

const at = (h: number, m = 0): Date => new Date(2026, 7, 2, h, m, 0, 0)
const night = { from: '23:00', to: '08:00' }
const day = { from: '13:00', to: '14:00' }

describe('parseTimeOfDay', () => {
  it.each([
    ['00:00', 0],
    ['08:30', 510],
    ['23:59', 1439],
    ['9:05', 545]
  ])('%s -> %s', (s, expected) => {
    expect(parseTimeOfDay(s)).toBe(expected)
  })

  it.each(['', '25:00', '12:60', '아침', '12', '12:5'])('%s 는 null', (s) => {
    expect(parseTimeOfDay(s)).toBeNull()
  })
})

describe('isQuiet — 자정을 넘는 구간', () => {
  it('밤과 새벽 모두 조용한 시간이다', () => {
    // 23:00~08:00 이 가장 흔한 설정이다. 여기가 틀리면 새벽에 깨운다.
    expect(isQuiet(at(23, 30), night)).toBe(true)
    expect(isQuiet(at(3), night)).toBe(true)
    expect(isQuiet(at(7, 59), night)).toBe(true)
  })

  it('시작 시각은 포함하고 끝 시각은 포함하지 않는다', () => {
    expect(isQuiet(at(23), night)).toBe(true)
    expect(isQuiet(at(8), night)).toBe(false)
  })

  it('낮에는 조용하지 않다', () => {
    expect(isQuiet(at(12), night)).toBe(false)
  })
})

describe('isQuiet — 같은 날 안의 구간', () => {
  it('점심시간 같은 구간도 된다', () => {
    expect(isQuiet(at(13, 30), day)).toBe(true)
    expect(isQuiet(at(12, 59), day)).toBe(false)
    expect(isQuiet(at(14), day)).toBe(false)
  })
})

describe('isQuiet — 꺼진 경우', () => {
  it('from 과 to 가 같으면 방해 금지가 없다', () => {
    expect(isQuiet(at(3), { from: '00:00', to: '00:00' })).toBe(false)
  })

  it('형식이 틀리면 막지 않는다', () => {
    // 설정을 잘못 적었다고 알림을 통째로 삼키면 안 된다.
    expect(isQuiet(at(3), { from: '이상함', to: '08:00' })).toBe(false)
  })
})

describe('quietEndsAt', () => {
  it('조용한 시간이 아니면 null', () => {
    expect(quietEndsAt(at(12), night)).toBeNull()
  })

  it('밤에 걸리면 다음 날 아침으로 미룬다', () => {
    const end = quietEndsAt(at(23, 30), night)!
    const d = new Date(end)
    expect(d.getHours()).toBe(8)
    expect(d.getDate()).toBe(3)
  })

  it('새벽에 걸리면 같은 날 아침으로 미룬다', () => {
    const end = quietEndsAt(at(3), night)!
    const d = new Date(end)
    expect(d.getHours()).toBe(8)
    expect(d.getDate()).toBe(2)
  })

  it('미루는 시각은 항상 지금보다 뒤다', () => {
    // 과거로 미루면 즉시 다시 울려서 방해 금지가 무의미해진다.
    for (const h of [23, 0, 3, 7]) {
      const now = at(h, 30)
      const end = quietEndsAt(now, night)!
      expect(end).toBeGreaterThan(now.getTime())
    }
  })
})
