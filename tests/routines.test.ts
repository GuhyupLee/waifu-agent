import { beforeEach, describe, expect, it } from 'vitest'
import { RoutineStore } from '../src/main/routines/store'

describe('RoutineStore', () => {
  let store: RoutineStore

  const save = (name: string, steps = '1. 파일 목록 확인\n2. 날짜별로 옮김') =>
    store.save({ name, summary: '다운로드 폴더를 날짜별로 정리', steps })

  beforeEach(() => {
    store = new RoutineStore(':memory:')
  })

  it('저장하고 이름으로 찾는다', () => {
    save('영수증 정리')
    expect(store.byName('영수증 정리')?.summary).toContain('날짜별')
  })

  it('이름 앞뒤 공백을 다듬어 같은 것으로 본다', () => {
    save('영수증 정리')
    expect(store.byName('  영수증 정리  ')).not.toBeNull()
  })

  it('같은 이름으로 다시 저장하면 덮어쓴다', () => {
    save('정리')
    store.save({ name: '정리', summary: '고친 설명', steps: '고친 절차' })
    expect(store.list()).toHaveLength(1)
    expect(store.byName('정리')?.steps).toBe('고친 절차')
  })

  it('덮어써도 실행 횟수는 유지된다', () => {
    const r = save('정리')
    store.markRun(r.id)
    store.save({ name: '정리', summary: 'x', steps: 'y' })
    // 절차를 다듬었다고 그동안 쓴 기록이 사라지면 안 된다.
    expect(store.byName('정리')?.runCount).toBe(1)
  })

  it('이름이 비면 거부한다', () => {
    expect(() => store.save({ name: '  ', summary: 'x', steps: 'y' })).toThrow()
  })

  it('절차가 비면 거부한다', () => {
    // 절차 없이 저장하면 나중에 불러도 아무것도 할 수 없다.
    expect(() => store.save({ name: 'x', summary: 'y', steps: '   ' })).toThrow()
  })

  it('자주 쓰는 것부터 보여준다', () => {
    const a = save('가끔')
    const b = save('자주')
    store.markRun(b.id)
    store.markRun(b.id)
    store.markRun(a.id)
    expect(store.list().map((r) => r.name)).toEqual(['자주', '가끔'])
  })

  it('실행하면 횟수와 시각이 남는다', () => {
    const r = save('정리')
    expect(store.byName('정리')?.lastRunAt).toBeNull()
    store.markRun(r.id, 12345)
    const after = store.byName('정리')!
    expect(after.runCount).toBe(1)
    expect(after.lastRunAt).toBe(12345)
  })

  it('원래 작업을 기억한다', () => {
    store.save({ name: 'x', summary: 'y', steps: 'z', sourceTaskId: 'task-9' })
    // 절차가 어디서 나왔는지 알아야 나중에 저널을 되짚을 수 있다.
    expect(store.byName('x')?.sourceTaskId).toBe('task-9')
  })

  it('지울 수 있고 없는 것을 지우면 false 다', () => {
    save('정리')
    expect(store.remove('정리')).toBe(true)
    expect(store.remove('정리')).toBe(false)
  })

  it('없는 이름은 null 이다', () => {
    expect(store.byName('없음')).toBeNull()
  })
})
