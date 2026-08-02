/**
 * Codex `exec --json` 이벤트를 앱 공용 `BackendEvent` 로 옮긴다.
 *
 * 타입은 실제 캡처(`tests/fixtures/codex-exec.jsonl`)에서 나온 것만 적었다.
 * 스키마가 의심되면 `codex exec --json ... 2>$null` 로 다시 뜬다 —
 * **stderr 를 섞지 마라.** rmcp 트랜스포트 에러 같은 비 JSON 로그가 stdout 에 끼어든다.
 *
 * Claude Code 와 다른 점:
 *  - 스트리밍 텍스트 델타가 없다. `agent_message` 는 완성된 상태로 한 번에 온다.
 *  - 세션 키가 `session_id` 가 아니라 `thread.started.thread_id` 다.
 *  - `item.completed` 의 `type: "error"` 가 **치명적이지 않을 수 있다.**
 *    실제로 "Under-development features enabled" 같은 경고가 이 형태로 온다.
 *    이걸 전부 실패로 처리하면 매 턴이 실패로 보인다. 턴의 성패는 `turn.completed`
 *    도착 여부와 프로세스 종료 코드로 판단한다.
 */
import type { BackendEvent } from '@shared/protocol'
import { classifyError } from './claudeEvents'

interface CodexItem {
  id?: string
  type?: string
  /** agent_message */
  text?: string
  /** error */
  message?: string
  /** command_execution */
  command?: string
  aggregated_output?: string
  exit_code?: number | null
  status?: string
}

interface CodexEvent {
  type?: string
  thread_id?: string
  item?: CodexItem
  usage?: Record<string, number>
  message?: string
  error?: string | { message?: string }
}

export class CodexEventMapper {
  private lastText = ''
  private turnCompleted = false
  private turnFailure: string | null = null

  /** 마지막 assistant 발화. Codex 는 result 이벤트에 본문을 싣지 않는다. */
  get resultText(): string {
    return this.lastText
  }

  get sawTurnCompleted(): boolean {
    return this.turnCompleted
  }

  get turnFailureMessage(): string | null {
    return this.turnFailure
  }

  map(raw: unknown): BackendEvent[] {
    if (!raw || typeof raw !== 'object') return []
    const e = raw as CodexEvent

    switch (e.type) {
      case 'thread.started':
        return e.thread_id
          ? [{ type: 'session', sessionId: e.thread_id, backend: 'codex' }]
          : []

      case 'item.started':
        return this.mapItem(e.item, false)

      case 'item.completed':
        return this.mapItem(e.item, true)

      case 'turn.completed':
        this.turnCompleted = true
        // 프로세스 종료 코드까지 0이어야 성공이다. close 전에는 확정하지 않는다.
        return []

      // 실패 result도 close에서 한 번만 낸다. 여기서 내면 비정상 종료 때 중복된다.
      case 'turn.failed': {
        const nested = typeof e.error === 'object' ? e.error?.message : e.error
        this.turnFailure = nested ?? e.message ?? (this.lastText || 'Codex 턴이 실패했다')
        return []
      }

      default:
        return []
    }
  }

  private mapItem(item: CodexItem | undefined, completed: boolean): BackendEvent[] {
    if (!item?.type) return []

    switch (item.type) {
      case 'agent_message': {
        if (!completed || !item.text) return []
        this.lastText = item.text
        return [{ type: 'text', text: item.text }]
      }

      case 'command_execution': {
        const id = item.id ?? 'unknown'
        if (!completed) {
          return [{ type: 'tool-start', id, name: 'shell', input: item.command ?? '' }]
        }
        return [
          { type: 'tool-end', id, name: 'shell', isError: (item.exit_code ?? 0) !== 0 }
        ]
      }

      case 'error': {
        if (!completed || !item.message) return []
        // 경고인지 진짜 실패인지 여기서는 알 수 없다. 사용자에게는 보이되
        // 턴을 실패로 만들지는 않는다. 성패는 turn.completed 와 종료 코드가 정한다.
        return [{ type: 'activity', detail: item.message, category: 'codex-error' }]
      }

      // reasoning, file_change, mcp_tool_call 등은 아직 캡처하지 못했다.
      // 모르는 타입을 버리는 대신 활동으로 흘려 사용자가 뭔가 일어났음을 알게 한다.
      default: {
        if (!completed) return []
        const detail = item.text ?? item.message ?? item.type
        return [{ type: 'activity', detail, category: item.type }]
      }
    }
  }
}

/** 프로세스가 비정상 종료했을 때 남길 이벤트. 턴 성패의 최종 판정이다. */
export function codexExitEvents(code: number | null, stderr: string): BackendEvent[] {
  if (code === 0) return []
  const message = stderr.trim().slice(-400) || `codex 가 종료 코드 ${code} 로 끝났다`
  return [
    { type: 'error', message, kind: classifyError(message) },
    { type: 'result', text: '', isError: true }
  ]
}

/**
 * 프로세스 종료와 turn.completed를 함께 본 최종 판정.
 *
 * 종료 코드 0만으로 성공 처리하면 stdout이 중간에 잘리거나 CLI가 계약을 바꾼 경우를 정상
 * 완료로 오인한다. Codex 턴은 `turn.completed`와 정상 종료가 모두 있어야 성공이다.
 */
export function codexCompletionEvents(
  code: number | null,
  stderr: string,
  sawTurnCompleted: boolean,
  partialText: string,
  turnFailureMessage: string | null = null
): BackendEvent[] {
  const exitEvents = codexExitEvents(code, stderr)
  if (exitEvents.length > 0) return exitEvents

  if (turnFailureMessage !== null) {
    const message = turnFailureMessage || 'Codex 턴이 실패했다'
    return [
      { type: 'error', message, kind: classifyError(message) },
      { type: 'result', text: partialText, isError: true }
    ]
  }

  if (sawTurnCompleted) {
    return [{ type: 'result', text: partialText, isError: false }]
  }

  const message = 'codex가 정상 종료했지만 turn.completed 이벤트를 보내지 않았다'
  return [
    { type: 'error', message, kind: 'unknown' },
    { type: 'result', text: partialText, isError: true }
  ]
}

/** spawn 자체가 실패해도 소비자가 작업을 종료 상태로 옮길 수 있게 terminal result를 함께 낸다. */
export function codexSpawnErrorEvents(cause: string): BackendEvent[] {
  const message = `실행 실패: ${cause}`
  return [
    { type: 'error', message, kind: 'not-found' },
    { type: 'result', text: '', isError: true }
  ]
}
