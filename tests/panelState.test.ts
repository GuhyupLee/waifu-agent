import { describe, expect, it } from 'vitest'
import type { BackendEvent } from '../src/shared/protocol'
import {
  enqueuePermission,
  INITIAL_PANEL_STATE,
  removePermission,
  reducePanelState,
  type PanelAction,
  type PanelState
} from '../src/renderer/panel/home/panelState'

function reduce(actions: PanelAction[]): PanelState {
  return actions.reduce(reducePanelState, INITIAL_PANEL_STATE)
}

function backend(event: BackendEvent, id: number, showActivity = true): PanelAction {
  return { type: 'backend', event, id, showActivity }
}

describe('panelState 대화와 활동 기록', () => {
  it('스트림 사이에 activity가 끼어도 답변 줄에 이어 붙인다', () => {
    const state = reduce([
      { type: 'user-sent', text: '봐줘', id: 1 },
      backend({ type: 'text-delta', text: '앞', }, 2),
      backend({ type: 'activity', detail: '파일을 읽는 중' }, 3),
      backend({ type: 'text-delta', text: '뒤' }, 4)
    ])

    expect(state.items).toEqual([
      { id: 1, kind: 'user', text: '봐줘' },
      { id: 2, kind: 'waifu', text: '앞뒤', streaming: true },
      { id: 3, kind: 'activity', text: '파일을 읽는 중' }
    ])
  })

  it('Claude의 delta 뒤 완성 text는 같은 답변을 교체하고 중복하지 않는다', () => {
    const state = reduce([
      { type: 'user-sent', text: '안녕', id: 1 },
      backend({ type: 'text-delta', text: '안' }, 2),
      backend({ type: 'text-delta', text: '녕' }, 3),
      backend({ type: 'text', text: '안녕' }, 4)
    ])

    expect(state.items.filter((item) => item.kind === 'waifu')).toEqual([
      { id: 2, kind: 'waifu', text: '안녕', streaming: false }
    ])
    expect(state.streamingLineId).toBeNull()
  })

  it('Codex의 완성 text만 와도 답변으로 표시한다', () => {
    const state = reduce([
      { type: 'user-sent', text: '끝내줘', id: 1 },
      backend({ type: 'text', text: '완료했어.' }, 2),
      backend({ type: 'result', text: '완료했어.', isError: false }, 3)
    ])

    expect(state.items.filter((item) => item.kind === 'waifu')).toHaveLength(1)
    expect(state.items[1]?.text).toBe('완료했어.')
    expect(state.busy).toBe(false)
  })

  it('같은 답을 다음 턴에 다시 해도 새 대화로 남긴다', () => {
    const state = reduce([
      { type: 'user-sent', text: '첫 번째', id: 1 },
      backend({ type: 'text', text: '알겠어.' }, 2),
      backend({ type: 'result', text: '알겠어.', isError: false }, 3),
      { type: 'user-sent', text: '두 번째', id: 4 },
      backend({ type: 'text', text: '알겠어.' }, 5)
    ])

    expect(state.items.filter((item) => item.kind === 'waifu')).toHaveLength(2)
  })

  it('별도 text 이벤트가 없으면 result 본문을 마지막 fallback으로 쓴다', () => {
    const state = reduce([
      { type: 'user-sent', text: '요청', id: 1 },
      backend({ type: 'result', text: '결과', isError: false }, 2)
    ])
    expect(state.items.at(-1)).toEqual({ id: 2, kind: 'waifu', text: '결과', streaming: false })
  })

  it('notice의 info/warn/error 수준을 보존한다', () => {
    const state = reduce([
      { type: 'notice', level: 'info', message: '정보', id: 1 },
      { type: 'notice', level: 'warn', message: '경고', id: 2 },
      { type: 'notice', level: 'error', message: '오류', id: 3 }
    ])
    expect(state.items.map((item) => item.level)).toEqual(['info', 'warn', 'error'])
  })

  it('error와 비정상 exit는 busy를 끝내고 오류 상태를 남긴다', () => {
    const afterError = reduce([
      { type: 'user-sent', text: '요청', id: 1 },
      backend({ type: 'text-delta', text: '쓰는 중', }, 2),
      backend({ type: 'error', message: '실패', kind: 'unknown' }, 3)
    ])
    expect(afterError.busy).toBe(false)
    expect(afterError.phase).toBe('error')
    expect(afterError.items.find((item) => item.kind === 'waifu')?.streaming).toBe(false)

    const afterExit = reduce([
      { type: 'user-sent', text: '요청', id: 1 },
      backend({ type: 'exit', code: 7 }, 2)
    ])
    expect(afterExit.busy).toBe(false)
    expect(afterExit.items.at(-1)?.level).toBe('error')
  })

  it('툴 하나가 실패해도 턴이 끝날 때까지 busy와 중단 버튼 상태를 유지한다', () => {
    const state = reduce([
      { type: 'user-sent', text: '다른 방법도 찾아봐', id: 1 },
      backend({ type: 'tool-start', id: 'tool-1', name: 'Read', input: {} }, 2),
      backend({ type: 'tool-end', id: 'tool-1', name: 'Read', isError: true }, 3)
    ])
    expect(state.busy).toBe(true)
    expect(state.phase).toBe('working')
    expect(state.action).toContain('다른 방법')
  })

  it('도구 이름을 활동 기록과 상세 상태 모두 한국어로 보여준다', () => {
    const state = reduce([
      backend({ type: 'tool-start', id: 'tool-1', name: 'NotebookEdit', input: {} }, 1),
      backend({ type: 'tool-end', id: 'tool-1', name: 'NotebookEdit', isError: true }, 2)
    ])

    expect(state.items.map((item) => item.text)).toEqual([
      '노트북 수정 · 시작',
      '노트북 수정 · 실패'
    ])
    expect(state.action).toBe('노트북 수정에서 막혀 다른 방법을 찾는 중')
  })

  it('현재 permission id와 일치할 때만 확인 대기를 닫는다', () => {
    const open = reduce([{ type: 'permission-current', id: 'p1' }])
    expect(open.permissionId).toBe('p1')
    const next = reducePanelState(open, { type: 'permission-current', id: 'p2' })
    expect(next.permissionId).toBe('p2')
    const closed = reducePanelState(next, { type: 'permission-current', id: null })
    expect(closed.permissionId).toBeNull()
  })

  it('병렬 permission 요청을 덮지 않고 ID 순서대로 보관한다', () => {
    const first = { id: 'p1', toolName: 'Read', input: {} }
    const second = { id: 'p2', toolName: 'Write', input: {} }
    const queued = enqueuePermission(enqueuePermission([], first), second)
    expect(queued.map((request) => request.id)).toEqual(['p1', 'p2'])
    expect(enqueuePermission(queued, first)).toBe(queued)
    expect(removePermission(queued, 'p1').map((request) => request.id)).toEqual(['p2'])
  })
})
