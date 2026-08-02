import { beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/main/persona/memory'

describe('MemoryStore', () => {
  let store: MemoryStore

  beforeEach(() => {
    // ':memory:' 를 주면 electron 의 userData 경로를 타지 않는다.
    store = new MemoryStore(':memory:')
  })

  it('저장하고 다시 꺼낸다', () => {
    store.remember('선호-편집기', '사용자는 VS Code 대신 Neovim 을 쓴다')
    expect(store.recall('Neovim')[0]?.value).toContain('Neovim')
  })

  it('같은 키로 다시 쓰면 갱신한다', () => {
    store.remember('작업중', 'A 프로젝트')
    store.remember('작업중', 'B 프로젝트')
    const found = store.recall('작업중')
    expect(found).toHaveLength(1)
    expect(found[0]!.value).toBe('B 프로젝트')
  })

  it('키와 값 어느 쪽에 걸려도 찾는다', () => {
    store.remember('생일', '3월 14일')
    expect(store.recall('생일')).toHaveLength(1)
    expect(store.recall('3월')).toHaveLength(1)
  })

  it('여러 단어는 모두 포함된 것만 준다', () => {
    store.remember('a', '고양이를 키운다')
    store.remember('b', '고양이 사료를 산다')
    expect(store.recall('고양이')).toHaveLength(2)
    expect(store.recall('고양이 사료')).toHaveLength(1)
  })

  it('공백 문자열로 부르면 최근 것부터 준다', () => {
    // "뭐 기억하고 있어?" 같은 질문에 답할 수 있어야 한다.
    store.remember('첫째', '1')
    store.remember('둘째', '2')
    const all = store.recall('   ')
    expect(all).toHaveLength(2)
    expect(all[0]!.key).toBe('둘째')
  })

  it('일본어처럼 공백이 없는 문장도 부분 문자열로 찾는다', () => {
    // FTS5 의 기본 토크나이저는 공백으로 끊어서 이런 걸 못 찾는다. LIKE 를 쓰는 이유다.
    store.remember('好み', 'ユーザーは緑茶が好きです')
    expect(store.recall('緑茶')).toHaveLength(1)
  })

  it('한국어 조사가 붙어도 찾는다', () => {
    store.remember('취미', '사용자는 등산을 좋아한다')
    expect(store.recall('등산')).toHaveLength(1)
  })

  it('없는 것을 찾으면 빈 배열이다', () => {
    store.remember('a', 'b')
    expect(store.recall('전혀 다른 것')).toEqual([])
  })

  it('빈 키는 거부한다', () => {
    // 빈 키를 허용하면 모든 무명 기억이 서로 덮어쓴다.
    expect(() => store.remember('  ', '값')).toThrow()
  })

  it('지울 수 있고, 없는 것을 지우면 false 다', () => {
    store.remember('a', 'b')
    expect(store.forget('a')).toBe(true)
    expect(store.forget('a')).toBe(false)
    expect(store.count()).toBe(0)
  })

  it('개수를 센다', () => {
    store.remember('a', '1')
    store.remember('b', '2')
    expect(store.count()).toBe(2)
  })

  it('limit 을 넘기지 않는다', () => {
    for (let i = 0; i < 20; i++) store.remember(`k${i}`, '공통값')
    expect(store.recall('공통값', 5)).toHaveLength(5)
  })
})
