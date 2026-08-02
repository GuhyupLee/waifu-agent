import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'

/**
 * 파일을 덮어쓰기 **전에** 원본을 떠둔다.
 *
 * 프롬프트로 "조심해라" 라고 부탁하는 것과 다르다. 이건 PreToolUse 훅이 실행을
 * 막고 있는 동안 일어나므로 모델이 우회할 수 없다.
 *
 * 삭제까지 되돌리지는 못한다 — 셸이 지운 파일은 우리 손을 거치지 않는다.
 * 그래서 파괴적 명령은 자동 승인에서 빼고 반드시 사용자에게 묻는다.
 */

export interface Snapshot {
  id: string
  taskId: string | null
  path: string
  /** 백업본 위치. 원본이 없던 경우(새 파일 생성)에는 null. */
  backupPath: string | null
  size: number
  at: number
  toolName: string
  restoredAt: number | null
}

/** 이보다 큰 파일은 뜨지 않는다. 되돌리기 하나 때문에 디스크를 채울 이유는 없다. */
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024

export class SnapshotStore {
  private db: DatabaseSync | null = null

  constructor(
    private readonly dbPath?: string,
    private readonly backupDir?: string
  ) {}

  private dir(): string {
    const d = this.backupDir ?? join(app.getPath('userData'), 'snapshots')
    mkdirSync(d, { recursive: true })
    return d
  }

  private open(): DatabaseSync {
    if (this.db) return this.db
    let path = this.dbPath
    if (!path) {
      const dir = join(app.getPath('userData'), 'data')
      mkdirSync(dir, { recursive: true })
      path = join(dir, 'snapshots.db')
    }
    const db = new DatabaseSync(path)
    db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        id          TEXT PRIMARY KEY,
        task_id     TEXT,
        path        TEXT NOT NULL,
        backup_path TEXT,
        size        INTEGER NOT NULL,
        at          INTEGER NOT NULL,
        tool_name   TEXT NOT NULL,
        restored_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_at ON snapshots(at DESC);
    `)
    this.db = db
    return db
  }

  /**
   * 원본을 떠둔다. 파일이 없으면(새로 만드는 경우) 백업 없이 기록만 남긴다 —
   * 되돌리기는 "그 파일을 지우는 것" 이 된다.
   *
   * @returns 남긴 스냅샷. 너무 커서 건너뛰었으면 null.
   */
  capture(path: string, toolName: string, taskId: string | null): Snapshot | null {
    const now = Date.now()
    const id = randomUUID()

    let backupPath: string | null = null
    let size = 0

    if (existsSync(path)) {
      size = statSync(path).size
      if (size > MAX_SNAPSHOT_BYTES) {
        // 조용히 넘어가면 사용자는 되돌릴 수 있다고 믿는다. 기록은 남기되 백업은 없다.
        process.stderr.write(`[safety] ${basename(path)} 는 ${size} 바이트라 스냅샷을 건너뛴다\n`)
        return null
      }
      backupPath = join(this.dir(), `${id}-${basename(path)}`)
      copyFileSync(path, backupPath)
    }

    this.open()
      .prepare(
        `INSERT INTO snapshots(id, task_id, path, backup_path, size, at, tool_name, restored_at)
         VALUES(?,?,?,?,?,?,?,NULL)`
      )
      .run(id, taskId, path, backupPath, size, now, toolName)

    return { id, taskId, path, backupPath, size, at: now, toolName, restoredAt: null }
  }

  /** 최근 스냅샷부터. 되돌리기 UI 가 이걸 보여준다. */
  recent(limit = 50): Snapshot[] {
    return this.open()
      .prepare(`SELECT * FROM snapshots ORDER BY at DESC, rowid DESC LIMIT ?`)
      .all(limit)
      .map(toSnapshot)
  }

  byTask(taskId: string): Snapshot[] {
    return this.open()
      .prepare(`SELECT * FROM snapshots WHERE task_id = ? ORDER BY at DESC, rowid DESC`)
      .all(taskId)
      .map(toSnapshot)
  }

  get(id: string): Snapshot | null {
    const row = this.open().prepare(`SELECT * FROM snapshots WHERE id = ?`).get(id)
    return row ? toSnapshot(row) : null
  }

  /**
   * 원본을 되돌린다.
   *
   * 백업이 없는 스냅샷(새로 만든 파일)은 여기서 지우지 않는다 — 파일 삭제는
   * 사용자가 명시적으로 결정할 일이라 호출부가 처리한다.
   */
  restore(id: string): { ok: boolean; reason?: string } {
    const snap = this.get(id)
    if (!snap) return { ok: false, reason: '해당 스냅샷이 없다' }
    if (!snap.backupPath) {
      return { ok: false, reason: '새로 만든 파일이라 되돌릴 원본이 없다' }
    }
    if (!existsSync(snap.backupPath)) {
      return { ok: false, reason: '백업 파일이 사라졌다' }
    }
    copyFileSync(snap.backupPath, snap.path)
    this.open().prepare(`UPDATE snapshots SET restored_at = ? WHERE id = ?`).run(Date.now(), id)
    return { ok: true }
  }

  close(): void {
    this.db?.close()
    this.db = null
  }
}

function toSnapshot(row: unknown): Snapshot {
  const r = row as Record<string, unknown>
  return {
    id: String(r.id),
    taskId: r.task_id == null ? null : String(r.task_id),
    path: String(r.path),
    backupPath: r.backup_path == null ? null : String(r.backup_path),
    size: Number(r.size),
    at: Number(r.at),
    toolName: String(r.tool_name),
    restoredAt: r.restored_at == null ? null : Number(r.restored_at)
  }
}
