import { useEffect, useState } from 'react'
import type { WaifuConfig } from '@shared/protocol'
import { T } from '../theme'
import { S } from './controls'
import { WaifuTab } from './tabs/WaifuTab'
import { SystemTab } from './tabs/SystemTab'
import { AvatarTab } from './tabs/AvatarTab'
import { PresenceTab } from './tabs/PresenceTab'
import { PermissionTab } from './tabs/PermissionTab'
import { VoiceTab } from './tabs/VoiceTab'
import { NotifyTab } from './tabs/NotifyTab'
import { MemoryTab } from './tabs/MemoryTab'

export type Patch = (p: Partial<WaifuConfig>) => void

export interface TabProps {
  config: WaifuConfig
  patch: Patch
}

/**
 * 왼쪽 목록 + 오른쪽 본문.
 *
 * 가로 탭 줄이었는데 항목이 일곱을 넘어가면서 좁은 창에서 가로로 스크롤되기
 * 시작했다 — 안 보이는 탭은 없는 탭이다. 세로 목록은 늘어나도 같은 자리에 있고,
 * 무엇보다 **묶음 제목을 줄 수 있다.** "와이프 / 아바타 / 프로그램" 이 갈려 있으면
 * 찾는 설정이 어느 쪽인지 대충 짐작이 간다.
 */
interface TabItem {
  id: string
  label: string
  render: (p: TabProps) => React.JSX.Element
}

interface TabGroup {
  title: string
  items: TabItem[]
}

const GROUPS: TabGroup[] = [
  {
    title: '와이프',
    items: [
      { id: 'waifu', label: '성격과 말', render: (p: TabProps) => <WaifuTab {...p} /> },
      { id: 'memory', label: '기억과 기록', render: (_p: TabProps) => <MemoryTab /> }
    ]
  },
  {
    title: '아바타',
    items: [
      { id: 'avatar', label: '모델과 창', render: (p: TabProps) => <AvatarTab {...p} /> },
      { id: 'presence', label: '존재감', render: (p: TabProps) => <PresenceTab {...p} /> },
      { id: 'voice', label: '목소리', render: (p: TabProps) => <VoiceTab {...p} /> }
    ]
  },
  {
    title: '프로그램',
    items: [
      { id: 'system', label: '백엔드와 실행', render: (p: TabProps) => <SystemTab {...p} /> },
      { id: 'permission', label: '권한과 안전', render: (p: TabProps) => <PermissionTab {...p} /> },
      { id: 'notify', label: '알림과 원격', render: (p: TabProps) => <NotifyTab {...p} /> }
    ]
  }
]

const ALL = GROUPS.flatMap((g) => g.items)

// 빈 목록이면 화면이 통째로 비어 원인을 알 수 없다. 조립 실수를 여기서 잡는다.
if (ALL.length === 0) throw new Error('설정 탭이 하나도 없다')
const FIRST = ALL[0] as TabItem

export function Settings({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [config, setConfig] = useState<WaifuConfig | null>(null)
  const [tab, setTab] = useState<string>('waifu')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void window.waifu.getConfig().then(setConfig)
  }, [])

  // Esc 로 닫는다. 설정 화면이 전체를 덮으므로 나가는 길이 버튼 하나뿐이면 답답하다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!config) return <div style={styles.loading}>불러오는 중…</div>

  const patch: Patch = (p) => {
    setSaving(true)
    void window.waifu.setConfig(p).then((next) => {
      setConfig(next)
      setSaving(false)
    })
  }

  const active = ALL.find((t) => t.id === tab) ?? FIRST

  return (
    <div className="settings-shell" style={styles.root}>
      <aside className="settings-sidebar" style={styles.sidebar}>
        <div className="settings-brand" style={styles.brand}>설정</div>
        <nav className="settings-nav" style={styles.nav} aria-label="설정 분류">
          {GROUPS.map((group) => (
            <div className="settings-group" key={group.title} style={styles.group}>
              <div className="settings-group-title" style={styles.groupTitle}>{group.title}</div>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  style={{ ...styles.navItem, ...(item.id === tab ? styles.navActive : null) }}
                  onClick={() => setTab(item.id)}
                  aria-current={item.id === tab ? 'page' : undefined}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <button className="settings-close" style={styles.close} onClick={onClose}>
          닫기
        </button>
      </aside>

      <main className="settings-main" style={styles.main}>
        <header style={styles.header}>
          <div style={styles.headerTitle}>{active.label}</div>
          {/* 저장은 자동이라 눌러야 할 버튼이 없다. 대신 저장됐다는 사실은 보여야 한다. */}
          {saving && <div role="status" style={S.hint}>저장 중…</div>}
        </header>
        <div className="settings-body" style={styles.body}>{active.render({ config, patch })}</div>
      </main>
    </div>
  )
}

const styles = {
  root: {
    display: 'flex',
    height: '100%',
    boxSizing: 'border-box',
    background: T.color.base,
    color: T.color.text,
    fontSize: T.font.body
  },
  loading: {
    display: 'grid',
    placeItems: 'center',
    height: '100%',
    color: T.color.dim,
    background: T.color.base
  },
  sidebar: {
    width: '164px',
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    background: T.color.raised,
    borderRight: `1px solid ${T.color.line}`,
    padding: `${T.space(3)} ${T.space(2)}`,
    boxSizing: 'border-box'
  },
  brand: {
    fontSize: T.font.title,
    fontWeight: 600,
    padding: `0 ${T.space(2)} ${T.space(3)}`
  },
  nav: { flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: T.space(4) },
  group: { display: 'flex', flexDirection: 'column', gap: '2px' },
  groupTitle: {
    color: T.color.dim,
    fontSize: '11px',
    letterSpacing: '0.08em',
    padding: `0 ${T.space(2)} ${T.space(1)}`
  },
  navItem: {
    background: 'transparent',
    color: T.color.dim,
    border: 0,
    borderRadius: T.radius.md,
    padding: `${T.space(2)} ${T.space(2)}`,
    textAlign: 'left',
    cursor: 'pointer',
    font: 'inherit',
    fontSize: T.font.body
  },
  navActive: { background: T.color.high, color: T.color.text },
  close: {
    marginTop: T.space(3),
    background: 'transparent',
    color: T.color.dim,
    border: `1px solid ${T.color.line}`,
    borderRadius: T.radius.md,
    padding: `${T.space(1)} ${T.space(2)}`,
    cursor: 'pointer',
    font: 'inherit',
    fontSize: T.font.small
  },
  main: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: `${T.space(4)} ${T.space(5)} ${T.space(3)}`,
    borderBottom: `1px solid ${T.color.line}`
  },
  headerTitle: { fontSize: T.font.title, fontWeight: 600 },
  body: { flex: 1, overflowY: 'auto', padding: T.space(5) }
} satisfies Record<string, React.CSSProperties>
