import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'

/**
 * 시간이 되면 와이프가 먼저 말을 건다.
 *
 * "부탁을 기억하고 결과를 알려준다" 의 다른 반쪽이다. 사용자가 물어봐야만 답하는
 * 물건은 챗봇이지 에이전트가 아니다.
 */

export type Repeat = 'none' | 'daily' | 'weekly'
export type Channel = 'desktop' | 'discord' | 'both'

export interface Reminder {
  id: string
  text: string
  /** 울릴 시각 (epoch ms). */
  dueAt: number
  repeat: Repeat
  channel: Channel
  /** 연결된 작업. 없으면 단독 알림이다. */
  taskId: string | null
  /** 마지막으로 울린 시각. repeat 이 none 이면 이 값이 차는 순간 끝난 것이다. */
  firedAt: number | null
  createdAt: number
}

export interface CreateReminderInput {
  text: string
  dueAt: number
  repeat?: Repeat
  channel?: Channel
  taskId?: string | null
}

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS

/**
 * 다음 울릴 시각. 반복이 아니면 null.
 *
 * 단순히 `dueAt + 주기` 를 더하면, 앱이 며칠 꺼져 있었을 때 밀린 알림이
 * 한꺼번에 쏟아진다. 지금보다 미래가 될 때까지 밀어 올린다.
 */
export function nextDueAt(dueAt: number, repeat: Repeat, now: number): number | null {
  if (repeat === 'none') return null
  const step = repeat === 'daily' ? DAY_MS : WEEK_MS
  let next = dueAt + step
  if (next <= now) {
    // 밀린 횟수를 한 번에 건너뛴다. 루프를 돌면 몇 년치일 때 느려진다.
    //
    // floor + 1 이어야 **반드시 now 보다 크다**. ceil 을 쓰면 now 가 주기의 정확한
    // 배수일 때 next === now 가 되어, 울리자마자 또 걸리는 무한 반복이 된다.
    const missed = Math.floor((now - next) / step) + 1
    next += missed * step
  }
  return next
}

/**
 * 에이전트가 준 `in_minutes` 또는 `at`(ISO) 를 절대 시각으로 바꾼다.
 *
 * 둘 다 없거나 해석이 안 되면 던진다 — 조용히 아무 때나로 잡으면 사용자는
 * 예약했다고 믿은 알림을 영영 못 받는다.
 */
export function resolveReminderTime(args: Record<string, unknown>, now = Date.now()): number {
  if (typeof args.in_minutes === 'number' && Number.isFinite(args.in_minutes)) {
    if (args.in_minutes <= 0) throw new Error('in_minutes 는 0보다 커야 한다')
    return now + args.in_minutes * 60_000
  }
  if (typeof args.at === 'string' && args.at.trim()) {
    const t = Date.parse(args.at)
    if (Number.isNaN(t)) throw new Error(`시각을 해석할 수 없다: ${args.at}`)
    if (t <= now) throw new Error(`이미 지난 시각이다: ${args.at}`)
    return t
  }
  throw new Error('in_minutes 또는 at 중 하나를 줘야 한다')
}

export class ReminderStore {
  private db: DatabaseSync | null = null

  constructor(private readonly dbPath?: string) {}

  private open(): DatabaseSync {
    if (this.db) return this.db
    let path = this.dbPath
    if (!path) {
      const dir = join(app.getPath('userData'), 'data')
      mkdirSync(dir, { recursive: true })
      path = join(dir, 'reminders.db')
    }
    const db = new DatabaseSync(path)
    db.exec(`
      CREATE TABLE IF NOT EXISTS reminders (
        id         TEXT PRIMARY KEY,
        text       TEXT NOT NULL,
        due_at     INTEGER NOT NULL,
        repeat     TEXT NOT NULL,
        channel    TEXT NOT NULL,
        task_id    TEXT,
        fired_at   INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(due_at);
    `)
    this.db = db
    return db
  }

  create(input: CreateReminderInput): Reminder {
    const text = input.text.trim()
    if (!text) throw new Error('알림 내용이 비었다')

    const r: Reminder = {
      id: randomUUID(),
      text,
      dueAt: input.dueAt,
      repeat: input.repeat ?? 'none',
      channel: input.channel ?? 'desktop',
      taskId: input.taskId ?? null,
      firedAt: null,
      createdAt: Date.now()
    }
    this.open()
      .prepare(
        `INSERT INTO reminders(id, text, due_at, repeat, channel, task_id, fired_at, created_at)
         VALUES(?,?,?,?,?,?,NULL,?)`
      )
      .run(r.id, r.text, r.dueAt, r.repeat, r.channel, r.taskId, r.createdAt)
    return r
  }

  /**
   * 울릴 때가 된 것들.
   *
   * 반복이 아닌 알림은 한 번 울리면 `fired_at` 이 차서 다시 걸리지 않는다.
   * 반복 알림은 울린 뒤 `due_at` 이 다음으로 밀리므로 `fired_at` 을 조건에 넣지 않는다.
   */
  due(now = Date.now()): Reminder[] {
    return this.open()
      .prepare(
        `SELECT * FROM reminders
         WHERE due_at <= ? AND (fired_at IS NULL OR repeat != 'none')
         ORDER BY due_at ASC`
      )
      .all(now)
      .map(toReminder)
  }

  /** 아직 울리지 않은 것들. "뭐 알려줄 거 있어?" 에 답할 재료다. */
  upcoming(limit = 20): Reminder[] {
    return this.open()
      .prepare(
        `SELECT * FROM reminders
         WHERE fired_at IS NULL OR repeat != 'none'
         ORDER BY due_at ASC LIMIT ?`
      )
      .all(limit)
      .map(toReminder)
  }

  /**
   * 울렸다고 표시한다. 반복이면 다음 시각으로 밀고, 아니면 그대로 끝낸다.
   * @returns 다음 시각. 끝났으면 null.
   */
  markFired(id: string, now = Date.now()): number | null {
    const r = this.get(id)
    if (!r) return null
    const next = nextDueAt(r.dueAt, r.repeat, now)
    this.open()
      .prepare(`UPDATE reminders SET fired_at = ?, due_at = ? WHERE id = ?`)
      .run(now, next ?? r.dueAt, id)
    return next
  }

  /** 울릴 시각을 미룬다. 방해 금지 시간에 걸렸을 때 쓴다. */
  postpone(id: string, until: number): void {
    this.open().prepare(`UPDATE reminders SET due_at = ? WHERE id = ?`).run(until, id)
  }

  get(id: string): Reminder | null {
    const row = this.open().prepare(`SELECT * FROM reminders WHERE id = ?`).get(id)
    return row ? toReminder(row) : null
  }

  cancel(id: string): boolean {
    const info = this.open().prepare(`DELETE FROM reminders WHERE id = ?`).run(id)
    return Number(info.changes) > 0
  }

  close(): void {
    this.db?.close()
    this.db = null
  }
}

function toReminder(row: unknown): Reminder {
  const r = row as Record<string, unknown>
  return {
    id: String(r.id),
    text: String(r.text),
    dueAt: Number(r.due_at),
    repeat: r.repeat as Repeat,
    channel: r.channel as Channel,
    taskId: r.task_id == null ? null : String(r.task_id),
    firedAt: r.fired_at == null ? null : Number(r.fired_at),
    createdAt: Number(r.created_at)
  }
}
