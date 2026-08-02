import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * 세션을 넘어 남는 기억.
 *
 * `node:sqlite` 를 쓴다 — Electron 43 에 내장되어 있어서 better-sqlite3 처럼
 * Electron ABI 에 맞춰 네이티브 재빌드를 할 필요가 없다. (Electron 바이너리로
 * 직접 확인했다.)
 *
 * 검색은 FTS5 가 아니라 LIKE 로 한다. FTS5 의 기본 unicode61 토크나이저는 공백으로
 * 끊는데, 일본어는 공백이 없고 한국어도 조사가 붙어 어간이 안 잡힌다. 개인용 규모
 * (많아야 수백 건)에서는 부분 문자열 검색이 더 정확하고 충분히 빠르다.
 */

export interface Memory {
  key: string
  value: string
  updatedAt: number
}

export class MemoryStore {
  private db: DatabaseSync | null = null

  /**
   * @param dbPath 테스트에서 `:memory:` 나 임시 경로를 넣는다.
   *   비우면 userData 아래를 쓴다 — electron 에 의존하는 부분을 여기 한 곳으로 몰아둔다.
   */
  constructor(private readonly dbPath?: string) {}

  private open(): DatabaseSync {
    if (this.db) return this.db
    let path = this.dbPath
    if (!path) {
      const dir = join(app.getPath('userData'), 'data')
      mkdirSync(dir, { recursive: true })
      path = join(dir, 'memory.db')
    }
    const db = new DatabaseSync(path)
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      -- rowid 는 인덱스 컬럼으로 쓸 수 없다. 정렬의 타이브레이커로만 쓴다 —
      -- 같은 밀리초에 두 건이 들어오면 updated_at 만으로는 "가장 최근" 이 뒤집힌다.
      CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at DESC);
    `)
    this.db = db
    return db
  }

  /** 같은 키로 다시 쓰면 갱신된다. 에이전트가 사실을 고쳐 쓸 수 있어야 한다. */
  remember(key: string, value: string): void {
    const k = key.trim()
    if (!k) throw new Error('기억의 키가 비었다')
    this.open()
      .prepare(
        `INSERT INTO memories(key, value, updated_at) VALUES(?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(k, value, Date.now())
  }

  /**
   * 검색. 질의를 공백으로 쪼개 모든 조각이 들어간 것만 돌려준다(AND).
   * 조각이 없으면 최근 것부터 준다 — "뭐 기억하고 있어?" 같은 질문에 답할 수 있어야 한다.
   */
  recall(query: string, limit = 10): Memory[] {
    const terms = query.trim().split(/\s+/).filter(Boolean)
    const db = this.open()

    if (terms.length === 0) {
      return db
        .prepare(`SELECT key, value, updated_at FROM memories ORDER BY updated_at DESC, rowid DESC LIMIT ?`)
        .all(limit)
        .map(toMemory)
    }

    // 키와 값 어느 쪽에 걸려도 찾는다. 조각마다 조건을 하나씩 붙인다.
    const where = terms.map(() => '(key LIKE ? OR value LIKE ?)').join(' AND ')
    const params = terms.flatMap((t) => [`%${t}%`, `%${t}%`])
    return db
      .prepare(
        `SELECT key, value, updated_at FROM memories WHERE ${where} ORDER BY updated_at DESC, rowid DESC LIMIT ?`
      )
      .all(...params, limit)
      .map(toMemory)
  }

  forget(key: string): boolean {
    const info = this.open().prepare(`DELETE FROM memories WHERE key = ?`).run(key)
    return Number(info.changes) > 0
  }

  count(): number {
    const row = this.open().prepare(`SELECT COUNT(*) AS n FROM memories`).get() as { n: number }
    return row.n
  }

  close(): void {
    this.db?.close()
    this.db = null
  }
}

function toMemory(row: unknown): Memory {
  const r = row as { key: string; value: string; updated_at: number }
  return { key: r.key, value: r.value, updatedAt: Number(r.updated_at) }
}
