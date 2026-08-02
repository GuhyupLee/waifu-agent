import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { IPC } from '@shared/protocol'
import type {
  AvatarCommand,
  BackendEvent,
  BackendKind,
  Emotion,
  PanelEvent,
  PermissionDecision,
  PermissionRequest,
  WaifuConfig,
  WaifuToolName
} from '@shared/protocol'
import { writeSessionSettings } from './backends/claudeCode'
import { backendSettings, createBackend, otherBackend } from './backends'
import type { AgentBackend } from './backends/types'
import { ControlServer } from './control/server'
import { mcpLaunchSpec, permissionHookCommand } from './childEntries'
import { buildSystemPrompt } from './persona/prompt'
import { synthesize } from './voice/tts'

/**
 * 백엔드 · 제어 서버 · 아바타 · 패널을 잇는 중심.
 *
 * 양방향이 여기서 만난다:
 *  - 아래로: 유저 발화를 백엔드에 밀어 넣고 스트리밍 이벤트를 받는다
 *  - 위로: 에이전트가 턴 도중 MCP 툴을 불러 아바타를 제어한다
 */
export class Waifu {
  private backend: AgentBackend
  private active: BackendKind
  private unsubscribe: () => void
  private readonly control: ControlServer
  /** 현재 작업 루트. 페일오버로 백엔드를 갈아탈 때 다시 필요하다. */
  private cwd = ''
  /** 한도 때문에 이미 갈아탔는지. 무한 왕복을 막는다. */
  private failedOver = false
  /** 대기 중인 권한 승인. 훅이 응답을 기다리며 붙잡혀 있다. */
  private readonly pending = new Map<string, (d: PermissionDecision) => void>()
  /** 렌더러가 실제로 로드에 성공한 모션 이름. 에이전트에게 이 목록으로만 답한다. */
  private motions: string[] = []

  constructor(
    private readonly config: WaifuConfig,
    private readonly avatar: () => BrowserWindow | null,
    private readonly panel: () => BrowserWindow | null
  ) {
    this.control = new ControlServer((tool, args) => this.onTool(tool, args))
    this.active = config.backend.active
    this.backend = createBackend(this.active)
    this.unsubscribe = this.backend.onEvent((e) => this.onBackendEvent(e))
  }

  async start(cwd: string): Promise<void> {
    await this.control.start()
    this.cwd = cwd
    await this.startBackend()
  }

  private async startBackend(resumeSessionId?: string): Promise<void> {
    const mcp = mcpLaunchSpec()
    const mcpEnv = { ELECTRON_RUN_AS_NODE: '1', ...this.control.childEnv() }
    const mcpConfig = {
      mcpServers: { waifu: { command: mcp.command, args: [...mcp.args], env: mcpEnv } }
    }

    await this.backend.start({
      ...backendSettings(this.config, this.active),
      cwd: this.cwd,
      workspaces: this.config.permission.workspaces,
      permissionMode: this.config.permission.mode,
      mcpConfigJson: JSON.stringify(mcpConfig),
      // Codex 에는 --mcp-config 플래그가 없어 형태가 다르다.
      codexMcp: { command: mcp.command, args: [...mcp.args], env: mcpEnv },
      settingsPath: writeSessionSettings(permissionHookCommand()),
      systemPrompt: buildSystemPrompt(this.config),
      ...(resumeSessionId ? { resumeSessionId } : {}),
      // 훅은 claude 가 spawn 하므로 claude 의 환경을 통해서만 주소를 받을 수 있다.
      extraEnv: { ELECTRON_RUN_AS_NODE: '', ...this.control.childEnv() }
    })
  }

  /**
   * 다른 백엔드로 갈아탄다.
   *
   * 세션은 이어받지 않는다 — Claude Code 의 session id 와 Codex 의 thread id 는
   * 서로 다른 저장소에 있어서 교차 재개가 불가능하다. 사용자에게 맥락이 끊겼음을 알린다.
   */
  private async switchBackend(to: BackendKind, why: string): Promise<void> {
    if (to === this.active) return
    this.unsubscribe()
    await this.backend.stop()

    this.active = to
    this.backend = createBackend(to)
    this.unsubscribe = this.backend.onEvent((e) => this.onBackendEvent(e))
    await this.startBackend()

    this.toPanel({
      type: 'notice',
      level: 'warn',
      message: `${why} ${to} 로 전환했다. 이전 대화 맥락은 이어지지 않는다.`
    })
    process.stdout.write(`[waifu] 백엔드 전환 -> ${to} (${why})\n`)
  }

  send(text: string): void {
    void this.backend.send(text).catch((err: unknown) => {
      this.toPanel({ type: 'notice', level: 'error', message: `전송 실패: ${String(err)}` })
    })
    this.toAvatar({ type: 'status', state: 'thinking' })
  }

  interrupt(): void {
    void this.backend.interrupt()
    this.toAvatar({ type: 'status', state: 'idle' })
  }

  /** 렌더러가 확인해준 재생 가능 모션 목록. main 의 IPC 핸들러에서 넣어준다. */
  setMotions(names: string[]): void {
    this.motions = names
  }

  /** 패널에서 온 권한 응답. 훅이 이 값을 기다리고 있다. */
  resolvePermission(id: string, decision: PermissionDecision): void {
    const resolve = this.pending.get(id)
    if (!resolve) return
    this.pending.delete(id)
    resolve(decision)
    this.toPanel({ type: 'permission-resolved', id })
  }

  async stop(): Promise<void> {
    await this.backend.stop()
    await this.control.stop()
  }

  // ─────────────────────── 에이전트 → 아바타 ───────────────────────

  private async onTool(tool: WaifuToolName, args: Record<string, unknown>): Promise<unknown> {
    switch (tool) {
      case 'waifu_say':
        return this.say(args)

      case 'waifu_express':
        this.toAvatar({
          type: 'express',
          emotion: args.emotion as Emotion,
          ...(typeof args.intensity === 'number' ? { intensity: args.intensity } : {})
        })
        return 'ok'

      case 'waifu_motion':
        this.toAvatar({
          type: 'motion',
          name: String(args.name ?? ''),
          ...(typeof args.loop === 'boolean' ? { loop: args.loop } : {})
        })
        return 'ok'

      case 'waifu_status':
        this.toAvatar({ type: 'status', state: args.state as never })
        // 툴 설명에서 "사용 가능한 모션은 여기서 알려준다"고 약속했다.
        // 목록이 비어 있으면 그렇다고 말해야 한다 — 없는 모션을 부르게 두면 안 된다.
        return this.motions.length
          ? `ok. 사용 가능한 모션: ${this.motions.join(', ')}`
          : 'ok. 등록된 모션이 없다. waifu_motion 을 부르지 마라.'

      case 'ask_permission':
        return this.askPermission(args)

      case 'remember':
      case 'recall':
        // Phase 6. 지금 성공한 척하면 에이전트가 기억이 저장된 줄 알고 행동한다.
        throw new Error('기억 기능은 아직 구현되지 않았다')

      default:
        throw new Error(`알 수 없는 툴: ${tool}`)
    }
  }

  /**
   * 말하기. 자막은 항상 띄우고, 음성은 가능할 때만 붙인다.
   *
   * TTS 가 실패해도 발화 자체를 실패시키지 않는다 — 엔진이 안 떠 있다고 대화가
   * 멈추면 안 된다. 대신 에이전트에게는 무음이었다고 알려준다. 조용히 성공한 척하면
   * 에이전트는 자기 말이 들린 줄 안다.
   */
  private async say(args: Record<string, unknown>): Promise<string> {
    const id = randomUUID()
    const text = String(args.text ?? '')
    const speech = typeof args.speech_ja === 'string' ? args.speech_ja.trim() : ''

    const cmd: AvatarCommand = {
      type: 'say',
      id,
      text,
      ...(args.emotion ? { emotion: args.emotion as Emotion } : {}),
      ...(args.motion ? { motion: String(args.motion) } : {})
    }

    if (!this.config.voice.enabled || !speech) {
      this.toAvatar(cmd)
      return this.config.voice.enabled ? 'ok (speech_ja 가 없어 무음 자막만 띄웠다)' : 'ok (음성 꺼짐)'
    }

    try {
      const { audio, visemes } = await synthesize(speech, {
        engineUrl: this.config.voice.engineUrl,
        speakerId: this.config.voice.speakerId,
        speedScale: this.config.voice.speedScale
      })
      this.toAvatar({ ...cmd, audio, visemes })
      return 'ok'
    } catch (err) {
      process.stderr.write(`[voice] 합성 실패: ${String(err)}\n`)
      this.toAvatar(cmd)
      return `ok (음성 합성 실패로 자막만 띄웠다: ${(err as Error).message})`
    }
  }

  /**
   * 훅이 물어온 권한을 사용자에게 넘긴다.
   *
   * 설정의 autoApprove 에 있으면 묻지 않는다. 그 외에는 패널에 카드를 띄우고
   * 사용자가 누를 때까지 이 Promise 를 붙잡아 둔다 — 훅도 그 동안 대기한다.
   */
  private askPermission(args: Record<string, unknown>): Promise<PermissionDecision> {
    const toolName = String(args.toolName ?? 'unknown')

    if (this.config.permission.mode === 'auto') {
      return Promise.resolve({ behavior: 'allow' })
    }
    if (this.config.permission.autoApprove.includes(toolName)) {
      return Promise.resolve({ behavior: 'allow' })
    }
    if (this.config.permission.mode === 'readonly') {
      return Promise.resolve({
        behavior: 'deny',
        message: `'대화만 하기' 모드라 ${toolName} 을 실행하지 않았다.`
      })
    }

    const request: PermissionRequest = {
      id: randomUUID(),
      toolName,
      input: args.input,
      ...(typeof args.reason === 'string' ? { reason: args.reason } : {})
    }

    return new Promise<PermissionDecision>((resolve) => {
      this.pending.set(request.id, resolve)
      this.toAvatar({ type: 'status', state: 'thinking' })
      this.toPanel({ type: 'permission-request', request })
      const panel = this.panel()
      // 승인 카드가 뒤에 가려져 있으면 사용자는 앱이 멈춘 줄 안다.
      panel?.show()
    })
  }

  // ─────────────────────── 백엔드 → UI ───────────────────────

  private onBackendEvent(e: BackendEvent): void {
    this.toPanel({ type: 'backend', event: e })

    switch (e.type) {
      case 'session': {
        // 와이프 MCP 서버가 안 붙으면 에이전트는 아바타를 전혀 제어할 수 없다.
        // 조용히 지나가면 "왜 표정이 안 바뀌지?" 로 한참 헤매게 된다.
        const waifuMcp = e.mcpServers?.find((s) => s.name === 'waifu')
        const status = waifuMcp?.status ?? '없음'
        process.stdout.write(`[waifu] 세션 ${e.sessionId} · 제어 MCP: ${status}\n`)
        if (status !== 'connected') {
          this.toPanel({
            type: 'notice',
            level: 'warn',
            message: `아바타 제어 채널이 붙지 않았다 (${status}). 표정과 모션이 동작하지 않는다.`
          })
        }
        break
      }

      case 'tool-start':
        this.toAvatar({ type: 'status', state: 'working' })
        break
      case 'text-delta':
        this.toAvatar({ type: 'status', state: 'speaking' })
        break
      case 'result':
        this.toAvatar({ type: 'status', state: e.isError ? 'error' : 'idle' })
        break
      case 'error':
        this.toAvatar({ type: 'status', state: 'error' })
        // rate-limit 로 분류된 실패도 전환 대상이다. 한쪽이 막히면 다른 쪽으로 계속 일한다.
        if (e.kind === 'rate-limit') this.maybeFailover('사용량 한도에 걸려')
        break
      case 'rate-limit':
        // status 가 allowed 가 아니면 한도에 걸린 것이다.
        if (e.info.status !== 'allowed') {
          const at = e.info.resetsAt ? new Date(e.info.resetsAt * 1000).toLocaleTimeString() : '미상'
          this.toPanel({
            type: 'notice',
            level: 'warn',
            message: `사용량 한도(${e.info.rateLimitType})에 걸렸다. ${at} 에 풀린다.`
          })
          this.maybeFailover('사용량 한도에 걸려')
        }
        break
      default:
        break
    }
  }

  /**
   * 한도에 걸렸을 때 반대편 백엔드로 넘긴다.
   *
   * 한 번만 한다. 양쪽 다 막힌 상황에서 계속 왕복하면 아무 일도 못 하면서
   * 프로세스만 계속 띄웠다 죽인다.
   */
  private maybeFailover(why: string): void {
    if (!this.config.backend.failover || this.failedOver) return
    this.failedOver = true
    void this.switchBackend(otherBackend(this.active), why).catch((err: unknown) => {
      this.toPanel({ type: 'notice', level: 'error', message: `백엔드 전환 실패: ${String(err)}` })
    })
  }

  private toAvatar(cmd: AvatarCommand): void {
    const win = this.avatar()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.avatarCommand, cmd)
  }

  private toPanel(evt: PanelEvent): void {
    const win = this.panel()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.panelEvent, evt)
  }
}
