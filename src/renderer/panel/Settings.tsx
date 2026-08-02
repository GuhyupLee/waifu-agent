import { useEffect, useState } from 'react'
import type { BackendKind, PermissionMode, WaifuConfig } from '@shared/protocol'

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

      {saving && <div style={S.hint}>저장 중…</div>}
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
