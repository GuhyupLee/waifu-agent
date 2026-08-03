import { useEffect, useRef, useState } from 'react'
import type { PermissionDecision, PermissionRequest } from '@shared/protocol'
import { permissionDetails, summarizePermission } from './permissionSummary'

interface PermissionCardProps {
  request: PermissionRequest
  onRespond: (decision: PermissionDecision) => void
}

export function PermissionCard({ request, onRespond }: PermissionCardProps): React.JSX.Element {
  const cardRef = useRef<HTMLElement>(null)
  const denyRef = useRef<HTMLButtonElement>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const summary = summarizePermission(request)

  // 위험한 쪽 버튼에 기본 포커스를 두지 않는다. 카드가 나타난 뒤 Enter를 치던 사용자가
  // 우연히 승인하지 않도록 거부 쪽으로 포커스를 옮긴다.
  useEffect(() => {
    denyRef.current?.focus()
  }, [request.id])

  const deny = (message = '사용자가 거부했다.'): void => {
    onRespond({ behavior: 'deny', message })
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      deny('사용자가 Esc 키로 거부했다.')
      return
    }
    if (event.key !== 'Tab') return

    const card = cardRef.current
    if (!card) return
    const focusable = Array.from(
      card.querySelectorAll<HTMLElement>(
        'button:not(:disabled), summary, [href], input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
      )
    ).filter((element) => !element.hasAttribute('hidden'))
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (!first || !last) return

    const active = document.activeElement
    if (event.shiftKey && (active === first || !card.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || !card.contains(active))) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <section
      ref={cardRef}
      className="permission-card"
      data-testid="permission-card"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`permission-title-${request.id}`}
      aria-describedby={`permission-reason-${request.id}`}
      onKeyDown={handleKeyDown}
    >
      <div className="permission-eyebrow">확인이 필요해</div>
      <h2 id={`permission-title-${request.id}`}>{summary.action}를 실행하려고 해.</h2>

      <dl className="permission-summary">
        <div>
          <dt>이유</dt>
          <dd id={`permission-reason-${request.id}`}>{summary.reason}</dd>
        </div>
        <div>
          <dt>대상</dt>
          <dd className="permission-target">{summary.target}</dd>
        </div>
        <div>
          <dt>되돌리기</dt>
          <dd>{summary.reversibility}</dd>
        </div>
      </dl>

      <details
        className="permission-details"
        open={detailsOpen}
        onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
      >
        <summary>정확한 입력 보기</summary>
        {detailsOpen && <pre>{permissionDetails(request.input)}</pre>}
      </details>

      <div className="permission-actions">
        <button
          ref={denyRef}
          className="button button-secondary permission-decision"
          data-decision="deny"
          onClick={() => deny()}
        >
          하지 마
        </button>
        <button
          className="button button-secondary permission-decision"
          data-decision="allow"
          onClick={() => onRespond({ behavior: 'allow' })}
        >
          이번만 허락
        </button>
      </div>
    </section>
  )
}
