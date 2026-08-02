import { useEffect, useState } from 'react'

/** 설정 화면에서 반복되는 조각들. 화면마다 다시 쓰지 않으려고 모아둔다. */

export const S = {
  section: { marginBottom: '22px' },
  title: { color: '#8b869e', fontSize: '12px', marginBottom: '8px', letterSpacing: '0.04em' },
  hint: { color: '#8b869e', fontSize: '12px', lineHeight: 1.5 },
  row: { display: 'flex', gap: '12px', alignItems: 'center' },
  choice: { display: 'flex', gap: '8px', alignItems: 'flex-start', padding: '6px 0', cursor: 'pointer' },
  warn: {
    background: '#3a2733',
    border: '1px solid #6b4050',
    borderRadius: '8px',
    padding: '8px 10px',
    fontSize: '12px',
    marginTop: '6px',
    lineHeight: 1.5
  },
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
  },
  ghost: {
    background: 'transparent',
    color: '#b9b3cc',
    border: '1px solid #3a3750',
    borderRadius: '8px',
    padding: '4px 12px',
    cursor: 'pointer',
    font: 'inherit',
    fontSize: '12px'
  },
  listRow: {
    display: 'flex',
    gap: '10px',
    alignItems: 'center',
    padding: '8px 0',
    borderBottom: '1px solid #262432'
  },
  mono: {
    fontSize: '12px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
  }
} satisfies Record<string, React.CSSProperties>

export function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div style={S.section}>
      <div style={S.title}>{title}</div>
      {children}
    </div>
  )
}

export function Check({
  label,
  hint,
  checked,
  onChange
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (v: boolean) => void
}): React.JSX.Element {
  return (
    <label style={S.choice}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <div style={S.hint}>{hint}</div>}
      </span>
    </label>
  )
}

/**
 * 타이핑 중이 아니라 포커스를 잃을 때 저장한다.
 * 글자마다 저장하면 파일을 계속 쓰고 에이전트 세션 설정도 계속 흔들린다.
 */
export function Field({
  label,
  value,
  onCommit,
  multiline,
  password
}: {
  label: string
  value: string
  onCommit: (v: string) => void
  multiline?: boolean
  password?: boolean
}): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])

  const commit = (): void => {
    if (draft !== value) onCommit(draft)
  }

  return (
    <label style={{ display: 'block', marginTop: '10px' }}>
      <div style={S.hint}>{label}</div>
      {multiline ? (
        <textarea
          style={{ ...S.input, resize: 'vertical' }}
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
        />
      ) : (
        <input
          style={S.input}
          // 토큰은 어깨너머로 보이면 안 된다.
          type={password ? 'password' : 'text'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
        />
      )}
    </label>
  )
}

/** 숫자 슬라이더. 값이 눈에 보여야 조절할 수 있다. */
export function Slider({
  label,
  hint,
  value,
  min,
  max,
  step,
  format,
  onChange
}: {
  label: string
  hint?: string
  value: number
  min: number
  max: number
  step: number
  format?: (v: number) => string
  onChange: (v: number) => void
}): React.JSX.Element {
  return (
    <div style={{ marginTop: '12px' }}>
      <div style={{ ...S.row, justifyContent: 'space-between' }}>
        <span style={{ fontSize: '13px' }}>{label}</span>
        <span style={S.hint}>{format ? format(value) : value}</span>
      </div>
      <input
        type="range"
        style={{ width: '100%', marginTop: '4px' }}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint && <div style={S.hint}>{hint}</div>}
    </div>
  )
}

/** 저장된 것들을 보여주고 지우는 공통 목록. */
export function ManagedList<T>({
  items,
  empty,
  primary,
  secondary,
  onRemove,
  removeLabel = '지우기'
}: {
  items: T[]
  empty: string
  primary: (item: T) => string
  secondary: (item: T) => string
  onRemove: (item: T) => void
  removeLabel?: string
}): React.JSX.Element {
  if (items.length === 0) return <div style={S.hint}>{empty}</div>
  return (
    <>
      {items.map((item, i) => (
        <div key={i} style={S.listRow}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={S.mono}>{primary(item)}</div>
            <div style={S.hint}>{secondary(item)}</div>
          </div>
          <button style={S.ghost} onClick={() => onRemove(item)}>
            {removeLabel}
          </button>
        </div>
      ))}
    </>
  )
}
