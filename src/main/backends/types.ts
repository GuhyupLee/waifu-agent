import type { BackendEvent, BackendKind, PermissionMode } from '@shared/protocol'

export interface SessionOpts {
  /** 실행할 CLI. 설정의 backend.claudeCode.bin / codex.bin 이 들어온다. */
  bin: string
  /** 에이전트의 작업 루트. 세션 재개가 cwd 스코프라 Task 마다 기억해야 한다. */
  cwd: string
  /** 이어받을 세션. 없으면 새로 시작한다. */
  resumeSessionId?: string
  /** cwd 외에 쓰기를 허용할 디렉터리. */
  workspaces: string[]
  permissionMode: PermissionMode
  /** `--mcp-config` 로 넘길 JSON 문자열. 와이프 제어 MCP 서버가 여기 들어간다. */
  mcpConfigJson?: string
  /**
   * `--settings` 로 넘길 파일 경로. PreToolUse 훅이 여기 들어간다.
   * (`--permission-prompt-tool` 은 claude 2.1.207 에 존재하지 않는다.)
   */
  settingsPath?: string
  /**
   * 퍼소나. `--append-system-prompt` 로 인라인 전달한다 —
   * `--append-system-prompt-file` 은 이 버전에 없다.
   */
  systemPrompt?: string
  /**
   * Codex 용 MCP 등록 정보. Codex 에는 `--mcp-config` 플래그가 없어서
   * `-c mcp_servers.waifu.*` 오버라이드로 넣어야 한다.
   */
  codexMcp?: { command: string; args: string[]; env: Record<string, string> }
  model?: string
  /**
   * 자식 CLI 환경에 덧붙일 값. 제어 서버 주소와 토큰이 여기로 간다.
   *
   * 권한 훅은 **claude 가** spawn 하므로 우리가 직접 env 를 줄 수 없다. 대신 claude 의
   * 환경을 훅이 상속하므로, claude 를 띄울 때 넣어두면 훅까지 전달된다.
   * (MCP 서버는 --mcp-config 의 env 로도 받지만, 경로가 하나로 통일되는 편이 낫다.)
   */
  extraEnv?: Record<string, string>
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
