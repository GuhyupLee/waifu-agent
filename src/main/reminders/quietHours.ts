/**
 * 방해 금지 시간.
 *
 * 먼저 말을 거는 기능은 잘못 쓰면 성가신 물건이 된다. 새벽에 아바타가 말을 걸면
 * 그 뒤로는 기능을 꺼버리게 된다. 조용한 시간에 걸린 알림은 **버리지 않고 미룬다** —
 * 알림을 놓치는 것과 새벽에 깨우는 것 둘 다 피해야 한다.
 */

/** "HH:MM" 을 자정 기준 분으로. 형식이 틀리면 null. */
export function parseTimeOfDay(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return h * 60 + min
}

export interface QuietWindow {
  /** "23:00" 처럼. from === to 면 방해 금지가 없는 것으로 본다. */
  from: string
  to: string
}

/**
 * 그 시각이 조용한 시간대에 드는지.
 *
 * 자정을 넘는 구간(23:00~08:00)이 정상적인 경우다. from > to 면 넘어간 것으로 본다.
 */
export function isQuiet(at: Date, window: QuietWindow): boolean {
  const from = parseTimeOfDay(window.from)
  const to = parseTimeOfDay(window.to)
  if (from === null || to === null || from === to) return false

  const minutes = at.getHours() * 60 + at.getMinutes()
  // 자정을 넘지 않는 구간: [from, to)
  if (from < to) return minutes >= from && minutes < to
  // 자정을 넘는 구간: [from, 24:00) ∪ [00:00, to)
  return minutes >= from || minutes < to
}

/**
 * 조용한 시간이 끝나는 시각. 조용한 시간이 아니면 null.
 *
 * 알림을 여기까지 미룬다. 아침이 되면 밀린 것들이 한 번에 오는데, 그게 새벽에
 * 하나씩 깨우는 것보다 낫다.
 */
export function quietEndsAt(at: Date, window: QuietWindow): number | null {
  if (!isQuiet(at, window)) return null
  const to = parseTimeOfDay(window.to)
  if (to === null) return null

  const end = new Date(at)
  end.setSeconds(0, 0)
  end.setHours(Math.floor(to / 60), to % 60)
  // 끝 시각이 이미 지났으면 내일 같은 시각이다 (자정을 넘는 구간).
  if (end.getTime() <= at.getTime()) end.setDate(end.getDate() + 1)
  return end.getTime()
}
