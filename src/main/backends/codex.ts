import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { BackendEvent, BackendKind, PermissionMode } from '@shared/protocol'
import {
  CodexEventMapper,
  codexCompletionEvents,
  codexSpawnErrorEvents
} from './codexEvents'
import { NdjsonReader, parseLines } from './ndjson'
import { terminateProcessTree } from './processTree'
import type { ProcessTreeTerminator } from './processTree'
import { cleanEnv } from './types'
import type { AgentBackend, BackendListener, BackendTurnOpts, SessionOpts } from './types'

/**
 * Codex CLI 백엔드.
 *
 * Claude Code 와 달리 **턴마다 프로세스를 새로 띄운다.** `codex exec` 에는 stdin 으로
 * 여러 턴을 밀어 넣는 모드가 없고, 대신 `codex exec resume <thread_id>` 로 이어붙인다.
 *
 * 첫 턴과 resume 이 받는 플래그가 다르다 (`codex exec resume --help` 로 확인):
 *   resume 에는 `-s/--sandbox`, `-C/--cd`, `--add-dir` 가 **없다.**
 *   그래서 작업 디렉터리와 샌드박스는 첫 턴에서 정해지고, 이후에는 `-c` 오버라이드로만 건드린다.
 *
 * 권한 한계: Codex 에는 Claude Code 의 PreToolUse 훅에 해당하는 것이 없다.
 * 사용자에게 물어보고 승인받는 경로를 만들 수 없어서 샌드박스 등급이 유일한 통제 수단이다.
 * 같은 'guarded' 라도 Claude Code 쪽이 더 촘촘하다 — 설정 화면에서 이 차이를 알려야 한다.
 */

function sandboxFlag(mode: PermissionMode): string {
  switch (mode) {
    case 'readonly':
      return 'read-only'
    case 'auto':
      return 'danger-full-access'
    case 'guarded':
    default:
      return 'workspace-write'
  }
}

/**
 * `-c key=value` 의 값은 TOML 로 파싱된다. Windows 경로의 백슬래시가
 * TOML 기본 문자열에서는 이스케이프로 먹히므로, 이스케이프를 처리하지 않는
 * 리터럴 문자열(작은따옴표)로 감싼다.
 */
function tomlLiteral(s: string): string {
  // 리터럴 문자열 안에는 작은따옴표나 개행을 넣을 수 없다. JSON 문자열 표기는 TOML 기본
  // 문자열의 escape 규칙과 호환되므로 멀티라인 system prompt도 한 CLI 인자로 안전하게 간다.
  if (!s.includes("'") && !/[\u0000-\u001f\u007f]/.test(s)) return `'${s}'`
  return JSON.stringify(s)
}

/** 실제 spawn에 넘길 인자를 순수 함수로 만들어 CLI help 계약을 테스트로 고정한다. */
export function buildCodexArgs(
  opts: SessionOpts,
  prompt: string,
  sessionId: string | null
): string[] {
  const args = ['exec']

  // resume 은 첫 턴과 받는 플래그가 다르다. 섞으면 CLI 가 거부한다.
  if (sessionId) args.push('resume', sessionId)

  args.push('--json', '--skip-git-repo-check')

  if (opts.model) args.push('-m', opts.model)

  if (!sessionId) {
    // 첫 턴에서만 줄 수 있는 것들.
    args.push('-C', opts.cwd, '-s', sandboxFlag(opts.permissionMode))
    for (const dir of opts.workspaces) args.push('--add-dir', dir)
  } else {
    // resume에는 -s가 없지만 config override는 받는다.
    args.push('-c', `sandbox_mode=${tomlLiteral(sandboxFlag(opts.permissionMode))}`)
  }

  // Codex에는 --append-system-prompt가 없다. 앱의 persona/도구 지시는 config로 주입한다.
  if (opts.systemPrompt) {
    args.push('-c', `developer_instructions=${tomlLiteral(opts.systemPrompt)}`)
  }

  // MCP 는 --mcp-config 플래그가 없다. config 오버라이드로 주입한다.
  if (opts.codexMcp) {
    const { command, args: mcpArgs, env } = opts.codexMcp
    args.push('-c', `mcp_servers.waifu.command=${tomlLiteral(command)}`)
    args.push('-c', `mcp_servers.waifu.args=[${mcpArgs.map(tomlLiteral).join(',')}]`)
    for (const [k, v] of Object.entries(env)) {
      args.push('-c', `mcp_servers.waifu.env.${k}=${tomlLiteral(v)}`)
    }
  }

  // 프롬프트는 마지막 위치 인자다.
  args.push(prompt)
  return args
}

const STDERR_TAIL_LIMIT = 4000

export class CodexBackend implements AgentBackend {
  readonly kind: BackendKind = 'codex'

  private child: ChildProcessWithoutNullStreams | null = null
  private readonly listeners = new Set<BackendListener>()
  private _sessionId: string | null = null
  private _busy = false
  private opts: SessionOpts | null = null
  private stopping: Promise<void> | null = null
  private readonly interrupted = new WeakSet<ChildProcessWithoutNullStreams>()

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
    for (const l of this.listeners) l(event)
  }

  /**
   * Codex 는 프로세스를 미리 띄워둘 수 없다. 여기서는 설정만 기억하고,
   * 실제 실행은 send 에서 한다.
   */
  async start(opts: SessionOpts): Promise<void> {
    this.opts = opts
    if (opts.resumeSessionId) this._sessionId = opts.resumeSessionId
  }

  async send(text: string, turnOpts?: BackendTurnOpts): Promise<void> {
    const opts = this.opts
    if (!opts) throw new Error('백엔드가 시작되지 않았다')
    if (this.child || this.stopping) throw new Error('이전 턴이 아직 끝나지 않았다')

    this._busy = true
    // Discord 같은 원격 출처는 앱 기본값보다 낮은 권한을 줄 수 있다.
    // 세션 설정 자체를 바꾸면 다음 데스크톱 턴까지 낮아지므로 spawn 인자만 덮어쓴다.
    const effectiveOpts: SessionOpts = {
      ...opts,
      permissionMode: turnOpts?.permissionMode ?? opts.permissionMode
    }
    const args = buildCodexArgs(effectiveOpts, text, this._sessionId)

    const child = spawn(opts.bin, args, {
      cwd: opts.cwd,
      shell: false,
      windowsHide: true,
      env: { ...cleanEnv(), ...opts.extraEnv }
    })
    this.child = child

    const reader = new NdjsonReader()
    const mapper = new CodexEventMapper()
    let stderr = ''
    let spawnFailed = false

    const consume = (lines: string[]): void => {
      // stop timeout 뒤 늦게 도착한 이전 프로세스 출력은 새 Task에 섞이면 안 된다.
      if (this.child !== child || this.interrupted.has(child) || spawnFailed) return
      for (const raw of parseLines(lines, () => {
        process.stderr.write('[codex] JSON이 아닌 stdout 한 줄을 건너뛰었다\n')
      })) {
        for (const ev of mapper.map(raw)) this.emit(ev)
      }
    }

    // stdout 만 파싱한다. stderr 에는 rmcp 트랜스포트 에러 같은 비 JSON 로그가 섞인다.
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (c: string) => consume(reader.push(c)))

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c: string) => {
      stderr = (stderr + c).slice(-STDERR_TAIL_LIMIT)
      process.stderr.write(`[codex] ${c}`)
    })

    child.on('error', (err) => {
      if (spawnFailed || this.child !== child || this.interrupted.has(child)) return
      spawnFailed = true
      this._busy = false
      for (const ev of codexSpawnErrorEvents(err.message)) this.emit(ev)
    })

    child.on('close', (code) => {
      // stop timeout 후 새 프로세스가 시작됐다면 이전 close가 현재 상태를 지우면 안 된다.
      if (this.child !== child) return

      const wasInterrupted = this.interrupted.has(child)
      if (!wasInterrupted) consume(reader.flush())
      this.child = null
      this._busy = false

      // spawn error 뒤에도 close가 오므로 같은 실패를 두 번 올리지 않는다.
      // 사용자 중단도 실패 result로 바꾸지 않는다. 현재 프로토콜에는 cancelled 상태가 없다.
      if (!spawnFailed && !wasInterrupted) {
        for (const ev of codexCompletionEvents(
          code,
          stderr,
          mapper.sawTurnCompleted,
          mapper.resultText,
          mapper.turnFailureMessage
        )) {
          this.emit(ev)
        }
      }
      this.emit({ type: 'exit', code })
    })
  }

  /** 프로세스를 죽인다. 다음 send 는 같은 thread_id 로 이어붙는다. */
  async interrupt(): Promise<void> {
    await this.stop()
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping
    const child = this.child
    if (!child) return
    this.interrupted.add(child)

    const waitForStop = Promise.resolve().then(() => this.terminateChild(child, 'Codex'))
    this.stopping = waitForStop

    try {
      await waitForStop
    } finally {
      // 종료 확인에 실패한 child 핸들은 보존해 다음 stop()에서 같은 트리를 다시 정리한다.
      this._busy = false
      this.stopping = null
    }
  }
}
