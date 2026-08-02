import type { BackendEvent, BackendKind, PermissionMode } from '@shared/protocol'

export interface SessionOpts {
  /** 에이전트의 작업 루트. */
  cwd: string
  /** 이어받을 세션. 없으면 새로 시작한다. */
  resumeSessionId?: string
  /** cwd 외에 쓰기를 허용할 디렉터리. */
  workspaces: string[]
  permissionMode: PermissionMode
  /** `--mcp-config` 로 넘길 JSON 문자열. 와이프 제어 MCP 서버가 여기 들어간다. */
  mcpConfigJson?: string
  /** 권한 승인을 라우팅할 MCP 툴 이름 (예: `mcp__waifu__ask_permission`). */
  permissionPromptTool?: string
  /** 퍼소나를 담은 파일 경로. `--append-system-prompt-file` 로 넘긴다. */
  systemPromptFile?: string
  model?: string
}

export type BackendListener = (event: BackendEvent) => void

export interface AgentBackend {
  readonly kind: BackendKind
  /** CLI 가 부여한 세션 id. start 전에는 null. */
  readonly sessionId: string | null
  /** 현재 턴이 진행 중인지. */
  readonly busy: boolean

  start(opts: SessionOpts): Promise<void>
  /** 유저 발화 한 턴. */
  send(text: string): Promise<void>
  /** 진행 중인 턴을 중단한다. */
  interrupt(): Promise<void>
  stop(): Promise<void>

  /** 구독 해제 함수를 돌려준다. */
  onEvent(listener: BackendListener): () => void
}

/**
 * 자식 CLI 에 넘길 환경을 만든다.
 *
 * Claude Code 세션 안에서 `npm run dev` 로 앱을 띄우면 `CLAUDE_CODE_*` 변수가 그대로
 * 상속된다. 특히 `CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH` 가 붙으면 자식은 "인증 갱신은
 * 호스트가 해준다"고 믿고 시작하는데 그 자식에게는 호스트가 없다. 개발 중에만 나타나는
 * 함정이라 놓치기 쉽다. 상속을 끊는다.
 */
export function cleanEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) {
    if (/^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK|CLAUDE_PID$)/.test(k)) continue
    out[k] = v
  }
  return out
}
