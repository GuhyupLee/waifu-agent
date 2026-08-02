import { beforeEach, describe, expect, it } from 'vitest'
import { ReminderStore, nextDueAt, resolveReminderTime } from '../src/main/reminders/store'

const DAY = 24 * 60 * 60 * 1000
const WEEK = 7 * DAY

describe('nextDueAt', () => {
  it('반복이 없으면 다음이 없다', () => {
    expect(nextDueAt(1000, 'none', 2000)).toBeNull()
  })

  it('매일·매주 주기를 더한다', () => {
    const t = 10 * DAY
    expect(nextDueAt(t, 'daily', t)).toBe(t + DAY)
    expect(nextDueAt(t, 'weekly', t)).toBe(t + WEEK)
  })

  it('앱이 며칠 꺼져 있었어도 밀린 알림이 쏟아지지 않는다', () => {
    // 단순히 주기를 한 번 더하면 과거 시각이 나와서 즉시 또 울리고,
    // 그게 반복되면 며칠치가 한꺼번에 터진다.
    const due = 0
    const now = 10 * DAY + 1000
    const next = nextDueAt(due, 'daily', now)!
    expect(next).toBeGreaterThan(now)
    // 딱 한 주기 안쪽으로만 미래여야 한다. 너무 멀리 밀면 하루를 건너뛴다.
    expect(next - now).toBeLessThanOrEqual(DAY)
  })

  it('아주 오래 꺼져 있어도 빠르게 계산한다', () => {
    // 루프로 밀어 올리면 몇 년치일 때 느려진다.
    const next = nextDueAt(0, 'daily', 3650 * DAY)!
    expect(next).toBeGreaterThan(3650 * DAY)
  })
})

describe('resolveReminderTime', () => {
  const NOW = 1_000_000_000_000

  it('in_minutes 를 절대 시각으로 바꾼다', () => {
    expect(resolveReminderTime({ in_minutes: 30 }, NOW)).toBe(NOW + 30 * 60_000)
  })

  it('ISO 시각을 받는다', () => {
    const at = new Date(NOW + 3600_000).toISOString()
    expect(resolveReminderTime({ at }, NOW)).toBe(NOW + 3600_000)
  })

  it('둘 다 없으면 던진다', () => {
    // 조용히 아무 때나로 잡으면 사용자는 예약했다고 믿은 알림을 영영 못 받는다.
    expect(() => resolveReminderTime({}, NOW)).toThrow()
  })

  it('이미 지난 시각은 거부한다', () => {
    const past = new Date(NOW - 1000).toISOString()
    expect(() => resolveReminderTime({ at: past }, NOW)).toThrow(/지난/)
  })

  it('0 이하의 in_minutes 는 거부한다', () => {
    expect(() => resolveReminderTime({ in_minutes: 0 }, NOW)).toThrow()
    expect(() => resolveReminderTime({ in_minutes: -5 }, NOW)).toThrow()
  })

  it('해석할 수 없는 문자열은 거부한다', () => {
    expect(() => resolveReminderTime({ at: '내일 아침' }, NOW)).toThrow(/해석/)
  })

  it('in_minutes 가 at 보다 우선한다', () => {
    // 둘 다 오면 상대 시간을 믿는다. 에이전트가 시각 계산을 틀릴 여지가 더 크다.
    const at = new Date(NOW + 9_999_999).toISOString()
    expect(resolveReminderTime({ in_minutes: 1, at }, NOW)).toBe(NOW + 60_000)
  })
})

describe('ReminderStore', () => {
  let store: ReminderStore
  beforeEach(() => {
    store = new ReminderStore(':memory:')
  })

  it('만들고 시간이 되면 걸린다', () => {
    store.create({ text: '약 먹기', dueAt: 1000 })
    expect(store.due(999)).toHaveLength(0)
    expect(store.due(1000)).toHaveLength(1)
  })

  it('내용이 비면 거부한다', () => {
    expect(() => store.create({ text: '  ', dueAt: 1000 })).toThrow()
  })

  it('일회성은 한 번 울리면 다시 걸리지 않는다', () => {
    const r = store.create({ text: '한 번만', dueAt: 1000 })
    expect(store.markFired(r.id, 1000)).toBeNull()
    expect(store.due(9999)).toHaveLength(0)
  })

  it('반복은 울린 뒤 다음 시각으로 밀린다', () => {
    const r = store.create({ text: '매일', dueAt: DAY, repeat: 'daily' })
    const next = store.markFired(r.id, DAY)
    expect(next).toBe(2 * DAY)
    // 아직 안 왔으니 안 걸리고
    expect(store.due(2 * DAY - 1)).toHaveLength(0)
    // 때가 되면 다시 걸린다
    expect(store.due(2 * DAY)).toHaveLength(1)
  })

  it('방해 금지에 걸리면 미룰 수 있다', () => {
    const r = store.create({ text: '조용할 때 말고', dueAt: 1000 })
    store.postpone(r.id, 5000)
    expect(store.due(1000)).toHaveLength(0)
    expect(store.due(5000)).toHaveLength(1)
  })

  it('앞으로 울릴 것들을 시간순으로 준다', () => {
    store.create({ text: '나중', dueAt: 3000 })
    store.create({ text: '먼저', dueAt: 1000 })
    expect(store.upcoming().map((r) => r.text)).toEqual(['먼저', '나중'])
  })

  it('끝난 일회성은 예정 목록에서 빠진다', () => {
    const a = store.create({ text: '끝남', dueAt: 1000 })
    store.create({ text: '남음', dueAt: 2000 })
    store.markFired(a.id, 1000)
    expect(store.upcoming().map((r) => r.text)).toEqual(['남음'])
  })

  it('반복은 울린 뒤에도 예정 목록에 남는다', () => {
    const r = store.create({ text: '매주', dueAt: WEEK, repeat: 'weekly' })
    store.markFired(r.id, WEEK)
    expect(store.upcoming().map((r) => r.text)).toEqual(['매주'])
  })

  it('취소할 수 있고 없는 것을 취소하면 false 다', () => {
    const r = store.create({ text: 'x', dueAt: 1 })
    expect(store.cancel(r.id)).toBe(true)
    expect(store.cancel(r.id)).toBe(false)
  })

  it('작업에 묶을 수 있다', () => {
    const r = store.create({ text: '이어서 하기', dueAt: 1, taskId: 'task-1' })
    expect(store.get(r.id)?.taskId).toBe('task-1')
  })

  it('채널을 기억한다', () => {
    const r = store.create({ text: '밖에서도', dueAt: 1, channel: 'both' })
    expect(store.get(r.id)?.channel).toBe('both')
  })
})
