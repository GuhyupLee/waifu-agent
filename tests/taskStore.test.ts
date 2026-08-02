import { beforeEach, describe, expect, it } from 'vitest'
import { TaskStore } from '../src/main/tasks/store'

describe('TaskStore', () => {
  let store: TaskStore

  const make = (title = '다운로드 폴더 정리') =>
    store.create({ title, cwd: 'E:\\projects', backend: 'claude-code' })

  beforeEach(() => {
    store = new TaskStore(':memory:')
  })

  it('만들면 pending 으로 시작한다', () => {
    const t = make()
    expect(t.state).toBe('pending')
    expect(t.sessionId).toBeNull()
    expect(store.get(t.id)?.title).toBe('다운로드 폴더 정리')
  })

  it('재개에 필요한 cwd 와 backend 를 함께 남긴다', () => {
    // 세션 조회는 cwd 스코프이고, 두 CLI 의 세션 키는 호환되지 않는다.
    // 이 둘이 없으면 저장된 sessionId 가 쓸모없어진다.
    const t = make()
    expect(t.cwd).toBe('E:\\projects')
    expect(t.backend).toBe('claude-code')
  })

  it('제목이 비면 기본 이름을 준다', () => {
    const t = store.create({ title: '   ', cwd: 'C:\\', backend: 'codex' })
    expect(t.title).toBe('이름 없는 작업')
  })

  it('일부 필드만 갱신하고 나머지는 건드리지 않는다', () => {
    const t = make()
    store.update(t.id, { sessionId: 'sess-1' })
    store.update(t.id, { plan: 'PDF 7개 요약' })
    const after = store.get(t.id)!
    // plan 만 고치다가 sessionId 를 날리면 재개가 불가능해진다.
    expect(after.sessionId).toBe('sess-1')
    expect(after.plan).toBe('PDF 7개 요약')
    expect(after.title).toBe('다운로드 폴더 정리')
  })

  it('빈 패치는 아무것도 바꾸지 않는다', () => {
    const t = make()
    const after = store.update(t.id, {})
    expect(after?.updatedAt).toBe(t.updatedAt)
  })

  it('sessionId 를 null 로 되돌릴 수 있다', () => {
    const t = make()
    store.update(t.id, { sessionId: 'sess-1' })
    store.update(t.id, { sessionId: null })
    expect(store.get(t.id)?.sessionId).toBeNull()
  })

  it('끝나지 않은 것만 active 로 준다', () => {
    const a = make('진행중')
    const b = make('완료됨')
    const c = make('멈춤')
    store.update(a.id, { state: 'running' })
    store.update(b.id, { state: 'done' })
    store.update(c.id, { state: 'paused' })
    const titles = store.active().map((t) => t.title)
    expect(titles).toContain('진행중')
    expect(titles).toContain('멈춤')
    expect(titles).not.toContain('완료됨')
  })

  it('resumeAt 이 지난 멈춘 작업만 골라준다', () => {
    const past = make('지남')
    const future = make('아직')
    const noTime = make('시각없음')
    store.update(past.id, { state: 'paused', resumeAt: 1000 })
    store.update(future.id, { state: 'paused', resumeAt: 9_999_999_999_999 })
    store.update(noTime.id, { state: 'paused', resumeAt: null })

    const due = store.dueForResume(5000).map((t) => t.title)
    expect(due).toEqual(['지남'])
  })

  it('running 상태는 resumeAt 이 지나도 재개 대상이 아니다', () => {
    const t = make()
    store.update(t.id, { state: 'running', resumeAt: 1000 })
    expect(store.dueForResume(5000)).toEqual([])
  })

  it('저널을 시간순으로 돌려준다', () => {
    const t = make()
    store.append(t.id, 'user', '다운로드 폴더 정리해줘')
    store.append(t.id, 'note', '파일 목록 확인 중')
    store.append(t.id, 'result', '완료')
    expect(store.journal(t.id).map((e) => e.text)).toEqual([
      '다운로드 폴더 정리해줘',
      '파일 목록 확인 중',
      '완료'
    ])
  })

  it('저널 limit 은 최근 것을 남긴다', () => {
    const t = make()
    for (let i = 0; i < 10; i++) store.append(t.id, 'note', `${i}`)
    // 잘라낼 때 오래된 쪽을 버려야 "어디까지 했어?" 에 답할 수 있다.
    expect(store.journal(t.id, 3).map((e) => e.text)).toEqual(['7', '8', '9'])
  })

  it('빈 저널 항목은 남기지 않는다', () => {
    const t = make()
    store.append(t.id, 'note', '   ')
    expect(store.journal(t.id)).toEqual([])
  })

  it('작업을 지우면 저널도 같이 사라진다', () => {
    const t = make()
    store.append(t.id, 'note', '뭔가')
    expect(store.remove(t.id)).toBe(true)
    expect(store.journal(t.id)).toEqual([])
    expect(store.get(t.id)).toBeNull()
  })

  it('없는 작업을 지우면 false 다', () => {
    expect(store.remove('없는id')).toBe(false)
  })

  it('없는 작업을 갱신하면 null 이다', () => {
    expect(store.update('없는id', { state: 'done' })).toBeNull()
  })

  it('needsUser 가 차 있으면 막혀 있다는 뜻이다', () => {
    const t = make()
    store.update(t.id, { state: 'waiting-user', needsUser: '숙소 예산이 얼마야?' })
    const after = store.get(t.id)!
    expect(after.state).toBe('waiting-user')
    expect(after.needsUser).toContain('숙소 예산')
  })
})
