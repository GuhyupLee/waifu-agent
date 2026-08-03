import type { BackendEvent, PanelEvent, PermissionRequest } from '@shared/protocol'

export type NoticeLevel = Extract<PanelEvent, { type: 'notice' }>['level']
export type PanelPhase = 'idle' | 'thinking' | 'working' | 'responding' | 'permission' | 'error'

export interface TranscriptItem {
  id: number
  kind: 'user' | 'waifu' | 'activity' | 'notice'
  text: string
  level?: NoticeLevel
  streaming?: boolean
}

export interface PanelState {
  items: TranscriptItem[]
  busy: boolean
  phase: PanelPhase
  action: string | null
  streamingLineId: number | null
  turnHasResponse: boolean
  permissionId: string | null
  activeTools: Record<string, string>
}

export const INITIAL_PANEL_STATE: PanelState = {
  items: [],
  busy: false,
  phase: 'idle',
  action: null,
  streamingLineId: null,
  turnHasResponse: false,
  permissionId: null,
  activeTools: {}
}

export function enqueuePermission(
  queue: PermissionRequest[],
  request: PermissionRequest
): PermissionRequest[] {
  return queue.some((item) => item.id === request.id) ? queue : [...queue, request]
}

export function removePermission(queue: PermissionRequest[], id: string): PermissionRequest[] {
  return queue.filter((request) => request.id !== id)
}

export type PanelAction =
  | { type: 'user-sent'; text: string; id: number }
  | { type: 'backend'; event: BackendEvent; id: number; showActivity: boolean }
  | { type: 'notice'; message: string; level: NoticeLevel; id: number }
  | { type: 'permission-current'; id: string | null }
  | { type: 'interrupted' }

const MAX_TRANSCRIPT_ITEMS = 300

function append(items: TranscriptItem[], item: TranscriptItem): TranscriptItem[] {
  const next = [...items, item]
  return next.length > MAX_TRANSCRIPT_ITEMS ? next.slice(-MAX_TRANSCRIPT_ITEMS) : next
}

function finishStreaming(items: TranscriptItem[], lineId: number | null): TranscriptItem[] {
  if (lineId === null) return items
  return items.map((item) =>
    item.id === lineId && item.kind === 'waifu' ? { ...item, streaming: false } : item
  )
}

function readableToolAction(name: string): string {
  const known: Readonly<Record<string, string>> = {
    Read: '파일을 읽는 중',
    Glob: '파일을 찾는 중',
    Grep: '코드를 살펴보는 중',
    Edit: '파일을 고치는 중',
    Write: '파일을 쓰는 중',
    NotebookRead: '노트북을 읽는 중',
    NotebookEdit: '노트북을 고치는 중',
    WebFetch: '웹페이지를 읽는 중',
    WebSearch: '웹에서 찾는 중',
    Task: '작업을 나누는 중',
    TodoWrite: '할 일을 정리하는 중',
    Bash: '명령을 실행하는 중',
    shell: '명령을 실행하는 중'
  }
  return known[name] ?? `${name} 작업 중`
}

function readableToolName(name: string): string {
  const known: Readonly<Record<string, string>> = {
    Read: '파일 읽기',
    Glob: '파일 찾기',
    Grep: '내용 검색',
    Edit: '파일 수정',
    Write: '파일 쓰기',
    NotebookRead: '노트북 읽기',
    NotebookEdit: '노트북 수정',
    WebFetch: '웹페이지 읽기',
    WebSearch: '웹 검색',
    Task: '하위 작업',
    TodoWrite: '할 일 정리',
    Bash: '명령 실행',
    shell: '명령 실행'
  }
  return known[name] ?? name
}

function applyTextDelta(state: PanelState, text: string, id: number): PanelState {
  const activeId = state.streamingLineId
  if (activeId !== null && state.items.some((item) => item.id === activeId)) {
    return {
      ...state,
      items: state.items.map((item) =>
        item.id === activeId && item.kind === 'waifu'
          ? { ...item, text: item.text + text, streaming: true }
          : item
      ),
      busy: true,
      phase: 'responding',
      action: '답을 정리하는 중',
      turnHasResponse: true
    }
  }

  return {
    ...state,
    items: append(state.items, { id, kind: 'waifu', text, streaming: true }),
    busy: true,
    phase: 'responding',
    action: '답을 정리하는 중',
    streamingLineId: id,
    turnHasResponse: true
  }
}

function applyCompleteText(state: PanelState, text: string, id: number): PanelState {
  const activeId = state.streamingLineId
  if (activeId !== null && state.items.some((item) => item.id === activeId)) {
    return {
      ...state,
      items: state.items.map((item) =>
        item.id === activeId && item.kind === 'waifu'
          ? { ...item, text, streaming: false }
          : item
      ),
      busy: true,
      phase: 'responding',
      action: '답을 마무리하는 중',
      streamingLineId: null,
      turnHasResponse: true
    }
  }

  const lastReply = [...state.items].reverse().find((item) => item.kind === 'waifu')
  const items = state.turnHasResponse && lastReply?.text === text
    ? state.items
    : append(state.items, { id, kind: 'waifu', text, streaming: false })
  return {
    ...state,
    items,
    busy: true,
    phase: 'responding',
    action: '답을 마무리하는 중',
    streamingLineId: null,
    turnHasResponse: true
  }
}

function applyBackendEvent(
  state: PanelState,
  event: BackendEvent,
  id: number,
  showActivity: boolean
): PanelState {
  switch (event.type) {
    case 'session':
      return state.busy ? state : { ...state, phase: 'idle', action: null }

    case 'text-delta':
      return applyTextDelta(state, event.text, id)

    case 'text':
      return applyCompleteText(state, event.text, id)

    case 'thinking':
      return {
        ...state,
        busy: true,
        phase: 'thinking',
        action: '어디서부터 볼지 정리하는 중'
      }

    case 'tool-start': {
      const next = {
        ...state,
        busy: true,
        phase: 'working' as const,
        action: readableToolAction(event.name),
        activeTools: { ...state.activeTools, [event.id]: event.name }
      }
      if (!showActivity) return next
      return {
        ...next,
        items: append(next.items, { id, kind: 'activity', text: `${readableToolName(event.name)} · 시작` })
      }
    }

    case 'tool-end': {
      const activeTools = { ...state.activeTools }
      delete activeTools[event.id]
      const next: PanelState = {
        ...state,
        // 툴 하나의 실패는 턴 종료가 아니다. 모델이 다른 방법을 찾거나 실패를 설명할 수
        // 있으므로 result/error가 올 때까지 중단 버튼과 작업 상태를 유지한다.
        busy: state.busy,
        phase: 'working',
        action: event.isError
          ? `${readableToolName(event.name)}에서 막혀 다른 방법을 찾는 중`
          : '결과를 확인하는 중',
        activeTools
      }
      if (!showActivity) return next
      return {
        ...next,
        items: append(next.items, {
          id,
          kind: 'activity',
          text: `${readableToolName(event.name)} · ${event.isError ? '실패' : '완료'}`
        })
      }
    }

    case 'activity': {
      const next = {
        ...state,
        busy: true,
        phase: 'working' as const,
        action: event.detail
      }
      if (!showActivity) return next
      return {
        ...next,
        items: append(next.items, { id, kind: 'activity', text: event.detail })
      }
    }

    case 'rate-limit':
      return event.info.status === 'allowed'
        ? state
        : { ...state, phase: 'error', action: '사용량 한도로 잠시 멈췄어' }

    case 'error':
      return {
        ...state,
        items: append(finishStreaming(state.items, state.streamingLineId), {
          id,
          kind: 'notice',
          text: event.message,
          level: 'error'
        }),
        busy: false,
        phase: 'error',
        action: '여기서 멈췄어',
        streamingLineId: null,
        activeTools: {}
      }

    case 'result': {
      let items = finishStreaming(state.items, state.streamingLineId)
      if (!event.isError && event.text.trim() && !state.turnHasResponse) {
        items = append(items, { id, kind: 'waifu', text: event.text, streaming: false })
      }
      return {
        ...state,
        items,
        busy: false,
        phase: event.isError ? 'error' : 'idle',
        action: event.isError ? '여기서 멈췄어' : null,
        streamingLineId: null,
        turnHasResponse: false,
        activeTools: {}
      }
    }

    case 'exit':
      return event.code === 0
        ? {
            ...state,
            items: finishStreaming(state.items, state.streamingLineId),
            busy: false,
            phase: 'idle',
            action: null,
            streamingLineId: null,
            activeTools: {}
          }
        : {
            ...state,
            items: append(
              finishStreaming(state.items, state.streamingLineId),
              {
                id,
                kind: 'notice',
                level: 'error',
                text: `백엔드가 예기치 않게 종료됐다 (코드 ${event.code ?? '없음'}).`
              }
            ),
            busy: false,
            phase: 'error',
            action: '연결이 끊겼어',
            streamingLineId: null,
            activeTools: {}
          }
  }
}

export function reducePanelState(state: PanelState, action: PanelAction): PanelState {
  switch (action.type) {
    case 'user-sent':
      return {
        ...state,
        items: append(finishStreaming(state.items, state.streamingLineId), {
          id: action.id,
          kind: 'user',
          text: action.text
        }),
        busy: true,
        phase: 'thinking',
        action: '어디서부터 볼지 정리하는 중',
        streamingLineId: null,
        turnHasResponse: false
      }

    case 'backend':
      return applyBackendEvent(state, action.event, action.id, action.showActivity)

    case 'notice':
      return {
        ...state,
        items: append(state.items, {
          id: action.id,
          kind: 'notice',
          text: action.message,
          level: action.level
        })
      }

    case 'permission-current':
      return action.id
        ? {
            ...state,
            phase: 'permission',
            action: '네 확인을 기다리는 중',
            permissionId: action.id
          }
        : {
            ...state,
            phase: state.busy ? 'thinking' : 'idle',
            action: state.busy ? '결정을 반영하는 중' : null,
            permissionId: null
          }

    case 'interrupted':
      return {
        ...state,
        items: finishStreaming(state.items, state.streamingLineId),
        busy: false,
        phase: 'idle',
        action: '멈췄어',
        streamingLineId: null,
        activeTools: {}
      }
  }
}
