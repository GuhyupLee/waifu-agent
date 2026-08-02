import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'

/**
 * Unity Avatar Shell 프로세스의 수명.
 *
 * **고아 프로세스가 이 파일의 존재 이유다.** Unity 창은 투명하고 클릭이 통과하므로,
 * Electron 이 죽은 뒤에 남으면 사용자는 그것을 닫을 방법이 없다 — 보이지도 않고
 * 눌리지도 않는 창이 화면에 박힌다. 작업 관리자를 열어야 지울 수 있다.
 *
 * 그래서 방어를 두 겹으로 둔다:
 *  1. 여기서 종료 시 확실히 죽인다 (Windows 는 프로세스 트리째).
 *  2. Unity 쪽은 브리지 연결이 끊기면 **스스로 종료한다**. Electron 이 크래시하면
 *     1번은 실행될 기회조차 없기 때문에, 진짜 안전망은 2번이다.
 */

export type SpawnLike = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: 'ignore'; windowsHide: boolean }
) => ChildProcess

export interface UnityProcessOptions {
  /** 빈 문자열이면 셸을 띄우지 않는다. */
  playerPath: string
  /** 브리지 포트·토큰. 여기 담긴 것 말고는 Unity 로 넘어가지 않는다. */
  bridgeEnv: Record<string, string>
  maxRestarts: number
  /** 이 시간 안에 핸드셰이크가 없으면 실패한 실행으로 본다. */
  launchTimeoutMs: number
  log?: (level: 'info' | 'warn' | 'error', message: string) => void
  /** 재시작 상한에 닿았다. 사용자에게 알릴 마지막 기회다. */
  onGaveUp?: (reason: string) => void
  /** 테스트에서 실제 바이너리 없이 돌리기 위한 구멍. */
  spawnFn?: SpawnLike
  /**
   * 종료 방법을 갈아끼우는 구멍.
   *
   * 기본 구현은 Windows 에서 `taskkill /T` 를 부른다. 가짜 pid 를 넘기는 테스트가
   * 그대로 실행하면 **무관한 실제 프로세스를 죽일 수 있다.**
   */
  terminateFn?: (child: ChildProcess) => void
}

export class UnityProcessManager {
  private child: ChildProcess | null = null
  private restarts = 0
  private launchTimer: NodeJS.Timeout | null = null
  /** 우리가 의도적으로 죽이는 중인가. 그렇다면 exit 를 재시작 사유로 보지 않는다. */
  private stopping = false
  private readonly spawnFn: SpawnLike

  constructor(private readonly options: UnityProcessOptions) {
    this.spawnFn = options.spawnFn ?? (spawn as unknown as SpawnLike)
  }

  get running(): boolean {
    return this.child !== null
  }

  /** 현재까지의 재시작 횟수. 테스트와 진단용. */
  get restartCount(): number {
    return this.restarts
  }

  start(): void {
    const { playerPath, log } = this.options

    if (!playerPath) {
      log?.('info', 'Unity 플레이어 경로가 비어 있다. 아바타 셸을 띄우지 않는다.')
      return
    }
    // 없는 경로로 spawn 하면 ENOENT 가 비동기로 와서 재시작 루프를 한 바퀴 돈다.
    // 먼저 확인하면 사용자에게 정확한 이유를 바로 줄 수 있다.
    if (!existsSync(playerPath)) {
      log?.('error', `Unity 플레이어를 찾을 수 없다: ${playerPath}`)
      this.options.onGaveUp?.(`Unity 플레이어를 찾을 수 없다: ${playerPath}`)
      return
    }
    if (this.child) return

    this.stopping = false
    this.spawnOnce()
  }

  private spawnOnce(): void {
    const { playerPath, bridgeEnv, launchTimeoutMs, log } = this.options

    let child: ChildProcess
    try {
      child = this.spawnFn(playerPath, [], {
        // 부모 환경을 통째로 물려주되 브리지 값을 덮어쓴다. Unity 는 이 두 개만 읽는다.
        env: { ...process.env, ...bridgeEnv },
        // stdout 을 파이프로 열어두면 Unity 가 로그를 쏟을 때 버퍼가 차서 멈출 수 있다.
        // Unity 는 자체 로그 파일을 쓰므로 우리가 받을 이유가 없다.
        stdio: 'ignore',
        windowsHide: true
      })
    } catch (err) {
      this.onExit(`spawn 실패: ${(err as Error).message}`)
      return
    }

    this.child = child
    log?.('info', `Unity 셸 시작 (pid ${child.pid ?? -1})`)

    this.launchTimer = setTimeout(() => {
      // 프로세스는 떴는데 핸드셰이크가 안 왔다. 창만 떠 있고 말이 안 통하는 상태라
      // 살려두면 화면에 유령이 남는다.
      log?.('warn', '핸드셰이크 시간 초과. Unity 셸을 다시 띄운다.')
      this.killChild()
    }, launchTimeoutMs)
    this.launchTimer.unref?.()

    child.once('error', (err) => this.onExit(`프로세스 오류: ${err.message}`))
    child.once('exit', (code, signal) =>
      this.onExit(`종료 (code=${String(code)}, signal=${String(signal)})`)
    )
  }

  /**
   * 브리지가 인증까지 끝냈다. 이 실행은 성공이므로 재시작 예산을 되돌려준다.
   *
   * 되돌리지 않으면 며칠 켜둔 앱에서 어쩌다 한 번씩 난 크래시가 누적돼
   * 멀쩡한 세션에서 "재시작 상한 도달"이 뜬다.
   */
  notifyConnected(): void {
    if (this.launchTimer) {
      clearTimeout(this.launchTimer)
      this.launchTimer = null
    }
    this.restarts = 0
  }

  private onExit(reason: string): void {
    if (this.launchTimer) {
      clearTimeout(this.launchTimer)
      this.launchTimer = null
    }
    this.child = null

    if (this.stopping) return

    const { maxRestarts, log } = this.options
    if (this.restarts >= maxRestarts) {
      const message = `Unity 셸이 반복해서 죽는다 (${this.restarts}회). 다시 띄우지 않는다. 마지막 사유: ${reason}`
      log?.('error', message)
      this.options.onGaveUp?.(message)
      return
    }

    this.restarts += 1
    log?.('warn', `Unity 셸 재시작 ${this.restarts}/${maxRestarts} — ${reason}`)
    this.spawnOnce()
  }

  /** 의도적 종료. 이후 exit 는 재시작을 부르지 않는다. */
  async stop(): Promise<void> {
    this.stopping = true
    if (this.launchTimer) {
      clearTimeout(this.launchTimer)
      this.launchTimer = null
    }

    const child = this.child
    this.child = null
    if (!child || child.exitCode !== null) return

    await new Promise<void>((resolve) => {
      const done = setTimeout(resolve, 3000)
      done.unref?.()
      child.once('exit', () => {
        clearTimeout(done)
        resolve()
      })
      this.terminate(child)
    })
  }

  private killChild(): void {
    if (this.child) this.terminate(this.child)
  }

  private terminate(child: ChildProcess): void {
    if (this.options.terminateFn) {
      this.options.terminateFn(child)
      return
    }

    const pid = child.pid
    // 이미 끝난 프로세스의 pid 로 taskkill 을 부르면 안 된다. OS 가 pid 를 재사용하므로
    // 그 사이 같은 번호를 받은 무관한 프로세스를 죽일 수 있다.
    if (child.exitCode !== null || child.signalCode !== null) return

    // Windows 의 kill() 은 직계 프로세스만 죽인다. Unity 플레이어가 자식을 두면
    // 그쪽이 남아 창을 붙잡는다. taskkill /T 로 트리째 정리한다.
    if (process.platform === 'win32' && pid) {
      try {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true
        })
        return
      } catch {
        // taskkill 이 없거나 막힌 환경이면 아래 표준 경로로 떨어진다.
      }
    }
    child.kill('SIGTERM')
  }
}
