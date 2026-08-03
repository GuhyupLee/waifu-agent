import { useEffect, useRef } from 'react'
import type {
  Diagnostics,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  WaifuConfig
} from '@shared/protocol'
import type { PanelPhase, PanelState, TranscriptItem } from './panelState'
import { PermissionCard } from './PermissionCard'
import './home.css'

const BACKEND_LABELS = {
  'claude-code': 'Claude Code',
  codex: 'Codex'
} as const

const PERMISSION_LABELS: Record<PermissionMode, string> = {
  readonly: '대화만 하기',
  guarded: '도와주기',
  auto: '맡겨두기'
}

const QUICK_REQUESTS = [
  '이 폴더부터 살펴봐',
  '문제 하나만 찾아봐',
  '해야 할 일을 정리해줘'
] as const

interface HomeProps {
  config: WaifuConfig | null
  diagnostics: Diagnostics | null
  state: PanelState
  permission: PermissionRequest | null
  input: string
  choosingWorkspace: boolean
  choosingModel: boolean
  restartingApp: boolean
  onInput: (text: string) => void
  onSend: () => void
  onInterrupt: () => void
  onOpenSettings: () => void
  onChooseWorkspace: () => void
  onChooseModel: () => void
  onRestartApp: () => void
  onPermission: (decision: PermissionDecision) => void
}

function shortPath(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '')
  if (normalized.length <= 30) return normalized
  const separator = normalized.includes('\\') ? '\\' : '/'
  const bits = normalized.split(/[\\/]/).filter(Boolean)
  return bits.length > 2
    ? `…${separator}${bits.slice(-2).join(separator)}`
    : normalized
}

function phaseLabel(phase: PanelPhase, hasRuntime: boolean): string {
  if (!hasRuntime) return '작업 폴더가 필요해'
  const labels: Record<PanelPhase, string> = {
    idle: '여기 있어',
    thinking: '작업 중',
    working: '작업 중',
    responding: '작업 중',
    permission: '네 확인을 기다리는 중',
    error: '여기서 멈췄어'
  }
  return labels[phase]
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  return paths.filter((path) => {
    const key = path.replace(/[\\/]+$/, '').toLocaleLowerCase()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function transcriptItem(item: TranscriptItem, name: string): React.JSX.Element {
  if (item.kind === 'activity') {
    return (
      <div key={item.id} className="activity-line" data-kind="activity">
        <span className="activity-mark" aria-hidden="true" />
        <span>{item.text}</span>
      </div>
    )
  }

  if (item.kind === 'notice') {
    const level = item.level ?? 'info'
    const presentation = {
      info: { symbol: 'i', label: '정보' },
      warn: { symbol: '!', label: '주의' },
      error: { symbol: '×', label: '오류' }
    }[level]
    return (
      <div
        key={item.id}
        className={`notice notice-${level}`}
        data-kind="notice"
        data-level={level}
        role={level === 'error' ? 'alert' : 'status'}
      >
        <span className="notice-heading">
          <span className="notice-symbol" aria-hidden="true">{presentation.symbol}</span>
          <strong className="notice-label">{presentation.label}</strong>
        </span>
        <span className="notice-message">{item.text}</span>
      </div>
    )
  }

  return (
    <article key={item.id} className={`message message-${item.kind}`} data-kind={item.kind}>
      {item.kind === 'waifu' && <div className="message-speaker">{name}</div>}
      <div className="message-body">{item.text}</div>
      {item.streaming && <span className="stream-caret" aria-label="답변 작성 중" />}
    </article>
  )
}

export function Home(props: HomeProps): React.JSX.Element {
  const {
    config,
    diagnostics,
    state,
    permission,
    input,
    choosingWorkspace,
    choosingModel,
    restartingApp,
    onInput,
    onSend,
    onInterrupt,
    onOpenSettings,
    onChooseWorkspace,
    onChooseModel,
    onRestartApp,
    onPermission
  } = props
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  const name = config?.persona.name.trim() || '와이프'
  const runtime = diagnostics?.runtime ?? null
  const ready = runtime !== null
  const effectiveBusy = state.busy || Boolean(diagnostics?.busy)
  const visualPhase: PanelPhase = permission
    ? 'permission'
    : effectiveBusy && (state.phase === 'idle' || state.phase === 'error')
      ? 'working'
      : state.phase
  const status = phaseLabel(visualPhase, ready)
  const detailedAction = effectiveBusy ? state.action ?? '작업을 계속하는 중' : null
  const canSend = Boolean(input.trim() && ready && !permission && !effectiveBusy && !restartingApp)
  const configuredWorkspace = config?.permission.workspaces[0] ?? null
  const scopeWorkspaces = uniquePaths(
    runtime
      ? [runtime.cwd, ...runtime.workspaces]
      : config?.permission.workspaces ?? []
  )
  const primaryWorkspace = runtime?.cwd ?? configuredWorkspace
  const additionalWorkspaceCount = Math.max(0, scopeWorkspaces.length - 1)
  const workspaceLabel = primaryWorkspace
    ? `${shortPath(primaryWorkspace)}${additionalWorkspaceCount > 0 ? ` +${additionalWorkspaceCount}` : ''}${runtime ? '' : ' · 적용 전'}`
    : '폴더 미선택'
  const workspaceTitle = scopeWorkspaces.length > 0
    ? `${runtime ? '현재 실행 범위' : '저장된 작업 범위 (적용 전)'}\n${scopeWorkspaces.join('\n')}`
    : '선택된 작업 폴더 없음'
  const actualBackend = diagnostics?.backend ?? config?.backend.active ?? 'claude-code'
  const actualPermission = runtime?.permissionMode ?? config?.permission.mode ?? 'guarded'

  useEffect(() => {
    if (!stickToBottom.current) return
    const log = logRef.current
    if (log) log.scrollTop = log.scrollHeight
  }, [state.items, permission, detailedAction])

  const chooseQuickRequest = (text: string): void => {
    onInput(text)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  return (
    <div className={`home-shell phase-${visualPhase} runtime-${diagnostics === null ? 'loading' : ready ? 'ready' : 'missing'}`}>
      <div className="avatar-link" aria-hidden="true">
        <span />
      </div>

      <div
        className="home-content"
        inert={permission ? true : undefined}
        aria-hidden={permission ? true : undefined}
      >
        <header className="home-header">
          <div className="identity-block">
            <span className="presence-dot" aria-hidden="true" />
            <div className="identity-copy">
              <strong>{name}</strong>
              <span role="status" aria-live="polite">{status}</span>
            </div>
          </div>
          <button className="icon-button" onClick={onOpenSettings} aria-label="설정 열기">
            설정
          </button>
        </header>

        <section className="connection-scope" data-testid="connection-scope" aria-label="현재 작업 범위">
          <div className="scope-facts">
            <span title={ready ? '현재 실행 중인 백엔드' : '시작할 백엔드 설정'}>
              {BACKEND_LABELS[actualBackend]}
            </span>
            <span
              className={runtime ? '' : 'scope-missing'}
              title={workspaceTitle}
              data-testid="workspace-label"
            >
              {workspaceLabel}
            </span>
            <span title="현재 권한 모드">{PERMISSION_LABELS[actualPermission]}</span>
          </div>
          <div className="scope-actions">
            <button className="scope-button" onClick={onChooseWorkspace} disabled={choosingWorkspace}>
              {choosingWorkspace ? '고르는 중…' : runtime ? '폴더 바꾸기' : '폴더 고르기'}
            </button>
            {diagnostics?.backendRestartRequired && (
              <button className="scope-button scope-apply" onClick={onRestartApp} disabled={restartingApp}>
                {restartingApp ? '앱을 다시 시작하는 중…' : '앱 다시 시작해 적용'}
              </button>
            )}
          </div>
          {runtime && diagnostics?.backendRestartRequired && (
            <div className="scope-note">저장된 설정과 지금 실행 중인 범위가 달라.</div>
          )}
          {actualBackend === 'codex' && actualPermission === 'guarded' && (
            <div className="scope-note scope-note-warn">
              Codex는 도구별 승인 대신 샌드박스 단계로 작업을 제한해.
            </div>
          )}
          {actualBackend === 'codex' && actualPermission === 'auto' && (
            <div className="scope-note scope-note-danger">
              Codex 맡겨두기는 전체 파일시스템 접근이 가능하고 명령별 확인도 없어.
            </div>
          )}
        </section>

        {effectiveBusy && !permission && detailedAction && (
          <div className="current-action" aria-live="polite">
            <span className="action-orbit" aria-hidden="true" />
            <div>
              <span>지금</span>
              <strong>{detailedAction}</strong>
            </div>
          </div>
        )}

        <main
          ref={logRef}
          className="conversation"
          aria-label="대화와 작업 기록"
          onScroll={(event) => {
            const el = event.currentTarget
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 72
          }}
        >
          {state.items.length === 0 && (
            <section className="welcome">
              <div className="welcome-eyebrow">{name}</div>
              <h1>안녕. 어디서부터 같이 볼까?</h1>
              <p>
                여기서 대화만 하는 게 아니라, 네가 고른 작업 폴더에서 파일을 살펴보고 실제 일을
                도울 수 있어.
              </p>

              {!ready && (
                <div className="setup-callout">
                  <strong>먼저 함께 볼 폴더를 골라줘.</strong>
                  <span>폴더를 고르기 전에는 에이전트를 시작하지 않아.</span>
                  <button className="button button-primary" onClick={onChooseWorkspace} disabled={choosingWorkspace}>
                    {choosingWorkspace ? '폴더를 여는 중…' : '작업 폴더 고르기'}
                  </button>
                </div>
              )}

              {ready && diagnostics && diagnostics.activeTasks > 0 && (
                <div className="returning-note">
                  지난번에 하던 일이 {diagnostics.activeTasks}개 남아 있어. 이어서 말해주면 돼.
                </div>
              )}

              {config && !config.avatar.modelPath && (
                <div className="appearance-note">
                  <div>
                    <strong>아직 내 모습이 없어.</strong>
                    <span>가지고 있는 VRM이나 FBX를 고르면 오른쪽에 함께 있을게.</span>
                  </div>
                  <button className="button button-secondary" onClick={onChooseModel} disabled={choosingModel}>
                    {choosingModel ? '고르는 중…' : '내 모습 고르기'}
                  </button>
                </div>
              )}

              {ready && (
                <div className="quick-requests" aria-label="빠른 부탁">
                  {QUICK_REQUESTS.map((request) => (
                    <button key={request} onClick={() => chooseQuickRequest(request)}>
                      {request}
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}

          {state.items.map((item) => transcriptItem(item, name))}
        </main>

        {ready && (
          <footer className="composer">
            <label className="sr-only" htmlFor="companion-message">{name}에게 부탁할 내용</label>
            <textarea
              ref={textareaRef}
              id="companion-message"
              data-testid="composer-input"
              value={input}
              placeholder={`${name}에게 하고 싶은 일을 말해줘…`}
              disabled={!config || Boolean(permission) || effectiveBusy || restartingApp}
              onChange={(event) => onInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  if (canSend) onSend()
                }
              }}
            />
            <div className="composer-actions">
              {effectiveBusy && (
                <button
                  className="button button-secondary stop-button"
                  data-testid="composer-stop"
                  onClick={onInterrupt}
                >
                  중단
                </button>
              )}
              <button
                className="button button-primary send-button"
                data-testid="composer-send"
                onClick={onSend}
                disabled={!canSend}
              >
                부탁하기
              </button>
            </div>
          </footer>
        )}
      </div>

      {permission && (
        <PermissionCard key={permission.id} request={permission} onRespond={onPermission} />
      )}
    </div>
  )
}
