import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { BackendEvent, PanelEvent, PermissionRequest, WaifuApi } from '@shared/protocol'
import { Settings } from './settings/Settings'

declare global {
  interface Window {
    waifu: WaifuApi
  }
}

interface Line {
  id: number
  who: 'user' | 'waifu' | 'system'
  text: string
}

let nextId = 0

function Panel(): React.JSX.Element {
  const [lines, setLines] = useState<Line[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  /** 승인 대기 중인 요청. 훅이 응답을 기다리며 툴 실행을 붙잡고 있다. */
  const [permission, setPermission] = useState<PermissionRequest | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  /**
   * 작업 기록을 대화에 섞을지. 설정에서 끄면 대화만 남는다.
   * ref 가 아니라 state 로 두면 이벤트 핸들러가 옛 값을 붙잡는다 — 구독은 한 번만 걸린다.
   */
  const showActivity = useRef(true)

  useEffect(() => {
    void window.waifu.getConfig().then((c) => (showActivity.current = c.chat.showActivity))
  }, [showSettings])
  /** 스트리밍 중인 응답은 마지막 줄에 계속 이어 붙인다. */
  const streaming = useRef(false)

  useEffect(() => {
    return window.waifu.onPanelEvent((evt: PanelEvent) => {
      if (evt.type === 'notice') {
        setLines((ls) => [...ls, { id: nextId++, who: 'system', text: evt.message }])
        return
      }
      if (evt.type === 'permission-request') {
        setPermission(evt.request)
        return
      }
      if (evt.type === 'permission-resolved') {
        setPermission((p) => (p?.id === evt.id ? null : p))
        return
      }
      if (evt.type !== 'backend') return
      applyBackendEvent(evt.event)
    })

    function applyBackendEvent(e: BackendEvent): void {
      switch (e.type) {
        case 'text-delta':
          setLines((ls) => {
            if (!streaming.current) {
              streaming.current = true
              return [...ls, { id: nextId++, who: 'waifu', text: e.text }]
            }
            const last = ls[ls.length - 1]
            if (!last) return [...ls, { id: nextId++, who: 'waifu', text: e.text }]
            return [...ls.slice(0, -1), { ...last, text: last.text + e.text }]
          })
          break
        case 'activity':
          if (showActivity.current) {
            setLines((ls) => [...ls, { id: nextId++, who: 'system', text: `… ${e.detail}` }])
          }
          break
        case 'tool-start':
          if (showActivity.current) {
            setLines((ls) => [...ls, { id: nextId++, who: 'system', text: `⚙ ${e.name}` }])
          }
          break
        case 'error':
          setLines((ls) => [...ls, { id: nextId++, who: 'system', text: `⚠ ${e.message}` }])
          break
        case 'result':
          streaming.current = false
          setBusy(false)
          break
        default:
          break
      }
    }
  }, [])

  const send = (): void => {
    const text = input.trim()
    if (!text || busy) return
    setLines((ls) => [...ls, { id: nextId++, who: 'user', text }])
    setInput('')
    setBusy(true)
    streaming.current = false
    window.waifu.sendMessage(text)
  }

  if (showSettings) return <Settings onClose={() => setShowSettings(false)} />

  return (
    <div style={S.root}>
      <div style={S.topbar}>
        <button style={S.iconButton} onClick={() => setShowSettings(true)} title="설정">
          설정
        </button>
      </div>
      <div style={S.log}>
        {lines.map((l) => (
          <div key={l.id} style={{ ...S.line, ...S.who[l.who] }}>
            {l.text}
          </div>
        ))}
      </div>
      {permission && (
        <div style={S.permission}>
          <div style={S.permTitle}>
            <b>{permission.toolName}</b> 실행을 허락할까?
          </div>
          {permission.reason && <div style={S.permReason}>{permission.reason}</div>}
          <pre style={S.permInput}>{JSON.stringify(permission.input, null, 2)}</pre>
          <div style={S.permButtons}>
            <button
              style={{ ...S.button, background: '#3a3750' }}
              onClick={() => {
                window.waifu.respondPermission(permission.id, {
                  behavior: 'deny',
                  message: '사용자가 거부했다.'
                })
                setPermission(null)
              }}
            >
              거부
            </button>
            <button
              style={S.button}
              onClick={() => {
                window.waifu.respondPermission(permission.id, { behavior: 'allow' })
                setPermission(null)
              }}
            >
              허락
            </button>
          </div>
        </div>
      )}
      <div style={S.inputRow}>
        <textarea
          style={S.textarea}
          value={input}
          placeholder="유로실라 유니아에게 말 걸기…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Enter 로 보내고 Shift+Enter 로 줄바꿈. 채팅에서 기대되는 동작이다.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        <button style={S.button} onClick={busy ? () => window.waifu.interrupt() : send}>
          {busy ? '중단' : '보내기'}
        </button>
      </div>
    </div>
  )
}

const S = {
  root: { display: 'flex', flexDirection: 'column', height: '100%' },
  topbar: { display: 'flex', justifyContent: 'flex-end', padding: '8px 12px 0' },
  iconButton: {
    background: 'transparent',
    color: '#8b869e',
    border: '1px solid #322f45',
    borderRadius: '8px',
    padding: '3px 10px',
    cursor: 'pointer',
    font: 'inherit',
    fontSize: '12px'
  },
  log: { flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '8px' },
  line: { padding: '8px 12px', borderRadius: '10px', whiteSpace: 'pre-wrap', lineHeight: 1.5 },
  who: {
    user: { background: '#2a2740', alignSelf: 'flex-end', maxWidth: '80%' },
    waifu: { background: '#1e1c2b', alignSelf: 'flex-start', maxWidth: '90%' },
    system: { color: '#8b869e', fontSize: '13px', padding: '2px 4px' }
  },
  permission: {
    margin: '0 12px',
    padding: '12px',
    borderRadius: '12px',
    background: '#241f33',
    border: '1px solid #4a3f6b'
  },
  permTitle: { marginBottom: '6px' },
  permReason: { color: '#b9b3cc', fontSize: '13px', marginBottom: '8px' },
  permInput: {
    margin: '0 0 10px',
    padding: '8px',
    borderRadius: '8px',
    background: '#15131f',
    fontSize: '12px',
    maxHeight: '160px',
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all'
  },
  permButtons: { display: 'flex', gap: '8px', justifyContent: 'flex-end' },
  inputRow: { display: 'flex', gap: '8px', padding: '12px', borderTop: '1px solid #262432' },
  textarea: {
    flex: 1,
    resize: 'none',
    height: '64px',
    background: '#1e1c2b',
    color: 'inherit',
    border: '1px solid #322f45',
    borderRadius: '10px',
    padding: '10px',
    font: 'inherit'
  },
  button: {
    background: '#5a4fcf',
    color: '#fff',
    border: 0,
    borderRadius: '10px',
    padding: '0 18px',
    cursor: 'pointer',
    font: 'inherit'
  }
} satisfies Record<string, React.CSSProperties | Record<string, React.CSSProperties>>

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('#root 를 찾을 수 없다')
createRoot(rootEl).render(
  <StrictMode>
    <Panel />
  </StrictMode>
)
