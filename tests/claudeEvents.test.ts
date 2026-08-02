import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { BackendEvent } from '../src/shared/protocol'
import { ClaudeEventMapper, classifyError } from '../src/main/backends/claudeEvents'
import { NdjsonReader, parseLines } from '../src/main/backends/ndjson'

/**
 * 실제 CLI 출력을 그대로 재생한다. 손으로 만든 목이 아니라 캡처본이므로,
 * 이 테스트가 깨지면 둘 중 하나다: 매퍼를 잘못 고쳤거나 CLI 스키마가 바뀌었거나.
 */
function replay(fixture: string): BackendEvent[] {
  const raw = readFileSync(resolve(__dirname, 'fixtures', fixture), 'utf8')
  const reader = new NdjsonReader()
  const mapper = new ClaudeEventMapper()
  const out: BackendEvent[] = []
  // 실제 파이프처럼 잘게 쪼개 넣어 청크 경계 처리까지 함께 검증한다.
  for (let i = 0; i < raw.length; i += 97) {
    for (const obj of parseLines(reader.push(raw.slice(i, i + 97)))) out.push(...mapper.map(obj))
  }
  for (const obj of parseLines(reader.flush())) out.push(...mapper.map(obj))
  return out
}

const only = <T extends BackendEvent['type']>(evts: BackendEvent[], t: T) =>
  evts.filter((e): e is Extract<BackendEvent, { type: T }> => e.type === t)

describe('ClaudeEventMapper — 실제 멀티턴 캡처 재생', () => {
  const events = replay('claude-multiturn.jsonl')

  it('턴마다 반복되는 system/init 을 세션 이벤트 하나로 접는다', () => {
    const s = only(events, 'session')
    expect(s).toHaveLength(1)
    expect(s[0]!.backend).toBe('claude-code')
    expect(s[0]!.sessionId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('text_delta 만 자막으로 흘리고 signature/input_json delta 는 버린다', () => {
    const d = only(events, 'text-delta')
    // 캡처에는 content_block_delta 가 8개지만 그중 텍스트는 4개뿐이다.
    expect(d).toHaveLength(4)
    expect(d.every((e) => e.text.length > 0)).toBe(true)
    expect(d.map((e) => e.text).join('')).toBe('waifu-agentwaifu-agent')
  })

  it('완성된 assistant 텍스트 블록을 턴마다 하나씩 준다', () => {
    const t = only(events, 'text')
    expect(t).toHaveLength(2)
    expect(t.every((e) => e.text === 'waifu-agent')).toBe(true)
  })

  it('본문이 암호화된 thinking 블록에서 빈 자막을 만들지 않는다', () => {
    // 캡처에 thinking 블록이 1개 있지만 `thinking` 필드가 빈 문자열이다 —
    // 본문은 signature 로 암호화되어 오지 않는다. 이걸 그대로 올리면 빈 자막이 뜬다.
    expect(only(events, 'thinking')).toHaveLength(0)
    expect(only(events, 'text-delta').every((e) => e.text.length > 0)).toBe(true)
  })

  it('tool_use 와 tool_result 를 id 로 짝지어 이름까지 복원한다', () => {
    const start = only(events, 'tool-start')
    const end = only(events, 'tool-end')
    expect(start).toHaveLength(1)
    expect(end).toHaveLength(1)
    expect(start[0]!.name).toBe('Read')
    expect(end[0]!.id).toBe(start[0]!.id)
    // tool_result 자체에는 툴 이름이 없다. tool_use 때 기억해둔 것을 되살려야 한다.
    expect(end[0]!.name).toBe('Read')
    expect(end[0]!.isError).toBe(false)
  })

  it('리플레이된 내 입력을 대화로 되먹이지 않는다', () => {
    // isReplay:true 인 user 이벤트가 2개 있지만 어떤 BackendEvent 도 만들지 않아야 한다.
    // tool-end 1개 외에 user 에서 파생된 이벤트가 없음을 tool-end 개수로 확인한다.
    expect(only(events, 'tool-end')).toHaveLength(1)
    expect(events.some((e) => e.type === 'text' && e.text.startsWith('Read package.json'))).toBe(false)
  })

  it('post_turn_summary 를 사람이 읽는 활동 설명으로 올린다', () => {
    const a = only(events, 'activity')
    expect(a.length).toBeGreaterThanOrEqual(1)
    expect(a[0]!.detail).toBe('reading waifu-agent source')
  })

  it('rate_limit_event 를 최상위 타입으로 인식한다', () => {
    const r = only(events, 'rate-limit')
    expect(r).toHaveLength(1)
    expect(r[0]!.info.status).toBe('allowed')
    expect(r[0]!.info.rateLimitType).toBe('five_hour')
  })

  it('두 턴 모두 성공 result 로 끝나고 error 는 없다', () => {
    const r = only(events, 'result')
    expect(r).toHaveLength(2)
    expect(r.every((e) => e.isError === false)).toBe(true)
    expect(only(events, 'error')).toHaveLength(0)
  })
})

describe('ClaudeEventMapper — 인증 실패 캡처 재생', () => {
  const events = replay('claude-stream.jsonl')

  it('is_error 인 result 앞에 auth 로 분류된 error 를 낸다', () => {
    const err = only(events, 'error')
    expect(err).toHaveLength(1)
    expect(err[0]!.kind).toBe('auth')
    expect(err[0]!.message).toMatch(/OAuth session expired/)
    expect(only(events, 'result')[0]!.isError).toBe(true)
  })
})

describe('classifyError', () => {
  it.each([
    ['Failed to authenticate: OAuth session expired and could not be refreshed', 'auth'],
    ['Claude AI usage limit reached', 'rate-limit'],
    ['429 Too Many Requests', 'rate-limit'],
    ['ENOENT: no such file or directory', 'not-found'],
    ['something exploded', 'unknown']
  ])('%s -> %s', (msg, kind) => {
    expect(classifyError(msg)).toBe(kind)
  })
})
