import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { BackendEvent } from '../src/shared/protocol'
import { CodexEventMapper, codexExitEvents } from '../src/main/backends/codexEvents'
import { NdjsonReader, parseLines } from '../src/main/backends/ndjson'

/** 실제 `codex exec --json` 출력을 그대로 재생한다. 손으로 만든 목이 아니다. */
function replay(): { events: BackendEvent[]; mapper: CodexEventMapper } {
  const raw = readFileSync(resolve(__dirname, 'fixtures', 'codex-exec.jsonl'), 'utf8')
  const reader = new NdjsonReader()
  const mapper = new CodexEventMapper()
  const events: BackendEvent[] = []
  for (let i = 0; i < raw.length; i += 61) {
    for (const obj of parseLines(reader.push(raw.slice(i, i + 61)))) events.push(...mapper.map(obj))
  }
  for (const obj of parseLines(reader.flush())) events.push(...mapper.map(obj))
  return { events, mapper }
}

const only = <T extends BackendEvent['type']>(evts: BackendEvent[], t: T) =>
  evts.filter((e): e is Extract<BackendEvent, { type: T }> => e.type === t)

describe('CodexEventMapper — 실제 exec 캡처 재생', () => {
  const { events, mapper } = replay()

  it('thread.started 의 thread_id 를 세션 키로 쓴다', () => {
    const s = only(events, 'session')
    expect(s).toHaveLength(1)
    expect(s[0]!.backend).toBe('codex')
    // Codex 는 session_id 가 아니라 thread_id 다. 여기를 틀리면 resume 이 안 된다.
    expect(s[0]!.sessionId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('완성된 agent_message 만 텍스트로 올린다', () => {
    const t = only(events, 'text')
    expect(t).toHaveLength(2)
    expect(t[1]!.text).toBe('done')
  })

  it('command_execution 을 시작·종료로 짝지어 준다', () => {
    const start = only(events, 'tool-start')
    const end = only(events, 'tool-end')
    expect(start).toHaveLength(1)
    expect(end).toHaveLength(1)
    expect(start[0]!.id).toBe(end[0]!.id)
    expect(start[0]!.name).toBe('shell')
    expect(end[0]!.isError).toBe(false)
  })

  it('경고성 error 아이템이 턴을 실패로 만들지 않는다', () => {
    // 캡처에는 "Under-development features enabled" 경고가 item.type=error 로 들어 있다.
    // 이걸 실패로 처리하면 멀쩡한 턴이 전부 실패로 보인다.
    const activities = only(events, 'activity')
    expect(activities.some((a) => a.detail.includes('Under-development'))).toBe(true)
    expect(only(events, 'error')).toHaveLength(0)
    expect(only(events, 'result')[0]!.isError).toBe(false)
  })

  it('result 본문을 마지막 agent_message 에서 채운다', () => {
    // Codex 의 turn.completed 에는 usage 만 있고 본문이 없다.
    const r = only(events, 'result')
    expect(r).toHaveLength(1)
    expect(r[0]!.text).toBe('done')
    expect(mapper.resultText).toBe('done')
    expect(mapper.sawTurnCompleted).toBe(true)
  })
})

describe('codexExitEvents', () => {
  it('정상 종료면 아무것도 만들지 않는다', () => {
    expect(codexExitEvents(0, '')).toEqual([])
  })

  it('비정상 종료를 턴 실패로 판정한다', () => {
    const evts = codexExitEvents(1, 'something went wrong')
    expect(evts.map((e) => e.type)).toEqual(['error', 'result'])
    expect((evts[1] as Extract<BackendEvent, { type: 'result' }>).isError).toBe(true)
  })

  it('stderr 가 비어도 종료 코드를 담은 메시지를 만든다', () => {
    const evts = codexExitEvents(137, '   ')
    expect((evts[0] as Extract<BackendEvent, { type: 'error' }>).message).toContain('137')
  })

  it('인증 실패를 auth 로 분류한다', () => {
    const evts = codexExitEvents(1, 'Please run codex login to authenticate')
    expect((evts[0] as Extract<BackendEvent, { type: 'error' }>).kind).toBe('auth')
  })
})
