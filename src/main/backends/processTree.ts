import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

/** CLI와 그 하위 도구 프로세스가 종료됐다고 확인할 때까지 기다리는 최대 시간. */
export const PROCESS_TREE_TERMINATION_TIMEOUT_MS = 5_000

export type TerminationCommandSpawn = (
  command: string,
  args: string[],
  options: { stdio: 'ignore'; windowsHide: boolean; shell: false }
) => ChildProcess

export interface ProcessTreeTerminationOptions {
  platform?: NodeJS.Platform
  timeoutMs?: number
  spawnFn?: TerminationCommandSpawn
}

export type ProcessTreeTerminator = (child: ChildProcess, label: string) => Promise<void>

/**
 * CLI 하나가 아니라 그 CLI가 만든 MCP·셸·도구 프로세스 트리 전체를 종료한다.
 *
 * Windows의 `ChildProcess.kill()`은 직계 프로세스에만 신호를 보내므로 `taskkill /T /F`가
 * 성공하고 원래 child의 `close`까지 온 경우에만 완료로 인정한다. 종료를 확인하지 못하면
 * 호출자가 같은 child 핸들로 다시 시도할 수 있도록 실패를 숨기지 않는다.
 */
export function terminateProcessTree(
  child: ChildProcess,
  label: string,
  options: ProcessTreeTerminationOptions = {}
): Promise<void> {
  const platform = options.platform ?? process.platform
  const timeoutMs = options.timeoutMs ?? PROCESS_TREE_TERMINATION_TIMEOUT_MS
  const spawnFn = options.spawnFn ?? (spawn as unknown as TerminationCommandSpawn)

  return new Promise<void>((resolve, reject) => {
    let settled = false
    let targetClosed = false
    let terminatorClosed = platform !== 'win32'
    let terminator: ChildProcess | null = null

    const cleanup = (): void => {
      clearTimeout(timer)
      child.off('close', onTargetClose)
      terminator?.off('error', onTerminatorError)
      terminator?.off('close', onTerminatorClose)
    }
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve()
    }
    const maybeFinish = (): void => {
      if (targetClosed && terminatorClosed) finish()
    }
    const onTargetClose = (): void => {
      targetClosed = true
      maybeFinish()
    }
    const onTerminatorError = (error: Error): void => {
      try {
        child.kill('SIGKILL')
      } catch {
        // 직계 프로세스라도 정리하려는 최후 시도다. 원래 taskkill 오류를 아래에서 보고한다.
      }
      finish(new Error(`${label} 프로세스 트리 종료 명령을 실행하지 못했습니다: ${error.message}`))
    }
    const onTerminatorClose = (code: number | null): void => {
      if (code !== 0) {
        finish(new Error(`${label} 프로세스 트리 종료 명령이 실패했습니다 (code=${String(code)})`))
        return
      }
      terminatorClosed = true
      maybeFinish()
    }
    const timer = setTimeout(() => {
      try {
        terminator?.kill('SIGKILL')
      } catch {
        // 타임아웃 오류가 실제 실패 원인을 보존한다.
      }
      finish(new Error(`${label} 프로세스 트리가 종료 신호 뒤에도 남아 있습니다`))
    }, timeoutMs)

    child.once('close', onTargetClose)

    try {
      if (platform === 'win32') {
        const pid = child.pid
        if (!pid || pid <= 0) {
          finish(new Error(`${label} 프로세스 트리를 종료할 PID가 없습니다`))
          return
        }

        terminator = spawnFn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
          shell: false
        })
        terminator.once('error', onTerminatorError)
        terminator.once('close', onTerminatorClose)
        return
      }

      if (!child.kill('SIGKILL') && child.exitCode === null && child.signalCode === null) {
        finish(new Error(`${label} 프로세스에 종료 신호를 보내지 못했습니다`))
      }
    } catch (error) {
      finish(new Error(`${label} 프로세스를 종료하지 못했습니다: ${String(error)}`))
    }
  })
}
