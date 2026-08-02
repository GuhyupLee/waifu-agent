import { useEffect, useState } from 'react'
import type { WaifuConfig } from '@shared/protocol'
import { S } from './controls'
import { GeneralTab } from './tabs/GeneralTab'
import { AvatarTab } from './tabs/AvatarTab'
import { PermissionTab } from './tabs/PermissionTab'
import { VoiceTab } from './tabs/VoiceTab'
import { NotifyTab } from './tabs/NotifyTab'
import { MemoryTab } from './tabs/MemoryTab'

/**
 * 설정을 한 화면에 다 쌓으면 스크롤만 길어지고 원하는 걸 못 찾는다.
 * 성격이 다른 것끼리 탭으로 나눈다.
 */

export type Patch = (p: Partial<WaifuConfig>) => void

export interface TabProps {
  config: WaifuConfig
  patch: Patch
}

const TABS = [
  { id: 'general', label: '일반', render: (p: TabProps) => <GeneralTab {...p} /> },
  { id: 'avatar', label: '아바타', render: (p: TabProps) => <AvatarTab {...p} /> },
  { id: 'permission', label: '권한', render: (p: TabProps) => <PermissionTab {...p} /> },
  { id: 'voice', label: '음성', render: (p: TabProps) => <VoiceTab {...p} /> },
  { id: 'notify', label: '알림·원격', render: (p: TabProps) => <NotifyTab {...p} /> },
  // 기억·루틴은 config 가 아니라 저장소를 직접 읽으므로 props 가 없다.
  { id: 'memory', label: '기억·기록', render: (_p: TabProps) => <MemoryTab /> }
] as const

export function Settings({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [config, setConfig] = useState<WaifuConfig | null>(null)
  const [tab, setTab] = useState<string>('general')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void window.waifu.getConfig().then(setConfig)
  }, [])

  if (!config) return <div style={root}>불러오는 중…</div>

  const patch: Patch = (p) => {
    setSaving(true)
    void window.waifu.setConfig(p).then((next) => {
      setConfig(next)
      setSaving(false)
    })
  }

  const active = TABS.find((t) => t.id === tab) ?? TABS[0]

  return (
    <div style={root}>
      <div style={header}>
        <b>설정</b>
        <div style={S.row}>
          {saving && <span style={S.hint}>저장 중…</span>}
          <button style={S.ghost} onClick={onClose}>
            닫기
          </button>
        </div>
      </div>

      <div style={tabBar}>
        {TABS.map((t) => (
          <button
            key={t.id}
            style={{ ...tabButton, ...(t.id === tab ? tabActive : {}) }}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div style={body}>{active.render({ config, patch })}</div>
    </div>
  )
}

const root: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  boxSizing: 'border-box'
}

const header: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '14px 16px 10px'
}

const tabBar: React.CSSProperties = {
  display: 'flex',
  gap: '4px',
  padding: '0 12px',
  borderBottom: '1px solid #262432',
  // 탭이 좁은 창에서 줄바꿈되면 본문이 밀린다. 가로 스크롤이 낫다.
  overflowX: 'auto',
  flexShrink: 0
}

const tabButton: React.CSSProperties = {
  background: 'transparent',
  color: '#8b869e',
  border: 0,
  borderBottom: '2px solid transparent',
  padding: '8px 10px',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: '13px',
  whiteSpace: 'nowrap'
}

const tabActive: React.CSSProperties = {
  color: '#e8e6f0',
  borderBottomColor: '#5a4fcf'
}

const body: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '16px'
}
