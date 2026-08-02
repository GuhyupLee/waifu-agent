import { useEffect, useState } from 'react'
import type { BackendKind, FileChange, PermissionMode, WaifuConfig } from '@shared/protocol'

/**
 * 권한 모드는 UI 에서 친숙한 이름으로 보여준다. 내부 값은 그대로 두고 표시만 바꾼다.
 * `dontAsk` / `acceptEdits` 같은 이름을 사용자에게 그대로 보여줄 이유가 없다.
 */
const PERMISSION_LABELS: Record<PermissionMode, { name: string; desc: string }> = {
  readonly: { name: '대화만 하기', desc: '파일을 바꾸지 않는다. 읽고 답하기만 한다.' },
  guarded: { name: '도와주기', desc: '바꾸기 전에 반드시 확인한다.' },
  auto: { name: '맡겨두기', desc: '허용한 폴더 안에서 묻지 않고 작업한다.' }
}

const BACKEND_LABELS: Record<BackendKind, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex'
}

export function Settings({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [config, setConfig] = useState<WaifuConfig | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void window.waifu.getConfig().then(setConfig)
  }, [])

  if (!config) return <div style={S.root}>불러오는 중…</div>

  const patch = (p: Partial<WaifuConfig>): void => {
    setSaving(true)
    void window.waifu.setConfig(p).then((next) => {
      setConfig(next)
      setSaving(false)
    })
  }

  return (
    <div style={S.root}>
      <div style={S.header}>
        <b>설정</b>
        <button style={S.close} onClick={onClose}>
          닫기
        </button>
      </div>

      <Section title="권한">
        {(Object.keys(PERMISSION_LABELS) as PermissionMode[]).map((mode) => (
          <label key={mode} style={S.radio}>
            <input
              type="radio"
              checked={config.permission.mode === mode}
              onChange={() => patch({ permission: { ...config.permission, mode } })}
            />
            <span>
              <b>{PERMISSION_LABELS[mode].name}</b>
              <div style={S.hint}>{PERMISSION_LABELS[mode].desc}</div>
            </span>
          </label>
        ))}
        {config.permission.mode === 'auto' && (
          <div style={S.warn}>
            묻지 않고 실행한다. 허용 폴더를 좁게 잡아두는 걸 권한다.
          </div>
        )}
        {config.backend.active === 'codex' && config.permission.mode === 'guarded' && (
          // 같은 이름이라도 통제 강도가 다르다. 숨기면 사용자가 오해한다.
          <div style={S.warn}>
            Codex 에는 툴마다 물어보는 경로가 없다. 샌드박스로만 막으므로 Claude Code 보다 헐겁다.
          </div>
        )}
        <Field
          label="작업 허용 폴더 (줄바꿈으로 구분)"
          multiline
          value={config.permission.workspaces.join('\n')}
          onCommit={(v) =>
            patch({
              permission: {
                ...config.permission,
                workspaces: v.split('\n').map((s) => s.trim()).filter(Boolean)
              }
            })
          }
        />
      </Section>

      <Section title="백엔드">
        <div style={S.row}>
          {(Object.keys(BACKEND_LABELS) as BackendKind[]).map((kind) => (
            <label key={kind} style={S.radio}>
              <input
                type="radio"
                checked={config.backend.active === kind}
                onChange={() => patch({ backend: { ...config.backend, active: kind } })}
              />
              <span>{BACKEND_LABELS[kind]}</span>
            </label>
          ))}
        </div>
        <label style={S.check}>
          <input
            type="checkbox"
            checked={config.backend.failover}
            onChange={(e) => patch({ backend: { ...config.backend, failover: e.target.checked } })}
          />
          <span>
            한도에 걸리면 다른 쪽으로 전환
            <div style={S.hint}>전환하면 이전 대화 맥락은 이어지지 않는다.</div>
          </span>
        </label>
        <div style={S.hint}>바꾼 뒤에는 앱을 다시 시작해야 적용된다.</div>
      </Section>

      <Section title="퍼소나">
        <Field
          label="이름"
          value={config.persona.name}
          onCommit={(v) => patch({ persona: { ...config.persona, name: v } })}
        />
        <Field
          label="성격 (시스템 프롬프트에 덧붙는다)"
          multiline
          value={config.persona.instructions}
          onCommit={(v) => patch({ persona: { ...config.persona, instructions: v } })}
        />
      </Section>

      <Section title="음성">
        <label style={S.check}>
          <input
            type="checkbox"
            checked={config.voice.enabled}
            onChange={(e) => patch({ voice: { ...config.voice, enabled: e.target.checked } })}
          />
          <span>
            소리 내어 말하기
            <div style={S.hint}>
              VOICEVOX 호환 엔진이 켜져 있어야 한다 (AivisSpeech 10101, VOICEVOX 50021).
            </div>
          </span>
        </label>
        <Field
          label="엔진 주소"
          value={config.voice.engineUrl}
          onCommit={(v) => patch({ voice: { ...config.voice, engineUrl: v } })}
        />
        <Field
          label="화자 ID"
          value={String(config.voice.speakerId)}
          onCommit={(v) => {
            const n = Number(v)
            if (Number.isFinite(n)) patch({ voice: { ...config.voice, speakerId: n } })
          }}
        />
        <Field
          label="whisper 실행 파일 (음성 입력용, 비우면 꺼짐)"
          value={config.voice.stt.whisperPath}
          onCommit={(v) =>
            patch({ voice: { ...config.voice, stt: { ...config.voice.stt, whisperPath: v } } })
          }
        />
        <Field
          label="whisper 모델 파일"
          value={config.voice.stt.modelPath}
          onCommit={(v) =>
            patch({ voice: { ...config.voice, stt: { ...config.voice.stt, modelPath: v } } })
          }
        />
      </Section>

      <Section title="아바타">
        <div style={S.row}>
          <div style={{ ...S.hint, flex: 1, wordBreak: 'break-all' }}>
            {config.avatar.modelPath ?? '(없음)'}
          </div>
          <button
            style={S.button}
            onClick={() => {
              void window.waifu.pickModel().then((p) => {
                if (p) patch({ avatar: { ...config.avatar, modelPath: p } })
              })
            }}
          >
            모델 고르기
          </button>
        </div>
      </Section>

      <Section title="Discord 원격">
        <div style={S.hint}>
          밖에서 DM 으로 부탁하고 결과를 받는다. 토큰과 허용 사용자 ID 가 모두 있어야 켜진다.
        </div>
        <label style={S.check}>
          <input
            type="checkbox"
            checked={config.discord.enabled}
            onChange={(e) => patch({ discord: { ...config.discord, enabled: e.target.checked } })}
          />
          <span>켜기</span>
        </label>
        <Field
          label="봇 토큰"
          value={config.discord.token}
          onCommit={(v) => patch({ discord: { ...config.discord, token: v.trim() } })}
        />
        <Field
          label="허용할 Discord 사용자 ID (줄바꿈으로 구분)"
          multiline
          value={config.discord.allowedUserIds.join('\n')}
          onCommit={(v) =>
            patch({
              discord: {
                ...config.discord,
                allowedUserIds: v.split('\n').map((s) => s.trim()).filter(Boolean)
              }
            })
          }
        />
        {config.discord.enabled && config.discord.allowedUserIds.length === 0 && (
          <div style={S.warn}>
            허용 사용자가 없어 봇이 시작되지 않는다. 비워두면 아무나 들어올 수 있게 되므로
            일부러 막아둔 것이다.
          </div>
        )}
        <div style={S.hint}>
          원격 요청은 최대 &apos;도와주기&apos; 까지만 허용된다. 눈앞에 없는 사람이 무제한 자동
          실행을 시키지 못하게 한다.
        </div>
      </Section>

      <RecentChanges />

      {saving && <div style={S.hint}>저장 중…</div>}
    </div>
  )
}

/**
 * 에이전트가 바꾼 파일과 되돌리기.
 *
 * 삭제는 여기 안 나온다 — 셸이 지운 파일은 우리 손을 거치지 않아 뜰 수가 없다.
 * 그래서 파괴적 명령은 자동 승인에서 빼고 항상 물어본다.
 */
function RecentChanges(): React.JSX.Element {
  const [changes, setChanges] = useState<FileChange[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  const reload = (): void => {
    void window.waifu.listChanges().then(setChanges)
  }
  useEffect(reload, [])

  return (
    <div style={S.section}>
      <div style={S.sectionTitle}>최근 변경</div>
      {changes.length === 0 && <div style={S.hint}>아직 바뀐 파일이 없다.</div>}
      {changes.slice(0, 12).map((c) => (
        <div key={c.id} style={S.changeRow}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={S.changePath}>{c.path}</div>
            <div style={S.hint}>
              {new Date(c.at).toLocaleString()} · {c.toolName}
              {c.restoredAt ? ' · 되돌림' : c.hasBackup ? '' : ' · 새로 만든 파일'}
            </div>
          </div>
          <button
            style={{
              ...S.button,
              ...(c.hasBackup && !c.restoredAt ? {} : { background: '#3a3750', cursor: 'default' })
            }}
            disabled={!c.hasBackup || c.restoredAt !== null || busy === c.id}
            onClick={() => {
              setBusy(c.id)
              void window.waifu.undoChange(c.id).then((r) => {
                setBusy(null)
                // 실패 이유를 숨기면 사용자는 되돌아간 줄 안다.
                if (!r.ok) window.alert(`되돌리지 못했다: ${r.reason ?? '알 수 없는 이유'}`)
                reload()
              })
            }}
          >
            되돌리기
          </button>
        </div>
      ))}
    </div>
  )
}

function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div style={S.section}>
      <div style={S.sectionTitle}>{title}</div>
      {children}
    </div>
  )
}

/**
 * 입력하는 동안이 아니라 포커스를 잃을 때 저장한다.
 * 글자마다 저장하면 파일을 계속 쓰고, 에이전트 세션 설정도 계속 흔들린다.
 */
function Field({
  label,
  value,
  onCommit,
  multiline
}: {
  label: string
  value: string
  onCommit: (v: string) => void
  multiline?: boolean
}): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])

  const common = {
    style: S.input,
    value: draft,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: () => {
      if (draft !== value) onCommit(draft)
    }
  }

  return (
    <label style={S.field}>
      <div style={S.hint}>{label}</div>
      {multiline ? (
        <textarea {...common} rows={3} style={{ ...S.input, resize: 'vertical' }} />
      ) : (
        <input {...common} />
      )}
    </label>
  )
}

const S = {
  root: { padding: '16px', overflowY: 'auto', height: '100%', boxSizing: 'border-box' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' },
  close: {
    background: 'transparent',
    color: '#b9b3cc',
    border: '1px solid #3a3750',
    borderRadius: '8px',
    padding: '4px 12px',
    cursor: 'pointer',
    font: 'inherit'
  },
  section: { marginBottom: '20px' },
  sectionTitle: { color: '#8b869e', fontSize: '12px', marginBottom: '8px', letterSpacing: '0.04em' },
  radio: { display: 'flex', gap: '8px', alignItems: 'flex-start', padding: '6px 0', cursor: 'pointer' },
  check: { display: 'flex', gap: '8px', alignItems: 'flex-start', padding: '6px 0', cursor: 'pointer' },
  row: { display: 'flex', gap: '12px', alignItems: 'center' },
  hint: { color: '#8b869e', fontSize: '12px', lineHeight: 1.5 },
  warn: {
    background: '#3a2733',
    border: '1px solid #6b4050',
    borderRadius: '8px',
    padding: '8px 10px',
    fontSize: '12px',
    marginTop: '6px'
  },
  changeRow: {
    display: 'flex',
    gap: '10px',
    alignItems: 'center',
    padding: '8px 0',
    borderBottom: '1px solid #262432'
  },
  changePath: {
    fontSize: '13px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
  },
  field: { display: 'block', marginTop: '10px' },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    marginTop: '4px',
    background: '#1e1c2b',
    color: 'inherit',
    border: '1px solid #322f45',
    borderRadius: '8px',
    padding: '8px',
    font: 'inherit'
  },
  button: {
    background: '#5a4fcf',
    color: '#fff',
    border: 0,
    borderRadius: '8px',
    padding: '6px 14px',
    cursor: 'pointer',
    font: 'inherit'
  }
} satisfies Record<string, React.CSSProperties>
