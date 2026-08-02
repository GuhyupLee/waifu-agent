/**
 * Claude Code `--output-format stream-json` 이벤트를 앱 공용 `BackendEvent` 로 옮긴다.
 *
 * 타입은 추측이 아니라 실제 캡처(`tests/fixtures/claude-multiturn.jsonl`)에서 나온 것만 적었다.
 * 스키마가 의심되면 `node scripts/capture-fixture.mjs claude-multiturn` 으로 다시 뜬다.
 *
 * 캡처에서 확인한, 직관과 어긋나는 사실들:
 *
 *  - `system/init` 이 **턴마다** 나온다. session_id 는 같다. init 을 새 세션 신호로 쓰면 안 된다.
 *  - 이벤트 순서가 논리 순서와 다르다. 완성된 `assistant` 는 자기 델타들 *뒤에* 오고,
 *    리플레이된 `user` 는 assistant 의 `message_start` *뒤에* 온다. 순서를 가정하지 않는다.
 *  - `--replay-user-messages` 로 되돌아온 내 입력과 툴 결과가 **둘 다** `type: "user"` 다.
 *    `isReplay === true` 로 구분한다.
 *  - `thinking` 블록은 `signature_delta` 로 흐르고, 완성된 블록의 `thinking` 필드도 **빈 문자열**이다
 *    (본문은 암호화되어 `signature` 에만 들어 있다). 즉 이 경로로는 사고 내용을 볼 수 없다.
 *    아바타의 '생각 중' 상태는 여기가 아니라 백엔드 계층에서 턴 진행으로 판단한다.
 *  - `rate_limit_event` 는 `system` 하위가 아니라 **최상위 타입**이다.
 */
import type { BackendEvent, BackendErrorKind, RateLimitInfo } from '@shared/protocol'

// ─────────────────────── 원본 이벤트 형태 ───────────────────────

interface ContentBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  is_error?: boolean
}

interface RawMessage {
  role?: string
  model?: string
  content?: ContentBlock[]
}

interface RawEvent {
  type?: string
  subtype?: string
  session_id?: string
  model?: string
  message?: RawMessage
  /** null 이면 메인 대화, 값이 있으면 그 툴 호출이 띄운 서브에이전트의 메시지다. */
  parent_tool_use_id?: string | null
  /** `--replay-user-messages` 로 되돌아온 내 stdin 입력이라는 표시. */
  isReplay?: boolean
  /** stream_event 전용 */
  event?: {
    type?: string
    delta?: { type?: string; text?: string }
    content_block?: ContentBlock
  }
  /** system/init 전용 */
  mcp_servers?: { name: string; status: string }[]
  /** rate_limit_event 전용 */
  rate_limit_info?: RateLimitInfo
  /** system/post_turn_summary 전용 */
  status_category?: string
  status_detail?: string
  needs_action?: string
  /** result 전용 */
  is_error?: boolean
  result?: string
  duration_ms?: number
  total_cost_usd?: number
}

// ─────────────────────── 매퍼 ───────────────────────

export class ClaudeEventMapper {
  /** init 이 턴마다 반복되므로 첫 번째만 session 이벤트로 승격한다. */
  private announcedSession: string | null = null
  /** tool_result 에는 툴 이름이 없다. tool_use 때 본 이름을 id 로 기억해 둔다. */
  private readonly toolNames = new Map<string, string>()

  map(raw: unknown): BackendEvent[] {
    if (!raw || typeof raw !== 'object') return []
    const e = raw as RawEvent

    switch (e.type) {
      case 'system':
        return this.mapSystem(e)
      case 'stream_event':
        return mapStreamEvent(e)
      case 'assistant':
        return this.mapAssistant(e)
      case 'user':
        return this.mapUser(e)
      case 'rate_limit_event':
        return e.rate_limit_info ? [{ type: 'rate-limit', info: e.rate_limit_info }] : []
      case 'result':
        return mapResult(e)
      default:
        return []
    }
  }

  private mapSystem(e: RawEvent): BackendEvent[] {
    if (e.subtype === 'init') {
      if (!e.session_id || this.announcedSession === e.session_id) return []
      this.announcedSession = e.session_id
      const ev: BackendEvent = { type: 'session', sessionId: e.session_id, backend: 'claude-code' }
      if (e.model) ev.model = e.model
      if (e.mcp_servers) ev.mcpServers = e.mcp_servers
      return [ev]
    }
    if (e.subtype === 'post_turn_summary') {
      const detail = e.status_detail?.trim()
      if (!detail) return []
      const ev: BackendEvent = { type: 'activity', detail }
      if (e.status_category) ev.category = e.status_category
      if (e.needs_action) ev.needsAction = e.needs_action
      return [ev]
    }
    return []
  }

  private mapAssistant(e: RawEvent): BackendEvent[] {
    const out: BackendEvent[] = []
    // 서브에이전트가 뱉은 말까지 와이프가 읽으면 대화가 엉킨다. 툴 활동만 통과시킨다.
    const fromSubagent = e.parent_tool_use_id != null
    for (const c of e.message?.content ?? []) {
      if (c.type === 'text' && c.text && !fromSubagent) {
        out.push({ type: 'text', text: c.text })
      } else if (c.type === 'thinking' && c.thinking && !fromSubagent) {
        out.push({ type: 'thinking', text: c.thinking })
      } else if (c.type === 'tool_use' && c.id && c.name) {
        this.toolNames.set(c.id, c.name)
        out.push({ type: 'tool-start', id: c.id, name: c.name, input: c.input })
      }
    }
    return out
  }

  private mapUser(e: RawEvent): BackendEvent[] {
    // 내가 stdin 으로 보낸 입력이 되돌아온 것. 다시 UI 에 올리면 중복된다.
    if (e.isReplay === true) return []
    const out: BackendEvent[] = []
    for (const c of e.message?.content ?? []) {
      if (c.type !== 'tool_result' || !c.tool_use_id) continue
      out.push({
        type: 'tool-end',
        id: c.tool_use_id,
        name: this.toolNames.get(c.tool_use_id) ?? 'unknown',
        // 성공 시에는 is_error 키 자체가 없다. 없으면 성공으로 본다.
        isError: c.is_error === true
      })
    }
    return out
  }
}

function mapStreamEvent(e: RawEvent): BackendEvent[] {
  const inner = e.event
  if (inner?.type !== 'content_block_delta') return []
  // signature_delta(thinking 서명)와 input_json_delta(툴 인자)는 화면에 보여줄 텍스트가 아니다.
  // 완성된 값은 뒤따르는 assistant 이벤트에서 온전히 받는다.
  if (inner.delta?.type !== 'text_delta') return []
  const text = inner.delta.text
  return text ? [{ type: 'text-delta', text }] : []
}

function mapResult(e: RawEvent): BackendEvent[] {
  const text = e.result ?? ''
  const out: BackendEvent[] = []
  if (e.is_error === true) {
    out.push({ type: 'error', message: text, kind: classifyError(text) })
  }
  const ev: BackendEvent = { type: 'result', text, isError: e.is_error === true }
  if (typeof e.duration_ms === 'number') ev.durationMs = e.duration_ms
  if (typeof e.total_cost_usd === 'number') ev.costUsd = e.total_cost_usd
  out.push(ev)
  return out
}

/**
 * CLI 는 실패 종류를 구조화된 코드로 주지 않고 사람이 읽는 문장으로만 준다.
 * 문자열 매칭이 불안하지만 현재로선 이게 가진 전부다. 새 문구를 만나면 여기에 추가한다.
 */
export function classifyError(message: string): BackendErrorKind {
  const m = message.toLowerCase()
  if (/oauth|authenticat|log ?in|credential|unauthorized/.test(m)) return 'auth'
  if (/rate limit|usage limit|quota|too many requests/.test(m)) return 'rate-limit'
  if (/not found|enoent|no such file/.test(m)) return 'not-found'
  return 'unknown'
}
