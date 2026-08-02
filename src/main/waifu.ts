import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { IPC } from '@shared/protocol'
import type {
  AvatarCommand,
  BackendEvent,
  Emotion,
  PanelEvent,
  PermissionDecision,
  PermissionRequest,
  WaifuConfig,
  WaifuToolName
} from '@shared/protocol'
import { ClaudeCodeBackend, writeSessionSettings } from './backends/claudeCode'
import type { AgentBackend } from './backends/types'
import { ControlServer } from './control/server'
import { mcpLaunchSpec, permissionHookCommand } from './childEntries'
import { buildSystemPrompt } from './persona/prompt'

/**
 * 백엔드 · 제어 서버 · 아바타 · 패널을 잇는 중심.
 *
 * 양방향이 여기서 만난다:
 *  - 아래로: 유저 발화를 백엔드에 밀어 넣고 스트리밍 이벤트를 받는다
 *  - 위로: 에이전트가 턴 도중 MCP 툴을 불러 아바타를 제어한다
 */
export class Waifu {
  private readonly backend: AgentBackend = new ClaudeCodeBackend()
  private readonly control: ControlServer
  /** 대기 중인 권한 승인. 훅이 응답을 기다리며 붙잡혀 있다. */
  private readonly pending = new Map<string, (d: PermissionDecision) => void>()

  constructor(
    private readonly config: WaifuConfig,
    private readonly avatar: () => BrowserWindow | null,
    private readonly panel: () => BrowserWindow | null
  ) {
    this.control = new ControlServer((tool, args) => this.onTool(tool, args))
    this.backend.onEvent((e) => this.onBackendEvent(e))
  }

  async start(cwd: string): Promise<void> {
    await this.control.start()

    const mcp = mcpLaunchSpec()
    const mcpConfig = {
      mcpServers: {
        waifu: {
          command: mcp.command,
          args: [...mcp.args],
          env: { ELECTRON_RUN_AS_NODE: '1', ...this.control.childEnv() }
        }
      }
    }

    await this.backend.start({
      bin: this.config.backend.claudeCode.bin,
      cwd,
      workspaces: this.config.permission.workspaces,
      permissionMode: this.config.permission.mode,
      mcpConfigJson: JSON.stringify(mcpConfig),
      settingsPath: writeSessionSettings(permissionHookCommand()),
      systemPrompt: buildSystemPrompt(this.config),
      ...(this.config.backend.claudeCode.model
        ? { model: this.config.backend.claudeCode.model }
        : {}),
      // 훅은 claude 가 spawn 하므로 claude 의 환경을 통해서만 주소를 받을 수 있다.
      extraEnv: { ELECTRON_RUN_AS_NODE: '', ...this.control.childEnv() }
    })
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
      case 'waifu_say': {
        const id = randomUUID()
        this.toAvatar({
          type: 'say',
          id,
          text: String(args.text ?? ''),
          ...(args.emotion ? { emotion: args.emotion as Emotion } : {}),
          ...(args.motion ? { motion: String(args.motion) } : {})
        })
        // TTS 는 Phase 4 에서 붙는다. 지금은 자막만 띄우고 바로 돌려준다.
        return 'ok'
      }

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
        return 'ok'

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
        break
      case 'rate-limit':
        // status 가 allowed 가 아니면 한도에 걸린 것이다. resetsAt 으로 재개를 예약할 수 있다.
        if (e.info.status !== 'allowed') {
          const at = e.info.resetsAt ? new Date(e.info.resetsAt * 1000).toLocaleTimeString() : '미상'
          this.toPanel({
            type: 'notice',
            level: 'warn',
            message: `사용량 한도(${e.info.rateLimitType})에 걸렸다. ${at} 에 풀린다.`
          })
        }
        break
      default:
        break
    }
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
