import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import type { BackendEvent, BackendKind, PermissionMode } from '@shared/protocol'
import { ClaudeEventMapper } from './claudeEvents'
import { NdjsonReader, parseLines } from './ndjson'
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
  private readonly reader = new NdjsonReader()
  private mapper = new ClaudeEventMapper()
  private readonly listeners = new Set<BackendListener>()

  private _sessionId: string | null = null
  private _busy = false
  private opts: SessionOpts | null = null

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
    this.opts = opts
    this.mapper = new ClaudeEventMapper()

    // 세션 id 를 우리가 정해두면 중단 후 --resume 으로 되살릴 때 참조할 값이 확실해진다.
    // (재개는 cwd 스코프라 Task 는 cwd 도 같이 기억해야 한다.)
    const sessionId = opts.resumeSessionId ?? randomUUID()
    const args = this.buildArgs(opts, sessionId)

    const child = spawn(opts.bin, args, {
      cwd: opts.cwd,
      // claude 는 실제 .exe 라 shell 이 필요 없다. shell:true 는 인자 이스케이프를 하지 않아
      // 경로에 공백이나 특수문자가 있으면 그대로 터진다.
      shell: false,
      windowsHide: true,
      env: { ...cleanEnv(), ...opts.extraEnv }
    })
    this.child = child

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.consume(this.reader.push(chunk)))

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c: string) => process.stderr.write(`[claude] ${c}`))

    child.on('error', (err) => {
      this.emit({ type: 'error', message: `실행 실패: ${err.message}`, kind: 'not-found' })
    })

    child.on('close', (code) => {
      this.consume(this.reader.flush())
      this.child = null
      this._busy = false
      this.emit({ type: 'exit', code })
    })

    if (!opts.resumeSessionId) this._sessionId = sessionId
  }

  private consume(lines: string[]): void {
    for (const raw of parseLines(lines, (l) => process.stderr.write(`[claude] JSON 아님: ${l}\n`))) {
      for (const ev of this.mapper.map(raw)) this.emit(ev)
    }
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
    const child = this.child
    if (!child) throw new Error('백엔드가 시작되지 않았다')
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
  async interrupt(): Promise<void> {
    const opts = this.opts
    const sessionId = this._sessionId
    if (!this.child || !opts || !sessionId) return
    await this.stop()
    await this.start({ ...opts, resumeSessionId: sessionId })
  }

  async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    this.child = null
    this._busy = false
    // stdin 을 닫으면 CLI 가 정상 종료 절차를 밟는다. 응답이 없으면 강제로 끊는다.
    try {
      child.stdin.end()
    } catch {
      /* 이미 닫혔으면 무시 */
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill()
        resolve()
      }, 3000)
      child.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })
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
