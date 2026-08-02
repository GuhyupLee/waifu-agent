import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'

/**
 * 자주 하는 일을 이름 붙여 저장해둔다.
 *
 * 작업이 끝난 뒤 "이거 다음에도 같은 방식으로 할까?" 하고 물어, 승인하면 루틴이 된다.
 *
 * **자동 실행하지 않는다.** 사용자가 이름을 부를 때만 돈다. 사용자가 자리에 없는 사이
 * 저장된 절차가 혼자 도는 건 위험하고, 무엇보다 신뢰를 잃는다.
 */

export interface Routine {
  id: string
  /** 사용자가 부를 이름. "영수증 정리" 처럼. */
  name: string
  /** 무엇을 하는지 사람이 읽는 설명. */
  summary: string
  /**
   * 에이전트가 실행할 때 받을 지시. 이전 작업에서 실제로 통한 절차를 적는다.
   * 명령 스크립트가 아니라 자연어 절차다 — 상황이 조금 달라도 에이전트가 맞춰 간다.
   */
  steps: string
  /** 이 루틴이 만들어진 원래 작업. 저널을 되짚을 수 있다. */
  sourceTaskId: string | null
  runCount: number
  lastRunAt: number | null
  createdAt: number
}

export interface CreateRoutineInput {
  name: string
  summary: string
  steps: string
  sourceTaskId?: string | null
}

export class RoutineStore {
  private db: DatabaseSync | null = null

  constructor(private readonly dbPath?: string) {}

  private open(): DatabaseSync {
    if (this.db) return this.db
    let path = this.dbPath
    if (!path) {
      const dir = join(app.getPath('userData'), 'data')
      mkdirSync(dir, { recursive: true })
      path = join(dir, 'routines.db')
    }
    const db = new DatabaseSync(path)
    db.exec(`
      CREATE TABLE IF NOT EXISTS routines (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL UNIQUE,
        summary        TEXT NOT NULL,
        steps          TEXT NOT NULL,
        source_task_id TEXT,
        run_count      INTEGER NOT NULL DEFAULT 0,
        last_run_at    INTEGER,
        created_at     INTEGER NOT NULL
      );
    `)
    this.db = db
    return db
  }

  /**
   * 같은 이름이면 덮어쓴다. 절차를 다듬어 다시 저장하는 흐름이 자연스럽고,
   * 이름이 같은 루틴이 여럿이면 사용자가 어느 것을 부르는지 알 수 없다.
   */
  save(input: CreateRoutineInput): Routine {
    const name = input.name.trim()
    if (!name) throw new Error('루틴 이름이 비었다')
    const steps = input.steps.trim()
    if (!steps) throw new Error('절차가 비어 있으면 나중에 실행할 수 없다')

    const existing = this.byName(name)
    const now = Date.now()

    if (existing) {
      this.open()
        .prepare(`UPDATE routines SET summary = ?, steps = ?, source_task_id = ? WHERE id = ?`)
        .run(input.summary.trim(), steps, input.sourceTaskId ?? null, existing.id)
      return this.byName(name)!
    }

    const r: Routine = {
      id: randomUUID(),
      name,
      summary: input.summary.trim(),
      steps,
      sourceTaskId: input.sourceTaskId ?? null,
      runCount: 0,
      lastRunAt: null,
      createdAt: now
    }
    this.open()
      .prepare(
        `INSERT INTO routines(id, name, summary, steps, source_task_id, run_count, last_run_at, created_at)
         VALUES(?,?,?,?,?,0,NULL,?)`
      )
      .run(r.id, r.name, r.summary, r.steps, r.sourceTaskId, r.createdAt)
    return r
  }

  byName(name: string): Routine | null {
    const row = this.open().prepare(`SELECT * FROM routines WHERE name = ?`).get(name.trim())
    return row ? toRoutine(row) : null
  }

  /** 자주 쓰는 것부터. 목록이 길어져도 쓰던 게 위에 있다. */
  list(limit = 50): Routine[] {
    return this.open()
      .prepare(`SELECT * FROM routines ORDER BY run_count DESC, created_at DESC LIMIT ?`)
      .all(limit)
      .map(toRoutine)
  }

  markRun(id: string, now = Date.now()): void {
    this.open()
      .prepare(`UPDATE routines SET run_count = run_count + 1, last_run_at = ? WHERE id = ?`)
      .run(now, id)
  }

  remove(name: string): boolean {
    const info = this.open().prepare(`DELETE FROM routines WHERE name = ?`).run(name.trim())
    return Number(info.changes) > 0
  }

  close(): void {
    this.db?.close()
    this.db = null
  }
}

function toRoutine(row: unknown): Routine {
  const r = row as Record<string, unknown>
  return {
    id: String(r.id),
    name: String(r.name),
    summary: String(r.summary),
    steps: String(r.steps),
    sourceTaskId: r.source_task_id == null ? null : String(r.source_task_id),
    runCount: Number(r.run_count),
    lastRunAt: r.last_run_at == null ? null : Number(r.last_run_at),
    createdAt: Number(r.created_at)
  }
}
