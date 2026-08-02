import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { BackendEvent, BackendKind, PermissionMode } from '@shared/protocol'
import { CodexEventMapper, codexExitEvents } from './codexEvents'
import { NdjsonReader, parseLines } from './ndjson'
import { cleanEnv } from './types'
import type { AgentBackend, BackendListener, SessionOpts } from './types'

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
  // 리터럴 문자열 안에는 작은따옴표를 넣을 수 없다. 있으면 기본 문자열로 물러난다.
  if (!s.includes("'")) return `'${s}'`
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export class CodexBackend implements AgentBackend {
  readonly kind: BackendKind = 'codex'

  private child: ChildProcessWithoutNullStreams | null = null
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

  async send(text: string): Promise<void> {
    const opts = this.opts
    if (!opts) throw new Error('백엔드가 시작되지 않았다')
    if (this.child) throw new Error('이전 턴이 아직 끝나지 않았다')

    this._busy = true
    const args = this.buildArgs(opts, text)

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

    const consume = (lines: string[]): void => {
      for (const raw of parseLines(lines)) {
        for (const ev of mapper.map(raw)) this.emit(ev)
      }
    }

    // stdout 만 파싱한다. stderr 에는 rmcp 트랜스포트 에러 같은 비 JSON 로그가 섞인다.
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (c: string) => consume(reader.push(c)))

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c: string) => {
      stderr += c
      process.stderr.write(`[codex] ${c}`)
    })

    child.on('error', (err) => {
      this._busy = false
      this.child = null
      this.emit({ type: 'error', message: `실행 실패: ${err.message}`, kind: 'not-found' })
    })

    child.on('close', (code) => {
      consume(reader.flush())
      this.child = null
      this._busy = false

      // 턴의 성패는 여기서 정해진다. item 단위 error 는 경고일 수 있어 신뢰할 수 없다.
      const exitEvents = codexExitEvents(code, stderr)
      if (exitEvents.length) {
        for (const ev of exitEvents) this.emit(ev)
      } else if (!mapper.sawTurnCompleted) {
        // 정상 종료했는데 turn.completed 를 못 봤다면 출력이 잘렸다는 뜻이다.
        this.emit({ type: 'result', text: mapper.resultText, isError: false })
      }
      this.emit({ type: 'exit', code })
    })
  }

  private buildArgs(opts: SessionOpts, prompt: string): string[] {
    const args = ['exec']

    // resume 은 첫 턴과 받는 플래그가 다르다. 섞으면 CLI 가 거부한다.
    if (this._sessionId) args.push('resume', this._sessionId)

    args.push('--json', '--skip-git-repo-check')

    if (opts.model) args.push('-m', opts.model)

    if (!this._sessionId) {
      // 첫 턴에서만 줄 수 있는 것들.
      args.push('-C', opts.cwd, '-s', sandboxFlag(opts.permissionMode))
      for (const dir of opts.workspaces) args.push('--add-dir', dir)
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

  /** 프로세스를 죽인다. 다음 send 는 같은 thread_id 로 이어붙는다. */
  async interrupt(): Promise<void> {
    await this.stop()
  }

  async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    this.child = null
    this._busy = false
    child.kill()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000)
      child.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}
