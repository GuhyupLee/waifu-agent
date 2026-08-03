import { useEffect, useId, useState } from 'react'
import { T } from '../theme'

/**
 * 설정 화면에서 반복되는 조각들. 화면마다 다시 쓰지 않으려고 모아둔다.
 *
 * 색과 치수는 전부 `theme.ts` 에서 가져온다. 예전에는 여기에도 hex 가 따로
 * 박혀 있어서, 한쪽 보라색을 고치면 다른 쪽만 옛 색으로 남았다.
 */

export const S = {
  section: { marginBottom: T.space(6) },
  title: {
    color: T.color.dim,
    fontSize: T.font.small,
    marginBottom: T.space(2),
    letterSpacing: '0.04em'
  },
  hint: { color: T.color.dim, fontSize: T.font.small, lineHeight: 1.5 },
  row: { display: 'flex', gap: T.space(3), alignItems: 'center' },
  choice: {
    display: 'flex',
    gap: T.space(2),
    alignItems: 'flex-start',
    padding: `${T.space(2)} 0`,
    cursor: 'pointer'
  },
  /** 되돌릴 수 없거나 오해하기 쉬운 것. 본문보다 눈에 띄어야 한다. */
  warn: {
    background: T.color.high,
    border: `1px solid ${T.color.accent}`,
    borderRadius: T.radius.md,
    padding: `${T.space(2)} ${T.space(3)}`,
    fontSize: T.font.small,
    marginTop: T.space(2),
    lineHeight: 1.6
  },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    marginTop: T.space(1),
    background: T.color.base,
    color: 'inherit',
    border: `1px solid ${T.color.line}`,
    borderRadius: T.radius.md,
    padding: T.space(2),
    font: 'inherit'
  },
  button: {
    background: T.color.accent,
    color: '#fff',
    border: 0,
    borderRadius: T.radius.md,
    padding: `${T.space(2)} ${T.space(4)}`,
    cursor: 'pointer',
    font: 'inherit'
  },
  ghost: {
    background: 'transparent',
    color: T.color.dim,
    border: `1px solid ${T.color.line}`,
    borderRadius: T.radius.md,
    padding: `${T.space(1)} ${T.space(3)}`,
    cursor: 'pointer',
    font: 'inherit',
    fontSize: T.font.small
  },
  listRow: {
    display: 'flex',
    gap: T.space(3),
    alignItems: 'center',
    padding: `${T.space(2)} 0`,
    borderBottom: `1px solid ${T.color.line}`
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
  const inputId = useId()
  const hintId = hint ? `${inputId}-hint` : undefined
  const shownValue = format ? format(value) : String(value)
  return (
    <div style={{ marginTop: '12px' }}>
      <div style={{ ...S.row, justifyContent: 'space-between' }}>
        <label htmlFor={inputId} style={{ fontSize: '13px' }}>{label}</label>
        <span style={S.hint}>{shownValue}</span>
      </div>
      <input
        id={inputId}
        type="range"
        style={{ width: '100%', marginTop: '4px' }}
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={shownValue}
        aria-describedby={hintId}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint && <div id={hintId} style={S.hint}>{hint}</div>}
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
