import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { BackendEvent, PanelEvent, WaifuApi } from '@shared/protocol'

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
  /** 스트리밍 중인 응답은 마지막 줄에 계속 이어 붙인다. */
  const streaming = useRef(false)

  useEffect(() => {
    return window.waifu.onPanelEvent((evt: PanelEvent) => {
      if (evt.type === 'notice') {
        setLines((ls) => [...ls, { id: nextId++, who: 'system', text: evt.message }])
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
          setLines((ls) => [...ls, { id: nextId++, who: 'system', text: `… ${e.detail}` }])
          break
        case 'tool-start':
          setLines((ls) => [...ls, { id: nextId++, who: 'system', text: `⚙ ${e.name}` }])
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

  return (
    <div style={S.root}>
      <div style={S.log}>
        {lines.map((l) => (
          <div key={l.id} style={{ ...S.line, ...S.who[l.who] }}>
            {l.text}
          </div>
        ))}
      </div>
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
  log: { flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '8px' },
  line: { padding: '8px 12px', borderRadius: '10px', whiteSpace: 'pre-wrap', lineHeight: 1.5 },
  who: {
    user: { background: '#2a2740', alignSelf: 'flex-end', maxWidth: '80%' },
    waifu: { background: '#1e1c2b', alignSelf: 'flex-start', maxWidth: '90%' },
    system: { color: '#8b869e', fontSize: '13px', padding: '2px 4px' }
  },
  inputRow: { display: 'flex', gap: '8px', padding: '12px', borderTop: '1px solid #26243200' },
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
