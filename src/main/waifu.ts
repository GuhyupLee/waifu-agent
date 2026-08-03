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
import { mcpLaunchSpec, permissionHookCommand, RUN_AS_NODE_ENV } from './childEntries'
import { buildSystemPrompt } from './persona/prompt'
import { MemoryStore } from './persona/memory'
import { TaskStore } from './tasks/store'
import { SnapshotStore } from './safety/snapshots'
import { clampRemotePermission } from './discord/bot'
import {
  DEFAULT_ROAM,
  currentDisplayIndex,
  cursorIsOnOtherDisplay,
  orderedDisplays,
  resolveTarget,
  restingSpot,
  roamTo
} from './roaming'
import { autonomyEnabled, decideIdleAction, nextIdleDelayMs } from './autonomy'
import type { RoamHandle } from './roaming'
import { ReminderStore, resolveReminderTime } from './reminders/store'
import { RoutineStore } from './routines/store'
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
  /** control 서버와 백엔드가 모두 떠서 사용자 발화를 받을 수 있는가. */
  private started = false
  /** 종료가 시작된 인스턴스가 failover나 늦은 이벤트로 다시 살아나는 것을 막는다. */
  private stopped = false
  private stopPromise: Promise<void> | null = null
  /** interrupt/failover 중 Claude의 의도된 exit를 런타임 장애로 오인하지 않는다. */
  private backendTransition = false
  /** 종료가 interrupt/failover 중간을 추월해 새 CLI가 뒤늦게 살아나는 것을 막는다. */
  private backendTransitionTask: Promise<void> | null = null
  /** 한도 때문에 이미 갈아탔는지. 무한 왕복을 막는다. */
  private failedOver = false
  /** 대기 중인 권한 승인. 훅이 응답을 기다리며 붙잡혀 있다. */
  private readonly pending = new Map<
    string,
    { request: PermissionRequest; resolve: (d: PermissionDecision) => void }
  >()
  /** 렌더러가 실제로 로드에 성공한 모션 이름. 에이전트에게 이 목록으로만 답한다. */
  private motions: string[] = []
  private readonly memory = new MemoryStore()
  private readonly tasks = new TaskStore()
  private readonly snapshots = new SnapshotStore()
  /** 진행 중인 이동. 새 이동이 들어오면 취소한다 — 겹치면 창이 떨린다. */
  private roaming: RoamHandle | null = null
  private avatarDragging = false
  private readonly reminders = new ReminderStore()
  private readonly routines = new RoutineStore()
  private reminderTimer: NodeJS.Timeout | null = null
  /** 지금 턴이 속한 작업. 에이전트의 task_* 툴은 이걸 대상으로 한다. */
  private current: Task | null = null
  /**
   * voice 설정의 라이브 스냅샷.
   *
   * this.config 는 시작 시점 값으로 굳어 있다 — config:set 은 store 캐시를 새 객체로
   * 갈아끼울 뿐 이 인스턴스가 든 참조는 안 바꾼다. say() 가 this.config.voice 를 쓰면
   * enabled/engineUrl/speakerId/speedScale 변경이 재시작 전엔 먹지 않는다. 그래서 voice 만
   * 따로 들고 updateVoice 로 갱신한다.
   */
  private voice: WaifuConfig['voice']

  constructor(
    private readonly config: WaifuConfig,
    private readonly avatar: () => BrowserWindow | null,
    private readonly panel: () => BrowserWindow | null,
    /** 활성 렌더러가 Electron인지 Unity인지 main만 알고 있으므로 전송을 위임한다. */
    private readonly dispatchAvatar?: (command: AvatarCommand) => void,
    /** 승인 요청 중 패널이 닫혀 있으면 새 패널을 만들어 앞으로 꺼낸다. */
    private readonly revealPanel?: () => BrowserWindow | null,
    /** 지연 생성되는 UI들에 이벤트를 기록·동시 전송하는 main 소유 경로. */
    private readonly dispatchPanel?: (event: PanelEvent) => void
  ) {
    this.control = new ControlServer((tool, args) => this.onTool(tool, args))
    this.active = config.backend.active
    this.backend = createBackend(this.active)
    this.unsubscribe = this.backend.onEvent((e) => this.onBackendEvent(e))
    this.voice = config.voice
  }

  /** config:set 이 voice 를 바꾸면 즉시 반영한다. 재시작을 요구하지 않는다. */
  updateVoice(voice: WaifuConfig['voice']): void {
    this.voice = voice
  }

  async start(cwd: string): Promise<void> {
    if (this.stopped) throw new Error('이미 종료한 Agent Core는 다시 시작할 수 없다')
    try {
      await this.control.start()
      if (this.stopped) throw new Error('Agent Core 시작 중 종료됐다')
      this.cwd = cwd
      await this.startBackend()
      if (this.stopped) {
        await this.backend.stop()
        throw new Error('Agent Core 시작 중 종료됐다')
      }
      this.started = true
      // 30초면 분 단위 알림에 충분하고, 켜둬도 부담이 없다.
      this.reminderTimer = setInterval(() => this.fireDueReminders(), 30_000)
      this.fireDueReminders()
      this.scheduleIdleAction()
    } catch (err) {
      this.started = false
      await Promise.allSettled([this.backend.stop(), this.control.stop()])
      throw err
    }
  }

  /** 마지막으로 사용자와 주고받은 시각. 자율 행동이 끼어들지 판단하는 기준이다. */
  private lastInteractionAt = Date.now()
  private idleTimer: NodeJS.Timeout | null = null

  /**
   * 스스로 움직이게 한다.
   *
   * 아바타가 부를 때만 반응하면 "떠 있는 UI" 지 "살아 있는 것" 이 아니다.
   * 다만 여기서 **말은 하지 않는다** — 먼저 말을 거는 건 알림의 몫이고 그건
   * 방해 금지 시간을 지킨다. 여기서는 몸짓과 위치만 다룬다.
   */
  private scheduleIdleAction(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.runIdleAction()
      this.scheduleIdleAction()
    }, nextIdleDelayMs(Math.random()))
  }

  private runIdleAction(): void {
    if (!autonomyEnabled(this.config)) return
    const win = this.avatar()
    if (!win || win.isDestroyed() || !win.isVisible()) return

    const action = decideIdleAction(
      {
        idleMs: Date.now() - this.lastInteractionAt,
        busy: this.backend.busy,
        dragging: this.avatarDragging,
        cursorOnOtherDisplay: cursorIsOnOtherDisplay(win),
        motions: this.motions
      },
      Math.random()
    )

    if (action.kind === 'gesture') {
      process.stdout.write(`[idle] 몸짓: ${action.motion}\n`)
      this.toAvatar({ type: 'motion', name: action.motion, loop: false })
    } else if (action.kind === 'follow') {
      process.stdout.write('[idle] 커서가 있는 화면으로 이동\n')
      void this.moveAvatar('cursor')
    }
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
    const mcpEnv = { ...RUN_AS_NODE_ENV, ...this.control.childEnv() }
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
      extraEnv: { ...RUN_AS_NODE_ENV, ...this.control.childEnv() }
    })
  }

  /**
   * 다른 백엔드로 갈아탄다.
   *
   * 세션은 이어받지 않는다 — Claude Code 의 session id 와 Codex 의 thread id 는
   * 서로 다른 저장소에 있어서 교차 재개가 불가능하다. 사용자에게 맥락이 끊겼음을 알린다.
   */
  private async switchBackend(to: BackendKind, why: string): Promise<void> {
    if (to === this.active || this.stopped) return
    this.started = false
    this.unsubscribe()
    await this.backend.stop()
    if (this.stopped) return

    this.active = to
    this.backend = createBackend(to)
    this.unsubscribe = this.backend.onEvent((e) => this.onBackendEvent(e))
    if (this.stopped) return
    await this.startBackend()
    if (this.stopped) {
      await this.backend.stop()
      return
    }
    this.started = true

    this.toPanel({
      type: 'notice',
      level: 'warn',
      message: `${why} ${to} 로 전환했다. 이전 대화 맥락은 이어지지 않는다.`
    })
    process.stdout.write(`[waifu] 백엔드 전환 -> ${to} (${why})\n`)
  }

  /** interrupt와 failover를 겹치지 않고, full stop이 기다릴 수 있는 한 작업으로 묶는다. */
  private runBackendTransition(action: () => Promise<void>): Promise<void> {
    if (this.backendTransitionTask) return this.backendTransitionTask
    this.backendTransition = true
    const task = action().finally(() => {
      if (this.backendTransitionTask !== task) return
      this.backendTransitionTask = null
      this.backendTransition = false
    })
    this.backendTransitionTask = task
    return task
  }

  /**
   * 이번 턴이 원격 요청인지. 권한 판정에 쓴다.
   *
   * 훅은 `session_id` 밖에 모르지만, 실제로는 한 번에 한 턴만 돈다.
   * 현재 Task 의 origin 을 보면 충분하다.
   */
  private effectivePermission(origin: TaskOrigin = this.current?.origin ?? 'desktop'): PermissionMode {
    const base = this.config.permission.mode
    if (origin !== 'discord') return base
    return clampRemotePermission(base, this.config.discord.maxPermission)
  }

  /**
   * 원격 요청의 답신 통로. 턴이 끝나면 여기로 결과를 보낸다.
   * 데스크탑 요청이면 null 이다 — 화면에 이미 보이는 걸 다시 보낼 이유가 없다.
   */
  private replyTo: ((text: string) => void) | null = null

  send(text: string, origin: TaskOrigin = 'desktop', replyTo?: (text: string) => void): void {
    if (!this.started) {
      const message = '작업 폴더를 고른 뒤 에이전트를 시작해야 부탁을 보낼 수 있다.'
      this.toPanel({ type: 'notice', level: 'warn', message })
      replyTo?.(message)
      return
    }
    if (this.backend.busy) {
      const message = '지금 하던 작업이 끝나거나 중단된 뒤 다시 부탁해줘.'
      this.toPanel({ type: 'notice', level: 'warn', message })
      replyTo?.(message)
      return
    }
    this.replyTo = replyTo ?? null
    // 방금 말을 걸었으니 한동안 딴짓하지 않는다.
    this.lastInteractionAt = Date.now()

    // 이어갈 작업이 없으면 새로 만든다. 제목은 첫 발화에서 따고, 에이전트가
    // 더 정확한 이름을 알게 되면 task_update 로 고친다.
    if (
      !this.current ||
      this.current.state === 'done' ||
      this.current.state === 'failed' ||
      this.current.origin !== origin
    ) {
      this.current = this.tasks.create({
        title: text.slice(0, 60),
        cwd: this.cwd,
        backend: this.active,
        origin
      })
    }
    this.tasks.append(this.current.id, 'user', text)
    const running = this.tasks.update(this.current.id, { state: 'running', needsUser: '' })
    if (!running) {
      const message = '작업 기록을 열지 못해 부탁을 보내지 않았다.'
      this.toPanel({ type: 'notice', level: 'error', message })
      replyTo?.(message)
      return
    }
    this.current = running

    const taskId = running.id
    const turnReply = this.replyTo
    void this.backend.send(text, { permissionMode: this.effectivePermission(origin) }).catch((err: unknown) => {
      const message = `전송 실패: ${String(err)}`
      this.toPanel({ type: 'notice', level: 'error', message })
      turnReply?.(message)
      const task = this.tasks.get(taskId)
      if (task) this.current = this.tasks.update(taskId, { state: 'failed' })
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
    if (this.stopped || this.backendTransitionTask) return
    this.started = false
    this.denyPendingPermissions('작업을 중단해서 실행하지 않았다.')
    const backend = this.backend
    void this.runBackendTransition(async () => {
      try {
        await backend.interrupt()
        if (!this.stopped && this.backend === backend) this.started = true
      } catch (err) {
        if (!this.stopped) {
          this.toPanel({ type: 'notice', level: 'error', message: `중단 실패: ${String(err)}` })
          this.toAvatar({ type: 'status', state: 'error' })
        }
      }
    })
    this.toAvatar({ type: 'status', state: 'idle' })
  }

  /** 렌더러가 확인해준 재생 가능 모션 목록. main 의 IPC 핸들러에서 넣어준다. */
  setMotions(names: string[]): void {
    this.motions = names
  }

  /** 패널에서 온 권한 응답. 훅이 이 값을 기다리고 있다. */
  resolvePermission(id: string, decision: PermissionDecision): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    entry.resolve(decision)
    this.toPanel({ type: 'permission-resolved', id })
  }

  /** 패널이 닫혔다 다시 떠도 훅을 기다리게 둔 승인 카드를 복원한다. */
  pendingPermissions(): PermissionRequest[] {
    return [...this.pending.values()].map(({ request }) => request)
  }

  private denyPendingPermissions(message: string): void {
    for (const [id, { resolve }] of this.pending) {
      resolve({ behavior: 'deny', message })
      this.toPanel({ type: 'permission-resolved', id })
    }
    this.pending.clear()
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopped = true
    this.started = false
    const attempt = this.performStop()
    let tracked: Promise<void>
    tracked = attempt.finally(() => {
      // backend/control이 실패한 경우 보존한 child/server 핸들로 다시 종료할 수 있게 한다.
      if (this.stopPromise === tracked) this.stopPromise = null
    })
    this.stopPromise = tracked
    return tracked
  }

  private async performStop(): Promise<void> {
    this.cancelRoaming()
    // 재시작할 때 늦게 도착한 이전 프로세스 이벤트가 닫힌 TaskStore를 건드리거나 새 UI에
    // 섞이지 않게 먼저 구독을 끊는다.
    this.unsubscribe()
    this.denyPendingPermissions('앱이 종료되어 실행하지 않았다.')
    // Claude interrupt는 old child 종료 뒤 같은 세션을 새 child로 재개한다. 그 중간에
    // stop이 추월하면 child=null만 보고 끝난 다음 재개 child가 고아로 살아날 수 있다.
    const transition = this.backendTransitionTask
    if (transition) await transition.catch(() => undefined)
    const shutdowns = await Promise.allSettled([this.backend.stop(), this.control.stop()])
    if (this.reminderTimer) clearInterval(this.reminderTimer)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.memory.close()
    this.tasks.close()
    this.snapshots.close()
    this.reminders.close()
    this.routines.close()
    const failure = shutdowns.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failure) throw failure.reason
  }

  // ─────────────────────── 설정 화면용 조회·삭제 ───────────────────────

  listMemories(): ReturnType<MemoryStore['recall']> {
    return this.memory.recall('')
  }

  forgetMemory(key: string): boolean {
    return this.memory.forget(key)
  }

  listRoutines(): ReturnType<RoutineStore['list']> {
    return this.routines.list()
  }

  removeRoutine(name: string): boolean {
    return this.routines.remove(name)
  }

  listReminders(): ReturnType<ReminderStore['upcoming']> {
    return this.reminders.upcoming()
  }

  cancelReminder(id: string): boolean {
    return this.reminders.cancel(id)
  }

  /** 진단용. 설정 화면에서 지금 상태를 보여준다. */
  diagnostics(): {
    backend: BackendKind
    sessionId: string | null
    busy: boolean
    motions: number
    activeTasks: number
    memories: number
    runtime: {
      configuredBackend: BackendKind
      cwd: string
      permissionMode: PermissionMode
      workspaces: string[]
    } | null
  } {
    return {
      backend: this.active,
      sessionId: this.backend.sessionId,
      busy: this.started && this.backend.busy,
      motions: this.motions.length,
      activeTasks: this.tasks.active().length,
      memories: this.memory.count(),
      runtime: this.started
        ? {
            configuredBackend: this.config.backend.active,
            cwd: this.cwd,
            permissionMode: this.config.permission.mode,
            workspaces: [...this.config.permission.workspaces]
          }
        : null
    }
  }

  /**
   * 사용자가 아바타를 잡거나 디스플레이 구성이 바뀌면 자동 이동을 즉시 양보한다.
   * roamTo의 terminal callback이 기존 MCP 요청과 renderer 모션까지 함께 정리한다.
   */
  cancelRoaming(): void {
    this.roaming?.cancel()
  }

  setAvatarDragging(dragging: boolean): void {
    this.avatarDragging = dragging
    if (dragging) this.cancelRoaming()
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

      case 'routine_save': {
        const r = this.routines.save({
          name: String(args.name ?? ''),
          summary: String(args.summary ?? ''),
          steps: String(args.steps ?? ''),
          sourceTaskId: this.current?.id ?? null
        })
        return `"${r.name}" 루틴으로 저장했다. 다음엔 이름만 부르면 된다.`
      }

      case 'routine_list': {
        const list = this.routines.list()
        if (list.length === 0) return '저장된 루틴이 없다.'
        return list
          .map((r) => `- ${r.name}: ${r.summary}${r.runCount > 0 ? ` (${r.runCount}번 실행)` : ''}`)
          .join('\n')
      }

      case 'routine_recall': {
        const r = this.routines.byName(String(args.name ?? ''))
        if (!r) {
          const names = this.routines.list().map((x) => x.name)
          return names.length
            ? `그런 루틴이 없다. 있는 것: ${names.join(', ')}`
            : '저장된 루틴이 없다.'
        }
        this.routines.markRun(r.id)
        return `## ${r.name}\n${r.summary}\n\n절차:\n${r.steps}`
      }

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

    if (!this.voice.enabled || !speech) {
      this.toAvatar(cmd)
      return this.voice.enabled ? 'ok (speech_ja 가 없어 무음 자막만 띄웠다)' : 'ok (음성 꺼짐)'
    }

    try {
      const { audio, visemes } = await synthesize(speech, {
        engineUrl: this.voice.engineUrl,
        speakerId: this.voice.speakerId,
        speedScale: this.voice.speedScale
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
    const request: PermissionRequest = { id, toolName, input: null, reason: question }
    return new Promise<boolean>((resolve) => {
      this.pending.set(id, {
        request,
        resolve: (decision) => resolve(decision.behavior === 'allow')
      })
      this.toPanel({ type: 'permission-request', request })
      try {
        const panel = this.panel()
        if (panel && !panel.isDestroyed()) {
          panel.show()
          panel.focus()
        } else this.revealPanel?.()
      } catch (err) {
        this.resolvePermission(id, {
          behavior: 'deny',
          message: `승인 창을 열지 못해 실행하지 않았다: ${String(err)}`
        })
      }
    })
  }

  /**
   * 아바타를 다른 모니터로 옮긴다.
   *
   * 이동이 끝날 때까지 기다렸다가 돌려준다 — 에이전트가 "갔어" 라고 말한 뒤에도
   * 아직 걷고 있으면 말과 그림이 어긋난다.
   */
  private moveAvatar(to: 'left' | 'right' | 'cursor'): Promise<string> {
    // 최신 명령이 항상 이전 경로를 대체한다. 먼저 handle을 떼어 stale callback이
    // 새 이동의 모션을 끄지 못하게 한 뒤 이전 Promise를 cancelled로 종결한다.
    const previous = this.roaming
    this.roaming = null
    previous?.cancel()

    if (this.avatarDragging) {
      if (previous) this.toAvatar({ type: 'roam', moving: false, direction: 0 })
      return Promise.resolve('아바타를 잡고 있는 동안에는 자동 이동하지 않는다.')
    }

    const win = this.avatar()
    if (!win || win.isDestroyed()) return Promise.resolve('아바타 창이 없다.')

    const display = resolveTarget(win, { kind: to })
    if (!display) {
      if (previous) this.toAvatar({ type: 'roam', moving: false, direction: 0 })
      return Promise.resolve('갈 수 있는 모니터를 찾지 못했다.')
    }

    const before = currentDisplayIndex(win)
    const displays = orderedDisplays()
    const current = displays[before]

    // waifu_move는 화면 사이 이동이다. 한 화면뿐이거나 이미 대상 화면에 있으면
    // 사용자가 직접 둔 위치를 멋대로 오른쪽 아래로 재배치하지 않는다.
    if (displays.length <= 1 || current?.id === display.id) {
      if (previous) this.toAvatar({ type: 'roam', moving: false, direction: 0 })
      return Promise.resolve(
        displays.length <= 1 ? '모니터가 하나뿐이라 이동하지 않았다.' : '이미 그 모니터에 있다.'
      )
    }

    const bounds = win.getBounds()
    const destination = restingSpot(display, { width: bounds.width, height: bounds.height }, DEFAULT_ROAM.margin)

    // 이미 그 자리면 걷는 시늉을 할 이유가 없다.
    if (Math.abs(destination.x - bounds.x) < 2 && Math.abs(destination.y - bounds.y) < 2) {
      if (previous) this.toAvatar({ type: 'roam', moving: false, direction: 0 })
      return Promise.resolve('이미 거기 있다.')
    }

    return new Promise<string>((resolve) => {
      let handle: RoamHandle | null = null
      handle = roamTo(win, destination, {
        onStart: (direction) => this.toAvatar({ type: 'roam', moving: true, direction }),
        onDone: (reason) => {
          // 더 최신 이동이 이미 handle을 차지했다면 그 모션은 건드리지 않는다.
          if (this.roaming !== handle) {
            resolve('더 최근 이동 요청으로 바꿨다.')
            return
          }
          this.roaming = null
          this.toAvatar({ type: 'roam', moving: false, direction: 0 })
          if (reason === 'cancelled') {
            resolve('이동을 멈췄다.')
            return
          }
          if (reason === 'destroyed') {
            resolve('아바타 창이 닫혀 이동을 멈췄다.')
            return
          }
          const after = currentDisplayIndex(win)
          resolve(
            before === after
              ? '같은 모니터 안에서 자리를 옮겼다.'
              : `${before + 1}번 모니터에서 ${after + 1}번으로 옮겼다.`
          )
        }
      })
      this.roaming = handle
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
      this.pending.set(request.id, { request, resolve })
      this.toAvatar({ type: 'status', state: 'thinking' })
      this.toPanel({ type: 'permission-request', request })
      try {
        const panel = this.panel()
        // 승인 카드가 뒤에 가려져 있으면 사용자는 앱이 멈춘 줄 안다.
        if (panel && !panel.isDestroyed()) {
          panel.show()
          panel.focus()
        } else this.revealPanel?.()
      } catch (err) {
        this.resolvePermission(request.id, {
          behavior: 'deny',
          message: `승인 창을 열지 못해 실행하지 않았다: ${String(err)}`
        })
      }
    })
  }

  // ─────────────────────── 백엔드 → UI ───────────────────────

  private onBackendEvent(e: BackendEvent): void {
    if (this.stopped) return
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
        // 세션 키를 작업에 못 박아야 나중에 --resume 으로 이어붙일 수 있다.
        if (this.current) {
          this.current = this.tasks.update(this.current.id, {
            sessionId: e.sessionId,
            backend: e.backend
          })
        }
        break
      }

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
      case 'exit':
        // Codex는 턴마다 프로세스가 정상 종료된다. Claude Code만 상주 프로세스라
        // transition 바깥의 exit가 곧 런타임 유실이다.
        if (this.active === 'claude-code' && !this.backendTransition) {
          this.started = false
          this.denyPendingPermissions('Claude Code 연결이 종료되어 실행하지 않았다.')
          this.toPanel({
            type: 'notice',
            level: 'error',
            message: 'Claude Code 연결이 종료됐다. 앱을 다시 시작해 연결해줘.'
          })
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
    if (this.stopped || !this.config.backend.failover || this.failedOver) return
    this.failedOver = true
    void this.runBackendTransition(() => this.switchBackend(otherBackend(this.active), why)).catch((err: unknown) => {
      this.toPanel({ type: 'notice', level: 'error', message: `백엔드 전환 실패: ${String(err)}` })
    })
  }

  private toAvatar(cmd: AvatarCommand): void {
    if (this.dispatchAvatar) {
      this.dispatchAvatar(cmd)
      return
    }
    const win = this.avatar()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.avatarCommand, cmd)
  }

  private toPanel(evt: PanelEvent): void {
    if (this.dispatchPanel) {
      this.dispatchPanel(evt)
      return
    }
    const win = this.panel()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.panelEvent, evt)
  }
}
