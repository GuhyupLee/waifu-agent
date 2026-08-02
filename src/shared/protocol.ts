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
  /**
   * 렌더러가 반영해야 하는 설정값들.
   *
   * 설정 화면에서 바꾼 값이 앱을 다시 켜야만 적용되면 조절해보면서 맞출 수가 없다.
   * 재시작 없이 반영 가능한 것들은 여기로 흘려보낸다.
   */
  | {
      type: 'tuning'
      hitAlpha: number
      swayStrength: number
      ambientMotion: boolean
      showSubtitle: boolean
      subtitleMinMs: number
      scale: number
    }
  /**
   * 푸시투토크 녹음 토글.
   *
   * Electron 의 globalShortcut 은 키를 뗀 시점을 알려주지 않으므로 "누르고 있는 동안"이
   * 아니라 토글로 동작한다. 마이크 접근이 렌더러에만 있어서 녹음 자체는 저쪽에서 한다.
   */
  | { type: 'record'; on: boolean }
  /**
   * 절전에서 깨어났다. 스프링 본을 초기화해야 한다 —
   * 몇 시간치 delta 를 한 번에 적분하면 머리카락이 날아간다.
   */
  | { type: 'wake' }
  /**
   * 화면을 가로질러 이동 중. 방향은 -1 왼쪽, +1 오른쪽, 0 제자리.
   * 렌더러가 이동 모션을 재생하고 몸을 진행 방향으로 살짝 기울인다.
   */
  | { type: 'roam'; moving: boolean; direction: -1 | 0 | 1 }
  /**
   * 존재감 설정을 통째로 밀어넣는다 (Phase 2).
   *
   * `tuning` 에 합치지 않은 이유: 저쪽은 기존 렌더러가 쓰는 고정 모양이라 필드를
   * 늘리면 두 소비자가 같이 굳는다. 그리고 이 설정은 Unity 셸만 해석한다.
   */
  | { type: 'presence-config'; settings: PresenceSettings }
  /**
   * 재우거나 깨운다. 보통은 셸이 유휴 시간을 보고 스스로 판단하지만,
   * 에이전트가 말을 걸면 main 이 깨워야 한다.
   */
  | { type: 'set-presence'; asleep: boolean }

/**
 * 아바타가 "거기 살고 있는" 것처럼 보이게 하는 설정들 (Phase 2).
 *
 * **전부 끌 수 있어야 한다.** 데스크탑에 상주하는 것이라 취향과 작업 방해 정도가
 * 사람마다 크게 갈린다. 끄는 길이 없으면 앱을 지우는 것이 유일한 선택지가 된다.
 *
 * 이 설정들이 만드는 반응에는 **LLM 을 부르지 않는다.** idle 전환, 클릭 반응,
 * 시간대 반응은 규칙으로 처리한다 — 구독 한도를 태우고 지연도 눈에 띈다.
 */
export interface PresenceSettings {
  /** 여러 idle 클립을 번갈아 재생한다. */
  idle: {
    enabled: boolean
    /** 한 클립을 유지하는 시간 범위(초). 지수분포로 뽑아 규칙성을 지운다. */
    minHoldSec: number
    maxHoldSec: number
  }
  /**
   * 커서를 눈·머리·상체가 따라본다. 각 세기는 0(안 봄)..1(기본).
   * 셋을 같은 곡선으로 움직이면 눈이 머리에 붙어 보이므로 따로 둔다.
   */
  tracking: {
    enabled: boolean
    eye: number
    head: number
    body: number
  }
  /** 만지면 반응한다 (머리 쓰다듬기·찌르기). */
  touch: boolean
  /** 잡아 끌 때 전용 모션을 쓴다. 끄면 자세 그대로 끌린다. */
  dragMotion: boolean
  /** 창이 화면 밖으로 나가지 않게 붙잡는다. */
  clampToScreen: boolean
  /**
   * 오래 두면 잔다.
   *
   * 시간대 규칙은 `byClock` 으로 켠다. "null 이면 규칙 없음" 같은 암묵적 약속을 쓰지
   * 않는 이유가 둘이다 — 설정 파일을 손으로 고치는 사람에게 의미가 드러나야 하고,
   * Unity 의 JsonUtility 는 null 을 int 로 받으면 **0(자정)으로 읽어** 의도하지 않은
   * 시간에 아바타를 재운다.
   */
  sleep: {
    enabled: boolean
    afterIdleMin: number
    byClock: boolean
    /** `byClock` 이 false 면 무시한다. 자정을 넘기는 구간(23 -> 7)도 된다. */
    fromHour: number
    toHour: number
  }
  /** 말풍선으로 자막을 띄운다. */
  bubble: {
    enabled: boolean
    /** 이보다 길면 잘라 보여준다. 긴 답변이 화면을 덮는 것을 막는다. */
    maxChars: number
  }
}

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
   * **에이전트가 부를 수 있는** 모션 이름들.
   *
   * 두 가지를 걸러낸 결과다:
   *  - 로드에 실패한 것 (깨진 .vrma 는 파일은 있는데 재생이 안 된다)
   *  - 포인터 좌표와 함께만 의미가 있는 상호작용 전용 모션 (mouse-tether 류)
   *
   * 그래서 등록한 파일 수보다 적은 게 정상이다. 에이전트에게 알려줄 수 있는
   * 유일한 신뢰 가능한 목록이다.
   */
  | { type: 'motions'; names: string[] }
  /**
   * `presets` 는 모델이 실제로 들고 있는 VRM 표정 프리셋 이름들이다.
   * 없는 프리셋에 setValue 해도 에러 없이 조용히 무시되므로, 표정이 안 먹을 때
   * 제일 먼저 확인해야 할 정보다.
   */
  | { type: 'model-loaded'; ok: true; hasExpressions: boolean; hasLookAt: boolean; presets: string[] }
  | { type: 'model-loaded'; ok: false; error: string }
  | { type: 'fps'; value: number }
  | { type: 'clicked' }
  /** 녹음이 끝났다. 16kHz 모노 WAV 를 base64 로 싣는다. 소리가 없었으면 null. */
  | { type: 'recorded'; wavBase64: string | null }
  /** 녹음 상태 변화. UI 표시용. */
  | { type: 'recording'; on: boolean }
  /**
   * 사용자가 아바타를 만졌다. 아바타의 반응(표정·모션)은 렌더러가 이미 처리했고,
   * 이건 에이전트가 알아도 되는 사건이라 main 으로 올린다.
   */
  | { type: 'touched'; bone: string; kind: string }
  /**
   * 잠들거나 깼다. 셸이 스스로 판단한 결과도 여기로 올라온다 —
   * main 이 모르면 자는 아바타에게 말을 걸어놓고 왜 반응이 없는지 알 수 없다.
   */
  | { type: 'presence'; asleep: boolean }

// ─────────────────────── Unity Avatar Bridge (전송 계층) ───────────────────────

/**
 * 브리지 프로토콜 버전. **호환되지 않는 변경마다 올린다.**
 *
 * Unity 는 Electron 과 따로 빌드되므로 버전이 어긋난 조합이 실제로 생긴다 —
 * 앱만 업데이트하고 예전 플레이어가 남아 있는 경우다. 그때 조용히 반쯤 동작하면
 * "명령이 가끔 안 먹는다"는 재현 불가능한 버그가 된다. 핸드셰이크에서 끊는 편이 낫다.
 */
export const AVATAR_PROTOCOL_VERSION = 1

/** Unity 프로세스에 넘길 환경변수 이름. `CONTROL_ENV` 와 같은 패턴이다. */
export const AVATAR_BRIDGE_ENV = {
  port: 'WAIFU_AVATAR_PORT',
  token: 'WAIFU_AVATAR_TOKEN'
} as const

/**
 * 창을 세울 때 필요한 값들. **명령이 아니라 환경변수인 이유**가 있다.
 *
 * 이 값들은 첫 프레임을 그리기 **전에** 정해져야 한다. 핸드셰이크 뒤에 명령으로
 * 보내면 창이 기본 위치에 한 번 떴다가 옮겨가는 게 보인다 — 투명 창이라 그 깜빡임이
 * 유난히 눈에 띈다. 비밀값이 아니므로 환경변수로 넘겨도 잃을 것이 없다.
 */
export const AVATAR_WINDOW_ENV = {
  anchorX: 'WAIFU_AVATAR_ANCHOR_X',
  anchorY: 'WAIFU_AVATAR_ANCHOR_Y',
  alwaysOnTop: 'WAIFU_AVATAR_TOPMOST',
  hitAlpha: 'WAIFU_AVATAR_HIT_ALPHA',
  scale: 'WAIFU_AVATAR_SCALE',
  modelPath: 'WAIFU_AVATAR_MODEL'
} as const

/**
 * 연결 후 Unity 가 보내야 하는 **첫 메시지**. 이것 말고 다른 게 먼저 오면 끊는다.
 *
 * 토큰을 URL 쿼리가 아니라 첫 프레임에 싣는 이유: 쿼리 문자열은 접속 로그와
 * 프로세스 목록에 남는다. 같은 머신의 다른 프로세스가 읽을 수 있으면 토큰의 의미가 없다.
 */
export interface AvatarHello {
  type: 'hello'
  token: string
  protocolVersion: number
  client: 'unity'
}

/**
 * 핸드셰이크 결과. 실패해도 이유를 돌려주고 끊는다 —
 * 아무 말 없이 끊으면 Unity 쪽에서 토큰이 틀린 건지 앱이 죽은 건지 구분할 수 없다.
 */
export type AvatarHelloAck =
  | { type: 'hello-ack'; ok: true; protocolVersion: number }
  | { type: 'hello-ack'; ok: false; reason: 'bad-token' | 'bad-version' | 'malformed' }

/** main -> Unity. 인증 후에만 흐른다. */
export interface AvatarCommandEnvelope {
  type: 'command'
  seq: number
  command: AvatarCommand
}

/** Unity -> main. 인증 후에만 받는다. */
export interface AvatarEventEnvelope {
  type: 'event'
  event: AvatarEvent
}

/** 브리지 위를 오가는 모든 메시지. 한 프레임에 이 객체 **하나**다. */
export type AvatarBridgeMessage =
  | AvatarHello
  | AvatarHelloAck
  | AvatarCommandEnvelope
  | AvatarEventEnvelope

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
    /**
     * 클릭 판정 알파 임계값 (0..255). 낮을수록 실루엣 가장자리까지 잡는다.
     * forward:true 상태에서는 클릭이 전달되지 않으므로, 커서가 몸에 닿기 전에
     * 전환이 끝나야 첫 클릭을 잃지 않는다.
     */
    hitAlpha: number
    /** 잡아 끌 때 흔들리는 정도. 0 이면 흔들리지 않는다. */
    swayStrength: number
    /** 유휴 시 스스로 둘러보거나 기지개를 켜는 행동. */
    ambientMotion: boolean
    /**
     * 아바타를 무엇이 그리는가.
     *
     * 이관 기간 동안 둘을 **병행**시키기 위한 스위치다. Unity 셸이 아직 못 하는 게
     * 남아 있는 동안 기존 렌더러를 지우면 되돌아갈 곳이 없어진다.
     */
    renderer: 'renderer' | 'unity'
    /** Phase 2 존재감. 전부 끌 수 있다. */
    presence: PresenceSettings
    /**
     * 모니터마다 위치와 배율을 따로 기억한다.
     *
     * 노트북을 외부 모니터에 붙였다 뗐다 하면 해상도가 바뀌는데, 하나만 기억하면
     * 매번 아바타가 엉뚱한 자리에 뜨거나 화면 밖으로 나간다.
     */
    rememberPerMonitor: boolean
    /** 모니터 식별자 -> 저장된 배치. `rememberPerMonitor` 가 켜져 있을 때만 쓴다. */
    perMonitor: Record<string, { anchor: { x: number; y: number }; scale: number }>
  }
  /** OS 통합. Windows 전용 기능은 다른 OS 에서 조용히 꺼진다. */
  system: {
    /** 로그인할 때 자동 실행. */
    launchAtLogin: boolean
    /** 시스템 트레이 아이콘을 띄운다. */
    trayIcon: boolean
    /** 창을 닫아도 종료하지 않고 트레이에 남는다. */
    closeToTray: boolean
  }
  unity: {
    /**
     * Unity 플레이어 실행 파일. 비어 있으면 Unity 셸을 띄우지 않는다.
     * 개발 중에는 빌드한 플레이어를 직접 가리킨다.
     */
    playerPath: string
    /**
     * 비정상 종료 시 재시작 시도 횟수 상한.
     *
     * 무한 재시작은 죽은 셸을 계속 되살리며 로그만 채운다. 상한에 닿으면
     * 포기하고 사용자에게 알린다 — 조용히 멈추면 아바타가 왜 없는지 알 수 없다.
     */
    maxRestarts: number
    /** 이 시간 안에 핸드셰이크가 안 오면 실패로 본다. */
    launchTimeoutMs: number
  }
  chat: {
    /** 자막이 화면에 머무는 최소 시간(ms). 긴 말은 글자 수에 비례해 늘어난다. */
    subtitleMinMs: number
    /** 자막을 아예 띄우지 않는다. 음성만 쓸 때. */
    showSubtitle: boolean
    /** 패널에 툴 실행과 활동 로그를 보여준다. 끄면 대화만 남는다. */
    showActivity: boolean
  }
  voice: {
    enabled: boolean
    /** VOICEVOX 호환 엔진 주소. AivisSpeech 10101, VOICEVOX 50021. */
    engineUrl: string
    speakerId: number
    speedScale: number
    /** STT 푸시투토크 핫키 (Electron accelerator 문법). */
    sttHotkey: string
    /**
     * 음성 인식. whisper.cpp 를 쓴다.
     *
     * 바이너리와 모델은 앱이 받지 않는다 — 사용자가 이미 가진 것을 가리키게 한다.
     * 둘 중 하나라도 비어 있으면 음성 입력은 꺼진 상태로 둔다.
     */
    stt: {
      /** whisper-cli.exe (또는 main.exe) 절대 경로. */
      whisperPath: string
      /** ggml 모델 파일 절대 경로. */
      modelPath: string
      /** whisper 의 -l 인자. 'auto' 도 된다. */
      language: string
    }
  }
  persona: {
    name: string
    /** 시스템 프롬프트에 덧붙는 캐릭터 설정. */
    instructions: string
    /** 자막 언어. TTS 는 항상 일본어. */
    subtitleLang: string
  }
  /**
   * 밖에서 부탁하고 결과를 받는 통로.
   *
   * 이건 **외부에서 내 PC 를 조종하는 입구**다. 토큰이 없거나 허용 목록이 비어 있으면
   * 아예 켜지지 않는다 — 실수로 열어두는 쪽보다 안 켜지는 쪽이 낫다.
   */
  /** 먼저 말을 거는 것에 대한 규칙. */
  notify: {
    /**
     * 이 시간대에는 먼저 말을 걸지 않는다. 걸린 알림은 버리지 않고 창이 끝날 때까지 미룬다.
     * from 과 to 가 같으면 방해 금지가 없다. "HH:MM".
     */
    quietFrom: string
    quietTo: string
  }
  discord: {
    enabled: boolean
    /** 봇 토큰. 사용자가 Discord 개발자 포털에서 발급한다. */
    token: string
    /**
     * 이 사용자 ID 들의 DM 만 받는다. 비어 있으면 봇이 시작되지 않는다.
     * 봇 초대 링크를 아는 누구나 PC 를 조종할 수 있으면 안 된다.
     */
    allowedUserIds: string[]
    /**
     * 원격 요청에 허용할 최대 권한. 'auto'(맡겨두기)는 고를 수 없다 —
     * 눈앞에 없는 사람이 무제한 자동 실행을 시키는 건 위험하다.
     */
    maxPermission: 'readonly' | 'guarded'
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
    alwaysOnTop: true,
    hitAlpha: 8,
    swayStrength: 1,
    ambientMotion: true,
    renderer: 'renderer',
    presence: {
      idle: { enabled: true, minHoldSec: 8, maxHoldSec: 40 },
      tracking: { enabled: true, eye: 1, head: 1, body: 0.5 },
      touch: true,
      dragMotion: true,
      clampToScreen: true,
      // 기본은 유휴 시간만 본다. 시간대로 재우는 건 사람마다 생활 패턴이 달라
      // 켜는 사람만 켜게 둔다.
      sleep: { enabled: true, afterIdleMin: 20, byClock: false, fromHour: 23, toHour: 7 },
      bubble: { enabled: true, maxChars: 140 }
    },
    rememberPerMonitor: true,
    perMonitor: {}
  },
  system: {
    launchAtLogin: false,
    trayIcon: true,
    closeToTray: true
  },
  unity: {
    playerPath: '',
    maxRestarts: 3,
    launchTimeoutMs: 20000
  },
  chat: {
    subtitleMinMs: 2500,
    showSubtitle: true,
    showActivity: true
  },
  voice: {
    enabled: false,
    engineUrl: 'http://127.0.0.1:10101',
    speakerId: 0,
    speedScale: 1,
    sttHotkey: 'Alt+Space',
    stt: { whisperPath: '', modelPath: '', language: 'ko' }
  },
  persona: {
    name: 'ミオ',
    instructions: '',
    subtitleLang: 'ko'
  },
  notify: { quietFrom: '23:00', quietTo: '08:00' },
  discord: {
    enabled: false,
    token: '',
    allowedUserIds: [],
    maxPermission: 'guarded'
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
  'recall',
  /** 지금 진행 중인 작업의 상태를 갱신한다. 재개할 때 어디서부터인지 아는 근거가 된다. */
  'task_update',
  /** 작업 저널에 한 줄 남긴다. "어디까지 했어?" 에 답할 재료다. */
  'task_note',
  /** 다른 작업들의 상태를 본다. */
  'task_list',
  /** 아바타를 다른 모니터로 옮긴다. */
  'waifu_move',
  /** 시간이 되면 먼저 말을 걸도록 예약한다. */
  'remind_me',
  'reminder_list',
  'reminder_cancel',
  /** "이거 봐줘" — 사용자가 보여주는 화면이나 클립보드를 본다. */
  'look_at_screen',
  'read_clipboard',
  /** 자주 하는 일을 이름 붙여 저장하고 다시 꺼낸다. */
  'routine_save',
  'routine_list',
  'routine_recall'
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

  /** 에이전트가 바꾼 파일 목록과 되돌리기. */
  listChanges(): Promise<FileChange[]>
  undoChange(id: string): Promise<{ ok: boolean; reason?: string }>

  /** 저장된 것들을 보고 지운다. */
  listMemories(): Promise<StoredMemory[]>
  forgetMemory(key: string): Promise<boolean>
  listRoutines(): Promise<StoredRoutine[]>
  removeRoutine(name: string): Promise<boolean>
  listReminders(): Promise<StoredReminder[]>
  cancelReminder(id: string): Promise<boolean>

  diagnostics(): Promise<Diagnostics>
  /** TTS 엔진 버전. 안 떠 있으면 null. */
  pingVoice(url: string): Promise<string | null>
}

export interface StoredMemory {
  key: string
  value: string
  updatedAt: number
}

export interface StoredRoutine {
  name: string
  summary: string
  runCount: number
  lastRunAt: number | null
}

export interface StoredReminder {
  id: string
  text: string
  dueAt: number
  repeat: string
  channel: string
}

export interface Diagnostics {
  backend: BackendKind
  sessionId: string | null
  busy: boolean
  motions: number
  activeTasks: number
  memories: number
}

/** 되돌리기 UI 가 보여줄 한 건. */
export interface FileChange {
  id: string
  path: string
  at: number
  toolName: string
  /** 새로 만든 파일이면 되돌릴 원본이 없다. */
  hasBackup: boolean
  restoredAt: number | null
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
  pickModel: 'avatar:pick-model',
  /** panel -> main (invoke), 파일 변경 이력과 되돌리기 */
  changesList: 'safety:list',
  changesUndo: 'safety:undo',
  /** panel -> main (invoke), 저장된 것들 조회·삭제 */
  memoryList: 'store:memories',
  memoryForget: 'store:memory-forget',
  routineList: 'store:routines',
  routineRemove: 'store:routine-remove',
  reminderList: 'store:reminders',
  reminderCancel: 'store:reminder-cancel',
  /** panel -> main (invoke), 현재 상태 진단 */
  diagnostics: 'app:diagnostics',
  /** panel -> main (invoke), TTS 엔진이 살아 있는지 */
  pingVoice: 'voice:ping'
} as const
