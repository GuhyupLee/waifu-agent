import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SnapshotStore } from '../src/main/safety/snapshots'

describe('SnapshotStore', () => {
  let work: string
  let store: SnapshotStore

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'waifu-snap-'))
    store = new SnapshotStore(':memory:', join(work, 'backups'))
  })

  afterEach(() => {
    store.close()
    rmSync(work, { recursive: true, force: true })
  })

  const file = (name: string, body: string): string => {
    const p = join(work, name)
    writeFileSync(p, body, 'utf8')
    return p
  }

  it('덮어쓰기 전 원본을 떠두고 되돌린다', () => {
    const p = file('a.txt', '원본')
    const snap = store.capture(p, 'Write', null)
    expect(snap?.backupPath).toBeTruthy()

    // 에이전트가 파일을 바꿨다고 가정
    writeFileSync(p, '망가진 내용', 'utf8')
    expect(readFileSync(p, 'utf8')).toBe('망가진 내용')

    expect(store.restore(snap!.id)).toEqual({ ok: true })
    expect(readFileSync(p, 'utf8')).toBe('원본')
  })

  it('새로 만드는 파일은 백업 없이 기록만 남긴다', () => {
    const p = join(work, '아직없음.txt')
    const snap = store.capture(p, 'Write', null)
    expect(snap).not.toBeNull()
    expect(snap!.backupPath).toBeNull()
    expect(snap!.size).toBe(0)
  })

  it('되돌릴 원본이 없으면 이유를 알려준다', () => {
    const snap = store.capture(join(work, '없음.txt'), 'Write', null)
    // 조용히 성공한 척하면 사용자는 되돌아간 줄 안다.
    expect(store.restore(snap!.id)).toEqual({
      ok: false,
      reason: '새로 만든 파일이라 되돌릴 원본이 없다'
    })
  })

  it('없는 스냅샷을 되돌리면 실패한다', () => {
    expect(store.restore('없는id').ok).toBe(false)
  })

  it('백업 파일이 사라졌으면 실패한다', () => {
    const p = file('b.txt', 'x')
    const snap = store.capture(p, 'Edit', null)
    rmSync(snap!.backupPath!)
    expect(store.restore(snap!.id)).toEqual({ ok: false, reason: '백업 파일이 사라졌다' })
  })

  it('작업별로 모아 볼 수 있다', () => {
    store.capture(file('c.txt', '1'), 'Write', 'task-1')
    store.capture(file('d.txt', '2'), 'Write', 'task-1')
    store.capture(file('e.txt', '3'), 'Write', 'task-2')
    expect(store.byTask('task-1')).toHaveLength(2)
    expect(store.byTask('task-2')).toHaveLength(1)
  })

  it('최근 것부터 준다', () => {
    store.capture(file('f.txt', '1'), 'Write', null)
    store.capture(file('g.txt', '2'), 'Write', null)
    // 같은 밀리초에 들어와도 순서가 뒤집히면 안 된다.
    expect(store.recent()[0]!.path).toContain('g.txt')
  })

  it('되돌린 시각을 기록한다', () => {
    const snap = store.capture(file('h.txt', 'x'), 'Write', null)
    expect(store.get(snap!.id)?.restoredAt).toBeNull()
    store.restore(snap!.id)
    expect(store.get(snap!.id)?.restoredAt).toBeGreaterThan(0)
  })

  it('너무 큰 파일은 뜨지 않고 null 을 준다', () => {
    // 되돌리기 하나 때문에 디스크를 채울 이유는 없다. 조용히 성공한 척하지 않는다.
    const big = join(work, 'big.bin')
    writeFileSync(big, Buffer.alloc(9 * 1024 * 1024))
    expect(store.capture(big, 'Write', null)).toBeNull()
  })

  it('원본을 뜬 뒤 원본이 지워져도 백업은 남는다', () => {
    const p = file('i.txt', '살아남아야 함')
    const snap = store.capture(p, 'Write', null)
    rmSync(p)
    expect(store.restore(snap!.id)).toEqual({ ok: true })
    expect(readFileSync(p, 'utf8')).toBe('살아남아야 함')
  })
})
