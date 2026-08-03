import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type {
  Diagnostics,
  PanelEvent,
  PermissionRequest,
  WaifuApi,
  WaifuConfig
} from '@shared/protocol'
import {
  INITIAL_PANEL_STATE,
  reducePanelState,
  type TranscriptItem
} from '../panel/home/panelState'
import { subscribeBeforeHydrate } from '../panel/hydration'
import './style.css'

declare global {
  interface Window {
    waifu: WaifuApi
  }
}

function visibleItems(items: TranscriptItem[]): TranscriptItem[] {
  const useful = items.filter((item) => item.kind !== 'activity' && item.text.trim())
  return useful.slice(-2)
}

function Companion(): React.JSX.Element {
  const [config, setConfig] = useState<WaifuConfig | null>(null)
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null)
  const [permission, setPermission] = useState<PermissionRequest | null>(null)
  const [input, setInput] = useState('')
  const [state, dispatch] = useReducer(reducePanelState, INITIAL_PANEL_STATE)
  const nextId = useRef(1)
  const inputRef = useRef<HTMLInputElement>(null)

  const id = (): number => {
    const value = nextId.current
    nextId.current += 1
    return value
  }

  useEffect(() => {
    const unsubscribe = subscribeBeforeHydrate(
      () =>
        window.waifu.onPanelEvent((event: PanelEvent) => {
          switch (event.type) {
            case 'backend':
              dispatch({ type: 'backend', event: event.event, showActivity: false, id: id() })
              if (
                event.event.type === 'session' ||
                event.event.type === 'result' ||
                event.event.type === 'error' ||
                event.event.type === 'exit'
              ) {
                void window.waifu.diagnostics().then(setDiagnostics)
              }
              break
            case 'notice':
              if (event.level === 'info' && event.message.startsWith('나 · ')) {
                dispatch({ type: 'user-sent', text: event.message.slice(4), id: id() })
              } else {
                dispatch({ type: 'notice', level: event.level, message: event.message, id: id() })
              }
              break
            case 'permission-request':
              setPermission(event.request)
              break
            case 'permission-resolved':
              setPermission((current) => (current?.id === event.id ? null : current))
              break
            case 'config':
              setConfig(event.config)
              break
          }
        }),
      () => {
        void Promise.all([
          window.waifu.getConfig().then(setConfig),
          window.waifu.diagnostics().then(setDiagnostics),
          window.waifu.listPendingPermissions().then((pending) => setPermission(pending[0] ?? null))
        ])
      }
    )
    const focus = window.setTimeout(() => inputRef.current?.focus(), 60)
    return () => {
      unsubscribe()
      window.clearTimeout(focus)
    }
  }, [])

  const recent = useMemo(() => visibleItems(state.items), [state.items])
  const name = config?.persona.name || '와이푸'
  const runtimeReady = Boolean(diagnostics?.runtime)

  const send = (): void => {
    const text = input.trim()
    if (!text || state.busy || permission) return
    if (!runtimeReady) {
      dispatch({
        type: 'notice',
        level: 'warn',
        message: '트레이의 관리·기록에서 함께 작업할 폴더를 먼저 골라줘.',
        id: id()
      })
      return
    }
    setInput('')
    window.waifu.sendMessage(text)
  }

  return (
    <main className="companion-shell">
      <section className="companion-card">
        <header>
          <span className={`presence ${state.busy ? 'busy' : ''}`} />
          <strong>{name}</strong>
          <span className="phase">
            {permission ? '허락을 기다리는 중' : state.action || (state.busy ? '생각하는 중' : '곁에 있어')}
          </span>
          <button className="close" aria-label="닫기" onClick={() => window.close()}>
            ×
          </button>
        </header>

        {permission ? (
          <div className="permission-card">
            <div className="permission-copy">
              <b>{permission.toolName}</b>
              <span>{permission.reason || '이 작업을 실행해도 될까?'}</span>
            </div>
            <div className="permission-actions">
              <button
                className="deny"
                onClick={() =>
                  window.waifu.respondPermission(permission.id, {
                    behavior: 'deny',
                    message: '사용자가 거절했다.'
                  })
                }
              >
                안 돼
              </button>
              <button
                className="allow"
                onClick={() =>
                  window.waifu.respondPermission(permission.id, { behavior: 'allow' })
                }
              >
                해도 돼
              </button>
            </div>
          </div>
        ) : (
          <div className="conversation" aria-live="polite">
            {recent.length === 0 ? (
              <p className="empty">무엇을 같이 할까?</p>
            ) : (
              recent.map((item) => (
                <p key={item.id} className={`${item.kind} ${item.level || ''}`}>
                  {item.text}
                </p>
              ))
            )}
          </div>
        )}

        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault()
            send()
          }}
        >
          <input
            ref={inputRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={runtimeReady ? `${name}에게 말 걸기` : '관리·기록에서 작업 폴더를 골라줘'}
            disabled={Boolean(permission)}
          />
          {state.busy ? (
            <button type="button" className="interrupt" onClick={() => window.waifu.interrupt()}>
              멈춤
            </button>
          ) : (
            <button type="submit" disabled={!input.trim() || Boolean(permission)}>
              보내기
            </button>
          )}
        </form>
        <footer>설정과 전체 기록은 트레이의 ‘관리·기록’에서 열 수 있어</footer>
      </section>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Companion />)
