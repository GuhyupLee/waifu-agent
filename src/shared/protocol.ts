/**
 * main <-> preload <-> renderer <-> mcp 전 구간의 단일 진실 소스.
 *
 * 이 파일만 보면 앱의 모든 경계에서 어떤 메시지가 오가는지 알 수 있어야 한다.
 * 여기 없는 문자열 리터럴을 IPC 채널명으로 쓰지 말 것.
 */

// ─────────────────────────── 도메인 ───────────────────────────

/** VRM 표준 표정 프리셋에 대응한다. VRM 0.x/1.0 양쪽에 존재하는 5종 + neutral. */
export type Emotion = 'neutral' | 'happy' | 'sad' | 'angry' | 'surprised' | 'relaxed'

export const EMOTIONS: readonly Emotion[] = [
  'neutral',
  'happy',
  'sad',
  'angry',
  'surprised',
  'relaxed'
] as const

/** 아바타가 표시하는 상태. 에이전트가 뭘 하고 있는지 몸으로 보여주는 용도. */
export type AgentState = 'idle' | 'thinking' | 'working' | 'speaking' | 'error'

export type BackendKind = 'claude-code' | 'codex'

/**
 * 권한 모드. 백엔드별 매핑은 backends/* 에서 하고, 여기서는 의미만 정의한다.
 *  - readonly: 읽기만. 쓰기 시도는 전부 거부.
 *  - guarded:  파일 편집은 자동, 셸/네트워크는 아바타가 물어보고 사용자가 승인.
 *  - auto:     전부 자동. 위험하므로 UI 에 경고를 띄운다.
 */
export type PermissionMode = 'readonly' | 'guarded' | 'auto'

// ─────────────────────────── 립싱크 ───────────────────────────

/** VRM 표준 입모양 표정 이름과 1:1 대응한다 (`sil` 은 닫힌 입). */
export type Viseme = 'aa' | 'ih' | 'ou' | 'ee' | 'oh' | 'sil'

/** 일본어 모음 -> VRM viseme. VOICEVOX 의 mora.vowel 값이 그대로 키가 된다. */
export const VOWEL_TO_VISEME: Readonly<Record<string, Viseme>> = {
  a: 'aa',
  i: 'ih',
  u: 'ou',
  e: 'ee',
  o: 'oh',
  A: 'aa',
  I: 'ih',
  U: 'ou',
  E: 'ee',
  O: 'oh',
  N: 'sil',
  cl: 'sil',
  pau: 'sil'
}

export interface VisemeFrame {
  /** 발화 시작 기준 초 단위 오프셋. */
  t: number
  viseme: Viseme
  /** 0..1. 짧은 mora 는 입을 덜 벌린다. */
  weight: number
}

export interface SpeechAudio {
  /** WAV 바이트를 base64 로. 렌더러가 Blob 으로 복원해 재생한다. */
  wavBase64: string
  durationSec: number
}

// ─────────────────────── 아바타 제어 (main -> avatar) ───────────────────────

export type AvatarCommand =
  | { type: 'load-model'; url: string; format: 'vrm' | 'fbx' }
  | { type: 'load-motion'; name: string; url: string }
  | {
      type: 'say'
      /** 이 발화의 고유 id. 완료/중단 이벤트가 이 id 로 돌아온다. */
      id: string
      /** 화면 자막 (사용자 모국어). */
      text: string
      emotion?: Emotion
      motion?: string
      /** 없으면 무음 자막만 표시한다. */
      audio?: SpeechAudio
      visemes?: VisemeFrame[]
    }
  /**
   * 화면 전역 커서 방향. 아바타 창 중심 기준으로 정규화한 값이며, 커서가 창 밖에 있으면
   * ±1 을 넘어간다.
   *
   * 렌더러의 mousemove 로는 부족하다 — setIgnoreMouseEvents(true, {forward:true}) 는
   * 커서가 창 **위에 있을 때만** WM_MOUSEMOVE 를 전달하므로, 데스크탑 어디를 보고 있는지
   * 알 수 없다. main 에서 screen.getCursorScreenPoint() 로 폴링해 넣어준다.
   */
  | { type: 'gaze'; x: number; y: number }
  | { type: 'express'; emotion: Emotion; intensity?: number }
  | { type: 'motion'; name: string; loop?: boolean }
  | { type: 'status'; state: AgentState }
  | { type: 'stop-speaking' }
  | { type: 'set-scale'; scale: number }

// ─────────────────────── 아바타 -> main ───────────────────────

export type AvatarEvent =
  /** 아바타 위 불투명 픽셀에 커서가 올라갔는지. 클릭 통과 토글에 쓴다. */
  | { type: 'hover'; over: boolean }
  /**
   * 아바타를 잡아 끄는 중. 창을 옮기는 주체는 main 이다.
   *
   * 드래그 중에는 커서가 실루엣 밖으로 나가도 클릭 통과로 되돌리면 안 된다 —
   * 그 순간 mouseup 을 못 받아 드래그가 영원히 안 끝난다.
   */
  | { type: 'drag-start' }
  /** 마지막 이벤트 이후의 화면 좌표 이동량. */
  | { type: 'drag-move'; dx: number; dy: number }
  | { type: 'drag-end' }
  | { type: 'speech-end'; id: string }
  /**
   * `presets` 는 모델이 실제로 들고 있는 VRM 표정 프리셋 이름들이다.
   * 없는 프리셋에 setValue 해도 에러 없이 조용히 무시되므로, 표정이 안 먹을 때
   * 제일 먼저 확인해야 할 정보다.
   */
  | { type: 'model-loaded'; ok: true; hasExpressions: boolean; hasLookAt: boolean; presets: string[] }
  | { type: 'model-loaded'; ok: false; error: string }
  | { type: 'fps'; value: number }
  | { type: 'clicked' }

// ─────────────────────── 에이전트 백엔드 이벤트 ───────────────────────

export type BackendErrorKind = 'rate-limit' | 'auth' | 'not-found' | 'unknown'

/**
 * 실제 캡처(`tests/fixtures/claude-multiturn.jsonl`)의 `rate_limit_event.rate_limit_info` 형태.
 * `status` 가 'allowed' 가 아니면 페일오버 트리거로 본다.
 */
export interface RateLimitInfo {
  status: string
  rateLimitType: string
  /** epoch 초. */
  resetsAt?: number
  isUsingOverage?: boolean
}

export type BackendEvent =
  | {
      type: 'session'
      sessionId: string
      backend: BackendKind
      model?: string
      /**
       * 붙은 MCP 서버와 그 상태. 와이프 제어 채널이 실제로 연결됐는지 확인하는 유일한 신호다.
       * 여기서 waifu 가 'connected' 가 아니면 에이전트는 아바타를 제어할 수 없다.
       */
      mcpServers?: { name: string; status: string }[]
    }
  | { type: 'text-delta'; text: string }
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool-start'; id: string; name: string; input: unknown }
  | { type: 'tool-end'; id: string; name: string; isError: boolean }
  /**
   * Claude Code 의 `system/post_turn_summary` 에서 온 사람이 읽을 수 있는 활동 설명
   * (예: "reading waifu-agent source"). 와이프가 작업 중 상황을 말하는 데 쓴다.
   */
  | { type: 'activity'; detail: string; category?: string; needsAction?: string }
  | { type: 'rate-limit'; info: RateLimitInfo }
  | { type: 'result'; text: string; isError: boolean; durationMs?: number; costUsd?: number }
  | { type: 'error'; message: string; kind: BackendErrorKind }
  | { type: 'exit'; code: number | null }

// ─────────────────────── 권한 승인 ───────────────────────

export interface PermissionRequest {
  id: string
  toolName: string
  input: unknown
  /** 에이전트가 왜 필요한지 스스로 설명한 문장. */
  reason?: string
}

export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: unknown; remember?: boolean }
  | { behavior: 'deny'; message: string }

// ─────────────────────── 패널 (채팅 UI) ───────────────────────

export type PanelEvent =
  | { type: 'backend'; event: BackendEvent }
  | { type: 'permission-request'; request: PermissionRequest }
  | { type: 'permission-resolved'; id: string }
  | { type: 'config'; config: WaifuConfig }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string }

// ─────────────────────── 설정 ───────────────────────

export interface WaifuConfig {
  backend: {
    active: BackendKind
    /** 활성 백엔드가 rate limit 에 걸리면 다른 쪽으로 자동 전환. */
    failover: boolean
    claudeCode: { bin: string; model?: string }
    codex: { bin: string; model?: string }
  }
  permission: {
    mode: PermissionMode
    /** 에이전트가 쓰기 가능한 루트. 비어 있으면 cwd 만. */
    workspaces: string[]
    /** guarded 모드에서 물어보지 않고 통과시킬 툴 이름. */
    autoApprove: string[]
  }
  avatar: {
    modelPath: string | null
    scale: number
    /** 화면상 위치 (0..1 정규화, 좌하단 기준). */
    anchor: { x: number; y: number }
    alwaysOnTop: boolean
  }
  voice: {
    enabled: boolean
    /** VOICEVOX 호환 엔진 주소. AivisSpeech 10101, VOICEVOX 50021. */
    engineUrl: string
    speakerId: number
    speedScale: number
    /** STT 푸시투토크 핫키 (Electron accelerator 문법). */
    sttHotkey: string
  }
  persona: {
    name: string
    /** 시스템 프롬프트에 덧붙는 캐릭터 설정. */
    instructions: string
    /** 자막 언어. TTS 는 항상 일본어. */
    subtitleLang: string
  }
}

export const DEFAULT_CONFIG: WaifuConfig = {
  backend: {
    active: 'claude-code',
    failover: true,
    claudeCode: { bin: 'claude' },
    codex: { bin: 'codex' }
  },
  permission: {
    mode: 'guarded',
    workspaces: [],
    autoApprove: ['Read', 'Glob', 'Grep', 'TodoWrite', 'NotebookRead']
  },
  avatar: {
    modelPath: null,
    scale: 1,
    anchor: { x: 0.85, y: 0 },
    alwaysOnTop: true
  },
  voice: {
    enabled: false,
    engineUrl: 'http://127.0.0.1:10101',
    speakerId: 0,
    speedScale: 1,
    sttHotkey: 'Alt+Space'
  },
  persona: {
    name: 'ミオ',
    instructions: '',
    subtitleLang: 'ko'
  }
}

// ─────────────────────── MCP 제어 채널 (mcp server <-> main) ───────────────────────

export const WAIFU_TOOLS = [
  'waifu_say',
  'waifu_express',
  'waifu_motion',
  'waifu_status',
  'ask_permission',
  'remember',
  'recall'
] as const

export type WaifuToolName = (typeof WAIFU_TOOLS)[number]

export interface ControlRequest {
  id: string
  tool: WaifuToolName
  args: Record<string, unknown>
}

export interface ControlResponse {
  id: string
  ok: boolean
  /** ok=true 일 때 MCP 툴 결과로 그대로 반환된다. */
  result?: unknown
  error?: string
}

/** MCP 서버가 접속할 때 쓰는 환경변수 이름. */
export const CONTROL_ENV = {
  port: 'WAIFU_CONTROL_PORT',
  token: 'WAIFU_CONTROL_TOKEN'
} as const

// ─────────────────────── preload 가 노출하는 API ───────────────────────

/**
 * `window.waifu` 의 형태. preload 와 렌더러가 이 인터페이스 하나만 공유한다.
 *
 * 여기서 electron 타입을 참조하면 렌더러 번들에 electron npm 셰임이 끌려 들어와
 * vite 가 `fs`/`child_process` 를 브라우저용으로 외부화하고 런타임에 터진다.
 * 이 파일은 순수 타입만 유지한다.
 */
export interface WaifuApi {
  /** 아바타 창 전용. 구독 해제 함수를 돌려준다. */
  onAvatarCommand(cb: (cmd: AvatarCommand) => void): () => void
  sendAvatarEvent(event: AvatarEvent): void

  /** 패널 창 전용. */
  onPanelEvent(cb: (event: PanelEvent) => void): () => void
  sendMessage(text: string): void
  interrupt(): void
  respondPermission(id: string, decision: PermissionDecision): void

  getConfig(): Promise<WaifuConfig>
  setConfig(patch: Partial<WaifuConfig>): Promise<WaifuConfig>
  pickModel(): Promise<string | null>
}

// ─────────────────────── IPC 채널명 ───────────────────────

export const IPC = {
  /** main -> avatar renderer (webContents.send) */
  avatarCommand: 'avatar:command',
  /** avatar renderer -> main (ipcRenderer.send) */
  avatarEvent: 'avatar:event',
  /** main -> panel renderer */
  panelEvent: 'panel:event',
  /** panel -> main, 유저 발화 전송 */
  sendMessage: 'agent:send',
  /** panel -> main, 현재 턴 중단 */
  interrupt: 'agent:interrupt',
  /** panel -> main, 권한 승인 응답 */
  permissionRespond: 'permission:respond',
  /** panel -> main (invoke), 설정 읽기/쓰기 */
  configGet: 'config:get',
  configSet: 'config:set',
  /** panel -> main (invoke), VRM/FBX 파일 선택 */
  pickModel: 'avatar:pick-model'
} as const
