import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import type { BackendKind } from '@shared/protocol'

/**
 * 지속되는 작업.
 *
 * 이 앱이 일반 챗봇과 갈리는 지점은 말솜씨가 아니라 **부탁을 기억하고, 실제로 처리하고,
 * 결과를 다시 알려주는 것**이다. 그래서 중심 자료구조는 채팅 세션이 아니라 Task 다.
 *
 * 재개를 위해 반드시 같이 저장해야 하는 것들:
 *  - `cwd`     — CLI 의 세션 조회가 작업 디렉터리 스코프다. 다른 곳에서 재개하면 못 찾는다.
 *  - `backend` — Claude Code 의 session_id 와 Codex 의 thread_id 는 서로 다른 저장소에 있다.
 *                교차 재개가 불가능하므로 어느 쪽 것인지 알아야 한다.
 */

export type TaskState =
  | 'pending'
  | 'running'
  /** 사용자 확인을 기다리는 중. 승인 카드나 질문에 답해야 진행된다. */
  | 'waiting-user'
  /** 사용량 한도 등으로 멈춤. `resumeAt` 이후 다시 시도한다. */
  | 'paused'
  | 'done'
  | 'failed'

export type TaskOrigin = 'desktop' | 'discord'

export interface Task {
  id: string
  title: string
  origin: TaskOrigin
  cwd: string
  backend: BackendKind
  /** CLI 가 부여한 세션 키. `--resume` / `exec resume` 에 그대로 넘긴다. */
  sessionId: string | null
  state: TaskState
  /** 에이전트가 스스로 적는 현재 계획. */
  plan: string
  /** 다음에 할 일. 재개했을 때 어디서부터인지 알기 위한 것. */
  nextAction: string
  /** 사용자에게 물어봐야 하는 것. 비어 있지 않으면 진행이 막혀 있다는 뜻이다. */
  needsUser: string
  /** paused 일 때 다시 시도할 시각 (epoch ms). */
  resumeAt: number | null
  createdAt: number
  updatedAt: number
}

export type JournalKind = 'note' | 'tool' | 'result' | 'error' | 'user'

export interface JournalEntry {
  id: number
  taskId: string
  at: number
  kind: JournalKind
  text: string
}

export interface CreateTaskInput {
  title: string
  cwd: string
  backend: BackendKind
  origin?: TaskOrigin
}

export class TaskStore {
  private db: DatabaseSync | null = null

  /** @param dbPath 테스트에서 `:memory:` 를 넣는다. */
  constructor(private readonly dbPath?: string) {}

  private open(): DatabaseSync {
    if (this.db) return this.db
    let path = this.dbPath
    if (!path) {
      const dir = join(app.getPath('userData'), 'data')
      mkdirSync(dir, { recursive: true })
      path = join(dir, 'tasks.db')
    }
    const db = new DatabaseSync(path)
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        origin      TEXT NOT NULL,
        cwd         TEXT NOT NULL,
        backend     TEXT NOT NULL,
        session_id  TEXT,
        state       TEXT NOT NULL,
        plan        TEXT NOT NULL DEFAULT '',
        next_action TEXT NOT NULL DEFAULT '',
        needs_user  TEXT NOT NULL DEFAULT '',
        resume_at   INTEGER,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state, updated_at DESC);

      CREATE TABLE IF NOT EXISTS journal (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        at      INTEGER NOT NULL,
        kind    TEXT NOT NULL,
        text    TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_journal_task ON journal(task_id, id);
    `)
    // 외래 키는 SQLite 에서 기본이 꺼져 있다. 켜야 CASCADE 가 동작한다.
    db.exec('PRAGMA foreign_keys = ON')
    this.db = db
    return db
  }

  create(input: CreateTaskInput): Task {
    const now = Date.now()
    const task: Task = {
      id: randomUUID(),
      title: input.title.trim() || '이름 없는 작업',
      origin: input.origin ?? 'desktop',
      cwd: input.cwd,
      backend: input.backend,
      sessionId: null,
      state: 'pending',
      plan: '',
      nextAction: '',
      needsUser: '',
      resumeAt: null,
      createdAt: now,
      updatedAt: now
    }
    this.open()
      .prepare(
        `INSERT INTO tasks(id, title, origin, cwd, backend, session_id, state, plan,
                           next_action, needs_user, resume_at, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        task.id,
        task.title,
        task.origin,
        task.cwd,
        task.backend,
        null,
        task.state,
        '',
        '',
        '',
        null,
        now,
        now
      )
    return task
  }

  get(id: string): Task | null {
    const row = this.open().prepare(`SELECT * FROM tasks WHERE id = ?`).get(id)
    return row ? toTask(row) : null
  }

  /** 상태로 거르고 최근 갱신 순으로. 상태를 안 주면 전부. */
  list(states?: readonly TaskState[], limit = 50): Task[] {
    const db = this.open()
    if (!states || states.length === 0) {
      return db
        .prepare(`SELECT * FROM tasks ORDER BY updated_at DESC, rowid DESC LIMIT ?`)
        .all(limit)
        .map(toTask)
    }
    const holes = states.map(() => '?').join(',')
    return db
      .prepare(
        `SELECT * FROM tasks WHERE state IN (${holes}) ORDER BY updated_at DESC, rowid DESC LIMIT ?`
      )
      .all(...states, limit)
      .map(toTask)
  }

  /** 아직 끝나지 않은 것. 앱을 다시 켰을 때 이어서 보여줄 대상이다. */
  active(): Task[] {
    return this.list(['pending', 'running', 'waiting-user', 'paused'])
  }

  /** `resumeAt` 이 지난 멈춘 작업. 한도가 풀렸는지 확인할 때 쓴다. */
  dueForResume(now = Date.now()): Task[] {
    return this.open()
      .prepare(
        `SELECT * FROM tasks WHERE state = 'paused' AND resume_at IS NOT NULL AND resume_at <= ?
         ORDER BY resume_at ASC`
      )
      .all(now)
      .map(toTask)
  }

  /**
   * 일부 필드만 갱신한다. 넘기지 않은 필드는 건드리지 않는다 —
   * 에이전트가 plan 만 고치려다 sessionId 를 날리면 재개가 불가능해진다.
   */
  update(
    id: string,
    patch: Partial<
      Pick<
        Task,
        'title' | 'state' | 'plan' | 'nextAction' | 'needsUser' | 'sessionId' | 'resumeAt' | 'backend'
      >
    >
  ): Task | null {
    const COLUMNS: Record<string, string> = {
      title: 'title',
      state: 'state',
      plan: 'plan',
      nextAction: 'next_action',
      needsUser: 'needs_user',
      sessionId: 'session_id',
      resumeAt: 'resume_at',
      backend: 'backend'
    }

    const sets: string[] = []
    const values: (string | number | null)[] = []
    for (const [key, column] of Object.entries(COLUMNS)) {
      const v = (patch as Record<string, unknown>)[key]
      if (v === undefined) continue
      sets.push(`${column} = ?`)
      values.push(v as string | number | null)
    }
    if (sets.length === 0) return this.get(id)

    sets.push('updated_at = ?')
    values.push(Date.now())

    this.open()
      .prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values, id)
    return this.get(id)
  }

  append(taskId: string, kind: JournalKind, text: string): void {
    if (!text.trim()) return
    this.open()
      .prepare(`INSERT INTO journal(task_id, at, kind, text) VALUES(?,?,?,?)`)
      .run(taskId, Date.now(), kind, text)
  }

  /** 기본은 최근 것부터 뽑은 뒤 시간순으로 되돌려 준다 — 읽을 때는 위에서 아래가 자연스럽다. */
  journal(taskId: string, limit = 100): JournalEntry[] {
    return this.open()
      .prepare(`SELECT * FROM journal WHERE task_id = ? ORDER BY id DESC LIMIT ?`)
      .all(taskId, limit)
      .map(toJournal)
      .reverse()
  }

  remove(id: string): boolean {
    const info = this.open().prepare(`DELETE FROM tasks WHERE id = ?`).run(id)
    return Number(info.changes) > 0
  }

  close(): void {
    this.db?.close()
    this.db = null
  }
}

function toTask(row: unknown): Task {
  const r = row as Record<string, unknown>
  return {
    id: String(r.id),
    title: String(r.title),
    origin: r.origin as TaskOrigin,
    cwd: String(r.cwd),
    backend: r.backend as BackendKind,
    sessionId: r.session_id == null ? null : String(r.session_id),
    state: r.state as TaskState,
    plan: String(r.plan ?? ''),
    nextAction: String(r.next_action ?? ''),
    needsUser: String(r.needs_user ?? ''),
    resumeAt: r.resume_at == null ? null : Number(r.resume_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at)
  }
}

function toJournal(row: unknown): JournalEntry {
  const r = row as Record<string, unknown>
  return {
    id: Number(r.id),
    taskId: String(r.task_id),
    at: Number(r.at),
    kind: r.kind as JournalKind,
    text: String(r.text)
  }
}
