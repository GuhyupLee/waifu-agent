import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import type { BackendEvent, BackendKind, PermissionMode } from '@shared/protocol'
import { ClaudeEventMapper } from './claudeEvents'
import { NdjsonReader, parseLines } from './ndjson'
import { terminateProcessTree } from './processTree'
import type { ProcessTreeTerminator } from './processTree'
import { cleanEnv } from './types'
import type { AgentBackend, BackendListener, SessionOpts } from './types'

/**
 * Claude Code 를 프로세스 **하나로** 띄워두고 stdin 으로 여러 턴을 밀어 넣는다.
 * 턴마다 재실행하면 매번 시작 비용을 물고 세션 맥락도 다시 붙여야 한다.
 * 실제 캡처로 프로세스 하나에서 2턴이 맥락을 유지하는 것을 확인했다.
 */

/** 읽기 전용 모드에서 허용할 툴. 나머지는 훅이 막는다. */
const READONLY_TOOLS = ['Read', 'Glob', 'Grep', 'NotebookRead', 'TodoWrite']

function permissionFlag(mode: PermissionMode): string {
  // 실제 CLI 가 받는 값: acceptEdits, auto, bypassPermissions, manual, dontAsk, plan
  switch (mode) {
    case 'readonly':
      return 'dontAsk'
    case 'auto':
      return 'bypassPermissions'
    case 'guarded':
    default:
      return 'acceptEdits'
  }
}

export class ClaudeCodeBackend implements AgentBackend {
  readonly kind: BackendKind = 'claude-code'

  private child: ChildProcessWithoutNullStreams | null = null
  private readyChild: ChildProcessWithoutNullStreams | null = null
  private readonly listeners = new Set<BackendListener>()

  private _sessionId: string | null = null
  private _busy = false
  private opts: SessionOpts | null = null
  /** 명시적 stop이 진행 중인 interrupt의 재개 spawn을 취소하기 위한 세대. */
  private stopGeneration = 0
  private interruptPromise: Promise<void> | null = null
  private stoppingChild: Promise<void> | null = null
  private readonly terminating = new WeakSet<ChildProcessWithoutNullStreams>()

  constructor(private readonly terminateChild: ProcessTreeTerminator = terminateProcessTree) {}

  get sessionId(): string | null {
    return this._sessionId
  }

  get busy(): boolean {
    return this._busy
  }

  onEvent(listener: BackendListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: BackendEvent): void {
    if (event.type === 'session') this._sessionId = event.sessionId
    if (event.type === 'result' || event.type === 'error') this._busy = false
    for (const l of this.listeners) l(event)
  }

  async start(opts: SessionOpts): Promise<void> {
    if (this.child) await this.stop()
    this.opts = null

    // 세션 id 를 우리가 정해두면 중단 후 --resume 으로 되살릴 때 참조할 값이 확실해진다.
    // (재개는 cwd 스코프라 Task 는 cwd 도 같이 기억해야 한다.)
    const sessionId = opts.resumeSessionId ?? randomUUID()
    const args = this.buildArgs(opts, sessionId)
    if (!opts.resumeSessionId) this._sessionId = null

    const child = spawn(opts.bin, args, {
      cwd: opts.cwd,
      // claude 는 실제 .exe 라 shell 이 필요 없다. shell:true 는 인자 이스케이프를 하지 않아
      // 경로에 공백이나 특수문자가 있으면 그대로 터진다.
      shell: false,
      windowsHide: true,
      env: { ...cleanEnv(), ...opts.extraEnv }
    })
    this.child = child
    const reader = new NdjsonReader()
    const mapper = new ClaudeEventMapper()
    let spawned = false
    let closeHandled = false
    let errorEmitted = false
    let settleStart: (() => void) | null = null
    let failStart: ((error: Error) => void) | null = null
    const started = new Promise<void>((resolve, reject) => {
      settleStart = resolve
      failStart = reject
    })

    const rejectStart = (error: Error): void => {
      if (!failStart) return
      const reject = failStart
      settleStart = null
      failStart = null
      reject(error)
    }

    const emitProcessError = (message: string): void => {
      if (errorEmitted) return
      errorEmitted = true
      this.emit({ type: 'error', message: `실행 실패: ${message}`, kind: 'not-found' })
    }

    const consume = (lines: string[]): void => {
      // stop timeout 뒤 다음 프로세스가 떴면, 이전 stdout을 새 mapper에 섞으면 안 된다.
      if (this.child !== child || this.terminating.has(child)) return
      for (const raw of parseLines(lines, (line) => {
        process.stderr.write(`[claude] JSON 아님: ${line}\n`)
      })) {
        for (const event of mapper.map(raw)) this.emit(event)
      }
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => consume(reader.push(chunk)))

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      if (this.child === child && !this.terminating.has(child)) {
        process.stderr.write(`[claude] ${chunk}`)
      }
    })

    child.once('spawn', () => {
      // start 대기 중 stop/재시작이 들어왔다면 이 프로세스는 더 이상 현재 백엔드가 아니다.
      if (this.child !== child || this.terminating.has(child)) {
        rejectStart(new Error('백엔드 시작이 중단되었다'))
        return
      }
      spawned = true
      this.readyChild = child
      this.opts = opts
      if (!opts.resumeSessionId) this._sessionId = sessionId
      const resolve = settleStart
      settleStart = null
      failStart = null
      resolve?.()
    })

    child.on('error', (err) => {
      // 중단됐거나 교체된 자식의 늦은 error는 새 세션의 busy 상태를 풀면 안 된다.
      if (this.child !== child || this.terminating.has(child)) {
        if (!spawned) rejectStart(new Error('백엔드 시작이 중단되었다'))
        return
      }
      emitProcessError(err.message)
      if (!spawned) rejectStart(new Error(`실행 실패: ${err.message}`))
    })

    child.on('close', (code) => {
      if (closeHandled) return
      closeHandled = true
      const isCurrent = this.child === child

      // Node는 spawn 실패 때 error 뒤 close를 내보낸다. 가짜 child나 비정상 환경에서
      // close만 오더라도 start Promise가 영원히 남지 않게 한다.
      if (!spawned) {
        if (isCurrent) {
          const message = `프로세스가 시작 전에 종료됨 (code=${code ?? 'null'})`
          emitProcessError(message)
          rejectStart(new Error(`실행 실패: ${message}`))
        } else {
          rejectStart(new Error('백엔드 시작이 중단되었다'))
        }
      }

      // stop 타임아웃 뒤 뜨는 이전 close가 현재 child를 null로 만들지 못하게 한다.
      if (!isCurrent) {
        if (this.child === null) this.emit({ type: 'exit', code })
        return
      }

      if (!this.terminating.has(child)) consume(reader.flush())
      this.child = null
      if (this.readyChild === child) this.readyChild = null
      this._busy = false
      this.emit({ type: 'exit', code })
    })

    await started
  }

  private buildArgs(opts: SessionOpts, sessionId: string): string[] {
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      // 내가 보낸 입력이 되돌아오면 isReplay:true 가 붙는다. 그걸로 tool_result 와 구분한다.
      '--replay-user-messages',
      '--verbose',
      '--permission-mode',
      permissionFlag(opts.permissionMode)
    ]

    // 이어받기와 새 세션은 배타적이다. 둘 다 주면 CLI 가 거부한다.
    if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId)
    else args.push('--session-id', sessionId)

    if (opts.model) args.push('--model', opts.model)
    for (const dir of opts.workspaces) args.push('--add-dir', dir)

    if (opts.permissionMode === 'readonly') args.push('--allowedTools', READONLY_TOOLS.join(','))

    if (opts.mcpConfigJson) args.push('--mcp-config', opts.mcpConfigJson)

    // 권한 게이트. --permission-prompt-tool 은 이 버전에 없어서 PreToolUse 훅으로 간다.
    if (opts.settingsPath) args.push('--settings', opts.settingsPath)

    // --append-system-prompt-file 은 이 버전에 없다. 내용을 인라인으로 넘겨야 한다.
    if (opts.systemPrompt) args.push('--append-system-prompt', opts.systemPrompt)

    return args
  }

  async send(text: string): Promise<void> {
    const child = this.readyChild
    if (!child || this.child !== child) throw new Error('백엔드가 시작되지 않았다')
    this._busy = true
    const msg = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] }
    }
    child.stdin.write(JSON.stringify(msg) + '\n')
  }

  /**
   * 진행 중인 턴을 중단한다.
   *
   * `system/init` 의 capabilities 에 `interrupt_receipt_v1` 이 있으니 제어 메시지 경로가
   * 존재하지만, 그 와이어 포맷을 아직 실측하지 못했다. 검증되지 않은 형식을 추측해서 보내는
   * 대신 확실한 경로로 간다 — 프로세스를 죽이고 같은 세션 id 로 다시 붙인다.
   * 진행 중이던 턴은 버려지지만 대화 맥락은 살아남는다.
   */
  interrupt(): Promise<void> {
    if (this.interruptPromise) return this.interruptPromise
    const operation = this.performInterrupt().finally(() => {
      if (this.interruptPromise === operation) this.interruptPromise = null
    })
    this.interruptPromise = operation
    return operation
  }

  private async performInterrupt(): Promise<void> {
    const opts = this.opts
    const sessionId = this._sessionId
    if (!this.child || !opts || !sessionId) return
    const generation = this.stopGeneration
    await this.stopChild()
    // full app stop이 old child 종료를 기다리는 사이 들어왔으면 resume child를 띄우지 않는다.
    if (this.stopGeneration !== generation) return
    await this.start({ ...opts, resumeSessionId: sessionId })
  }

  async stop(): Promise<void> {
    this.stopGeneration += 1
    await this.stopChild()
  }

  private stopChild(): Promise<void> {
    if (this.stoppingChild) return this.stoppingChild
    const child = this.child
    if (!child) return Promise.resolve()

    const operation = this.performStopChild(child).finally(() => {
      if (this.stoppingChild === operation) this.stoppingChild = null
    })
    this.stoppingChild = operation
    return operation
  }

  private async performStopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    this.terminating.add(child)
    if (this.readyChild === child) this.readyChild = null
    this._busy = false
    // stdin만 닫아 부모 CLI가 먼저 사라지면 MCP·도구 자식이 고아가 될 수 있다.
    // 프로세스 트리 종료와 실제 close를 모두 확인한 뒤 다음 턴이나 앱 종료를 허용한다.
    await this.terminateChild(child, 'Claude Code')
  }
}

/**
 * 이 세션 전용 settings 파일을 쓴다.
 *
 * matcher 는 반드시 `"*"` 다. 실측에서 Read 만 막았더니 모델이 곧바로 Grep 으로 우회해
 * 같은 파일을 읽어냈다. 좁은 matcher 로 만든 readonly 는 readonly 가 아니다.
 */
export function writeSessionSettings(hookCommand: string): string {
  const dir = join(app.getPath('userData'), 'sessions')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `settings-${randomUUID()}.json`)
  writeFileSync(
    path,
    JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand }] }]
      }
    }),
    'utf8'
  )
  return path
}
