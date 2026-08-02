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
import { MemoryStore } from './persona/memory'
import { TaskStore } from './tasks/store'
import { SnapshotStore } from './safety/snapshots'
import { clampRemotePermission } from './discord/bot'
import {
  DEFAULT_ROAM,
  currentDisplayIndex,
  orderedDisplays,
  resolveTarget,
  restingSpot,
  roamTo
} from './roaming'
import type { RoamHandle } from './roaming'
import { ReminderStore, resolveReminderTime } from './reminders/store'
import { isQuiet, quietEndsAt } from './reminders/quietHours'
import { captureScreen, readClipboardImage, readClipboardText } from './capture'
import type { PermissionMode } from '@shared/protocol'
import {
  extractCommand,
  extractFilePath,
  findDangers,
  isOverwritingTool,
  isShellTool
} from './safety/destructive'
import type { Task, TaskOrigin, TaskState } from './tasks/store'
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
  private readonly memory = new MemoryStore()
  private readonly tasks = new TaskStore()
  private readonly snapshots = new SnapshotStore()
  /** 진행 중인 이동. 새 이동이 들어오면 취소한다 — 겹치면 창이 떨린다. */
  private roaming: RoamHandle | null = null
  private readonly reminders = new ReminderStore()
  private reminderTimer: NodeJS.Timeout | null = null
  /** 지금 턴이 속한 작업. 에이전트의 task_* 툴은 이걸 대상으로 한다. */
  private current: Task | null = null

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
    // 30초면 분 단위 알림에 충분하고, 켜둬도 부담이 없다.
    this.reminderTimer = setInterval(() => this.fireDueReminders(), 30_000)
    this.fireDueReminders()
  }

  /**
   * 울릴 때가 된 알림을 처리한다.
   *
   * 방해 금지 시간에 걸리면 **버리지 않고 미룬다.** 알림을 놓치는 것과 새벽에 깨우는 것
   * 둘 다 피해야 한다. 아침에 밀린 것이 한 번에 오는 편이 낫다.
   */
  private fireDueReminders(): void {
    const now = new Date()
    const quiet = { from: this.config.notify.quietFrom, to: this.config.notify.quietTo }

    for (const r of this.reminders.due(now.getTime())) {
      if (isQuiet(now, quiet)) {
        const until = quietEndsAt(now, quiet)
        if (until) {
          this.reminders.postpone(r.id, until)
          continue
        }
      }

      this.reminders.markFired(r.id, now.getTime())

      if (r.channel !== 'discord') {
        this.toAvatar({ type: 'say', id: r.id, text: r.text, emotion: 'happy' })
        this.toPanel({ type: 'notice', level: 'info', message: `⏰ ${r.text}` })
      }
      if (r.channel !== 'desktop') this.onRemoteReport?.(`⏰ ${r.text}`)

      if (r.taskId) this.tasks.append(r.taskId, 'note', `알림 울림: ${r.text}`)
    }
  }

  /** Discord 로 먼저 연락할 때 쓰는 통로. index.ts 가 꽂아준다. */
  onRemoteReport: ((text: string) => void) | null = null

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
      // 훅은 claude 가 spawn 하므로 claude 의 환경을 통해서만 이 값들을 받는다.
      //
      // ELECTRON_RUN_AS_NODE 를 빼거나 빈 문자열로 두면 훅이 조용히 죽는다 —
      // 훅 명령이 Electron 바이너리인데, 이 변수가 없으면 스크립트를 실행하는 대신
      // Electron 앱으로 뜬다. 증상은 "권한 창이 안 뜨고 전부 통과됨" 이라
      // 안전망이 사라진 걸 알아채기 어렵다. 실제로 이 상태로 한 번 만들었었다.
      // claude 자신은 Electron 앱이 아니라 이 변수의 영향을 받지 않는다.
      extraEnv: { ELECTRON_RUN_AS_NODE: '1', ...this.control.childEnv() }
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

  /**
   * 이번 턴이 원격 요청인지. 권한 판정에 쓴다.
   *
   * 훅은 `session_id` 밖에 모르지만, 실제로는 한 번에 한 턴만 돈다.
   * 현재 Task 의 origin 을 보면 충분하다.
   */
  private effectivePermission(): PermissionMode {
    const base = this.config.permission.mode
    if (this.current?.origin !== 'discord') return base
    return clampRemotePermission(base, this.config.discord.maxPermission)
  }

  /**
   * 원격 요청의 답신 통로. 턴이 끝나면 여기로 결과를 보낸다.
   * 데스크탑 요청이면 null 이다 — 화면에 이미 보이는 걸 다시 보낼 이유가 없다.
   */
  private replyTo: ((text: string) => void) | null = null

  send(text: string, origin: TaskOrigin = 'desktop', replyTo?: (text: string) => void): void {
    this.replyTo = replyTo ?? null

    // 이어갈 작업이 없으면 새로 만든다. 제목은 첫 발화에서 따고, 에이전트가
    // 더 정확한 이름을 알게 되면 task_update 로 고친다.
    if (!this.current || this.current.state === 'done' || this.current.state === 'failed') {
      this.current = this.tasks.create({
        title: text.slice(0, 60),
        cwd: this.cwd,
        backend: this.active,
        origin
      })
    }
    this.tasks.append(this.current.id, 'user', text)
    this.current = this.tasks.update(this.current.id, { state: 'running', needsUser: '' })

    void this.backend.send(text).catch((err: unknown) => {
      this.toPanel({ type: 'notice', level: 'error', message: `전송 실패: ${String(err)}` })
    })
    this.toAvatar({ type: 'status', state: 'thinking' })
  }

  /** 아직 끝나지 않은 작업들. 앱을 다시 켰을 때 이어서 보여준다. */
  activeTasks(): Task[] {
    return this.tasks.active()
  }

  /**
   * 앱을 다시 켰을 때 남아 있던 작업을 사용자에게 보여준다.
   *
   * 자동으로 재개하지는 않는다. 껐다 켠 사이에 상황이 바뀌었을 수 있고, 사용자가
   * 모르는 사이에 파일을 건드리기 시작하면 곤란하다. 무엇이 남았는지 알리고 기다린다.
   */
  reportPendingTasks(): void {
    const active = this.tasks.active()
    if (active.length === 0) return

    for (const t of active) {
      const bits = [`${t.title} (${t.state})`]
      if (t.nextAction) bits.push(`다음: ${t.nextAction}`)
      if (t.needsUser) bits.push(`확인 필요: ${t.needsUser}`)
      this.toPanel({ type: 'notice', level: 'info', message: `· ${bits.join(' — ')}` })
    }
    this.toPanel({
      type: 'notice',
      level: 'info',
      message: `이어서 할 작업이 ${active.length}개 있다. 계속하려면 말을 걸어라.`
    })
  }

  /**
   * 한도가 풀릴 시각이 지난 작업이 있는지 본다.
   *
   * 절전에서 깨어났을 때와 주기적으로 호출된다. 여기서도 자동 재개는 하지 않고
   * 알리기만 한다 — 사용자가 자리에 없는 사이 혼자 일을 벌이지 않게 한다.
   */
  checkResumable(): void {
    const due = this.tasks.dueForResume()
    for (const t of due) {
      this.toPanel({
        type: 'notice',
        level: 'info',
        message: `"${t.title}" 의 사용량 한도가 풀렸다. 이어서 할 수 있다.`
      })
      // pending 으로 되돌려 같은 알림이 매번 반복되지 않게 한다.
      this.tasks.update(t.id, { state: 'pending', resumeAt: null })
    }
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
    if (this.reminderTimer) clearInterval(this.reminderTimer)
    this.memory.close()
    this.tasks.close()
    this.snapshots.close()
    this.reminders.close()
  }

  /** 되돌리기 UI 용. 최근에 바뀐 파일들. */
  recentSnapshots(): ReturnType<SnapshotStore['recent']> {
    return this.snapshots.recent()
  }

  restoreSnapshot(id: string): { ok: boolean; reason?: string } {
    const result = this.snapshots.restore(id)
    if (result.ok && this.current) {
      const snap = this.snapshots.get(id)
      this.tasks.append(this.current.id, 'note', `되돌림: ${snap?.path ?? id}`)
    }
    return result
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

      case 'look_at_screen': {
        // 화면 전체가 넘어간다. 자동 승인 목록과 무관하게 항상 물어본다 —
        // 여기 찍히는 것이 무엇일지 사용자만 안다.
        const ok = await this.confirmSensitive('화면을 한 장 보여줄까?', 'look_at_screen')
        if (!ok) return { text: '사용자가 거절했다.' }
        return captureScreen()
      }

      case 'read_clipboard': {
        const ok = await this.confirmSensitive('클립보드 내용을 보여줄까?', 'read_clipboard')
        if (!ok) return { text: '사용자가 거절했다.' }
        const image = readClipboardImage()
        if (image) return image
        const text = readClipboardText()
        return { text: text ?? '클립보드가 비어 있다.' }
      }

      case 'remind_me': {
        const at = resolveReminderTime(args)
        const r = this.reminders.create({
          text: String(args.text ?? ''),
          dueAt: at,
          repeat: (args.repeat as 'none' | 'daily' | 'weekly' | undefined) ?? 'none',
          channel: (args.channel as 'desktop' | 'discord' | 'both' | undefined) ?? 'desktop',
          taskId: this.current?.id ?? null
        })
        // 해석된 시각을 그대로 돌려준다. 에이전트가 "3시에 알려줄게" 라고 말한 것과
        // 실제 예약이 어긋나면 사용자는 알림이 안 온 뒤에야 알게 된다.
        return `${new Date(r.dueAt).toLocaleString()} 에 알리도록 예약했다 (id: ${r.id})`
      }

      case 'reminder_list': {
        const list = this.reminders.upcoming()
        if (list.length === 0) return '예약된 알림이 없다.'
        return list
          .map(
            (r) =>
              `- ${new Date(r.dueAt).toLocaleString()}${r.repeat === 'none' ? '' : ` (${r.repeat})`}: ${r.text} [id: ${r.id}]`
          )
          .join('\n')
      }

      case 'reminder_cancel':
        return this.reminders.cancel(String(args.id ?? '')) ? '취소했다.' : '그런 알림이 없다.'

      case 'waifu_move': {
        const to = String(args.to ?? 'cursor')
        if (to !== 'left' && to !== 'right' && to !== 'cursor') {
          throw new Error(`알 수 없는 방향: ${to}`)
        }
        return this.moveAvatar(to)
      }

      case 'waifu_status':
        this.toAvatar({ type: 'status', state: args.state as never })
        // 툴 설명에서 "사용 가능한 모션은 여기서 알려준다"고 약속했다.
        // 목록이 비어 있으면 그렇다고 말해야 한다 — 없는 모션을 부르게 두면 안 된다.
        return this.motions.length
          ? `ok. 사용 가능한 모션: ${this.motions.join(', ')}`
          : 'ok. 등록된 모션이 없다. waifu_motion 을 부르지 마라.'

      case 'ask_permission':
        return this.askPermission(args)

      case 'task_update': {
        if (!this.current) return '진행 중인 작업이 없다.'
        const patch: Parameters<TaskStore['update']>[1] = {}
        if (typeof args.state === 'string') patch.state = args.state as TaskState
        if (typeof args.plan === 'string') patch.plan = args.plan
        if (typeof args.next_action === 'string') patch.nextAction = args.next_action
        if (typeof args.needs_user === 'string') patch.needsUser = args.needs_user
        if (typeof args.title === 'string' && args.title.trim()) patch.title = args.title
        this.current = this.tasks.update(this.current.id, patch)
        return 'ok'
      }

      case 'task_note': {
        if (!this.current) return '진행 중인 작업이 없다.'
        this.tasks.append(this.current.id, 'note', String(args.text ?? ''))
        return 'ok'
      }

      case 'task_list': {
        const active = this.tasks.active()
        if (active.length === 0) return '진행 중인 작업이 없다.'
        return active
          .map((t) => {
            const bits = [`[${t.state}] ${t.title}`]
            if (t.plan) bits.push(`  하는 중: ${t.plan}`)
            if (t.nextAction) bits.push(`  다음: ${t.nextAction}`)
            if (t.needsUser) bits.push(`  확인 필요: ${t.needsUser}`)
            return bits.join('\n')
          })
          .join('\n\n')
      }

      case 'remember': {
        const key = String(args.key ?? '').trim()
        const value = String(args.value ?? '')
        this.memory.remember(key, value)
        return `기억했다: ${key}`
      }

      case 'recall': {
        const found = this.memory.recall(String(args.query ?? ''))
        if (found.length === 0) return '해당하는 기억이 없다.'
        // 에이전트가 읽을 것이므로 사람이 읽는 형태로 준다.
        return found.map((m) => `- ${m.key}: ${m.value}`).join('\n')
      }

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
   * 민감한 것을 넘기기 전에 반드시 묻는다.
   *
   * `autoApprove` 목록이나 '맡겨두기' 모드와 **무관하게** 물어본다. 화면과 클립보드에
   * 무엇이 찍혀 있을지는 사용자만 안다. 편의를 위해 이걸 자동으로 통과시키면
   * 그 순간 이 기능은 상시 감시가 된다.
   */
  private confirmSensitive(question: string, toolName: string): Promise<boolean> {
    const id = randomUUID()
    return new Promise<boolean>((resolve) => {
      this.pending.set(id, (d) => resolve(d.behavior === 'allow'))
      this.toPanel({
        type: 'permission-request',
        request: { id, toolName, input: null, reason: question }
      })
      this.panel()?.show()
    })
  }

  /**
   * 아바타를 다른 모니터로 옮긴다.
   *
   * 이동이 끝날 때까지 기다렸다가 돌려준다 — 에이전트가 "갔어" 라고 말한 뒤에도
   * 아직 걷고 있으면 말과 그림이 어긋난다.
   */
  private moveAvatar(to: 'left' | 'right' | 'cursor'): Promise<string> {
    const win = this.avatar()
    if (!win || win.isDestroyed()) return Promise.resolve('아바타 창이 없다.')

    const display = resolveTarget(win, { kind: to } as never)
    if (!display) return Promise.resolve('갈 수 있는 모니터를 찾지 못했다.')

    const before = currentDisplayIndex(win)
    const bounds = win.getBounds()
    const destination = restingSpot(display, { width: bounds.width, height: bounds.height }, DEFAULT_ROAM.margin)

    // 이미 그 자리면 걷는 시늉을 할 이유가 없다.
    if (Math.abs(destination.x - bounds.x) < 2 && Math.abs(destination.y - bounds.y) < 2) {
      return Promise.resolve(
        orderedDisplays().length <= 1 ? '모니터가 하나뿐이라 이동하지 않았다.' : '이미 거기 있다.'
      )
    }

    // 이전 이동이 남아 있으면 취소한다. 두 이동이 겹치면 창이 떨린다.
    this.roaming?.cancel()

    return new Promise<string>((resolve) => {
      this.roaming = roamTo(win, destination, {
        onStart: (direction) => this.toAvatar({ type: 'roam', moving: true, direction }),
        onDone: () => {
          this.roaming = null
          this.toAvatar({ type: 'roam', moving: false, direction: 0 })
          const after = currentDisplayIndex(win)
          resolve(
            before === after
              ? '같은 모니터 안에서 자리를 옮겼다.'
              : `${before + 1}번 모니터에서 ${after + 1}번으로 옮겼다.`
          )
        }
      })
    })
  }

  /**
   * 훅이 물어온 권한을 사용자에게 넘긴다.
   *
   * 설정의 autoApprove 에 있으면 묻지 않는다. 그 외에는 패널에 카드를 띄우고
   * 사용자가 누를 때까지 이 Promise 를 붙잡아 둔다 — 훅도 그 동안 대기한다.
   */
  private askPermission(args: Record<string, unknown>): Promise<PermissionDecision> {
    const toolName = String(args.toolName ?? 'unknown')
    const input = args.input
    // 원격 요청이면 설정보다 낮은 권한이 적용된다.
    const mode = this.effectivePermission()

    if (mode === 'readonly') {
      return Promise.resolve({
        behavior: 'deny',
        message: `'대화만 하기' 모드라 ${toolName} 을 실행하지 않았다.`
      })
    }

    // 파일을 통째로 바꾸는 툴은 실행 전에 원본을 떠둔다.
    // 훅이 실행을 막고 있는 동안 일어나므로 모델이 우회할 수 없다.
    if (isOverwritingTool(toolName)) {
      const path = extractFilePath(input)
      if (path) this.snapshots.capture(path, toolName, this.current?.id ?? null)
    }

    // 되돌리기 어려운 셸 명령은 '맡겨두기' 든 자동 승인 목록이든 무조건 물어본다.
    // 여기서 뚫리면 안전망이 아니라 장식이다.
    const dangers = isShellTool(toolName) ? findDangers(extractCommand(input)) : []

    if (dangers.length === 0) {
      if (mode === 'auto') return Promise.resolve({ behavior: 'allow' })
      if (this.config.permission.autoApprove.includes(toolName)) {
        return Promise.resolve({ behavior: 'allow' })
      }
    }

    const request: PermissionRequest = {
      id: randomUUID(),
      toolName,
      input,
      ...(dangers.length > 0
        ? { reason: `되돌리기 어렵다 — ${dangers.map((d) => d.reason).join(', ')}` }
        : typeof args.reason === 'string'
          ? { reason: args.reason }
          : {})
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

      case 'session':
        // 세션 키를 작업에 못 박아야 나중에 --resume 으로 이어붙일 수 있다.
        if (this.current) {
          this.current = this.tasks.update(this.current.id, {
            sessionId: e.sessionId,
            backend: e.backend
          })
        }
        break

      case 'tool-start':
        this.toAvatar({ type: 'status', state: 'working' })
        if (this.current) this.tasks.append(this.current.id, 'tool', e.name)
        break

      case 'text-delta':
        this.toAvatar({ type: 'status', state: 'speaking' })
        break

      case 'activity':
        if (this.current) this.tasks.append(this.current.id, 'note', e.detail)
        break

      case 'result': {
        this.toAvatar({ type: 'status', state: e.isError ? 'error' : 'idle' })

        // 밖에서 부탁한 사람에게 결과를 돌려준다. 이게 없으면 "부탁하고 결과를 받는다" 가
        // 성립하지 않는다.
        const reply = this.replyTo
        if (reply) {
          const task = this.current
          const bits = [e.text || '(응답 없음)']
          if (task?.needsUser) bits.push(`\n확인 필요: ${task.needsUser}`)
          else if (task?.nextAction) bits.push(`\n다음: ${task.nextAction}`)
          reply(bits.join('\n'))
        }

        if (this.current) {
          this.tasks.append(this.current.id, 'result', e.text)
          // 에이전트가 task_update 로 done/failed 를 적었으면 그 판단을 존중한다.
          // 안 적었으면 턴이 끝났다는 사실만 반영하고 상태는 건드리지 않는다 —
          // 여러 턴에 걸친 작업을 한 턴 끝났다고 done 으로 만들면 안 된다.
          if (e.isError) this.current = this.tasks.update(this.current.id, { state: 'failed' })
        }
        break
      }

      case 'error':
        this.toAvatar({ type: 'status', state: 'error' })
        if (this.current) this.tasks.append(this.current.id, 'error', e.message)
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
          // 작업을 버리지 않고 멈춰둔다. resetsAt 이 있으면 재개 시각을 못 박는다 —
          // 이게 "한도에 걸려도 작업이 살아남는다" 의 실체다.
          if (this.current) {
            this.current = this.tasks.update(this.current.id, {
              state: 'paused',
              resumeAt: e.info.resetsAt ? e.info.resetsAt * 1000 : null
            })
            this.tasks.append(
              this.current!.id,
              'note',
              `사용량 한도(${e.info.rateLimitType})로 멈춤. 재개 예정: ${at}`
            )
          }
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
