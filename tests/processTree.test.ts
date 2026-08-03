import { EventEmitter } from 'node:events'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PROCESS_TREE_TERMINATION_TIMEOUT_MS,
  terminateProcessTree,
  type TerminationCommandSpawn
} from '../src/main/backends/processTree'

class FakeProcess extends EventEmitter {
  pid: number | undefined
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly kill = vi.fn(() => true)

  constructor(pid?: number) {
    super()
    this.pid = pid
  }

  close(code = 0): void {
    this.exitCode = code
    this.emit('close', code, null)
  }
}

function asChild(process: FakeProcess): ChildProcess {
  return process as unknown as ChildProcess
}

async function waitForPidExit(pid: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`process ${pid} is still alive`)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('CLI process tree termination', () => {
  it('Windows에서 taskkill /T /F와 원래 child close를 모두 확인한다', async () => {
    const target = new FakeProcess(4321)
    const taskkill = new FakeProcess(9001)
    const spawnFn = vi.fn<TerminationCommandSpawn>(() => asChild(taskkill))

    const stopping = terminateProcessTree(asChild(target), 'Codex', {
      platform: 'win32',
      timeoutMs: 1000,
      spawnFn
    })
    let settled = false
    void stopping.then(() => {
      settled = true
    })

    expect(spawnFn).toHaveBeenCalledWith('taskkill', ['/PID', '4321', '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      shell: false
    })

    taskkill.close(0)
    await Promise.resolve()
    expect(settled).toBe(false)

    target.close(1)
    await expect(stopping).resolves.toBeUndefined()
    expect(settled).toBe(true)
  })

  it('taskkill 실패를 성공으로 숨기지 않는다', async () => {
    const target = new FakeProcess(4321)
    const taskkill = new FakeProcess(9001)
    const spawnFn = vi.fn<TerminationCommandSpawn>(() => asChild(taskkill))
    const stopping = terminateProcessTree(asChild(target), 'Claude Code', {
      platform: 'win32',
      timeoutMs: 1000,
      spawnFn
    })

    taskkill.close(1)

    await expect(stopping).rejects.toThrow('프로세스 트리 종료 명령이 실패했습니다')
  })

  it('taskkill 성공 뒤에도 child close가 없으면 타임아웃으로 실패한다', async () => {
    vi.useFakeTimers()
    const target = new FakeProcess(4321)
    const taskkill = new FakeProcess(9001)
    const spawnFn = vi.fn<TerminationCommandSpawn>(() => asChild(taskkill))
    const stopping = terminateProcessTree(asChild(target), 'Codex', {
      platform: 'win32',
      spawnFn
    })

    taskkill.close(0)
    const rejected = expect(stopping).rejects.toThrow('종료 신호 뒤에도 남아 있습니다')
    await vi.advanceTimersByTimeAsync(PROCESS_TREE_TERMINATION_TIMEOUT_MS)
    await rejected
  })

  it('Windows가 아니면 직계 child에 SIGKILL을 보내고 close를 기다린다', async () => {
    const target = new FakeProcess(4321)
    target.kill.mockImplementation(() => {
      target.close(0)
      return true
    })
    const spawnFn = vi.fn<TerminationCommandSpawn>()

    await expect(
      terminateProcessTree(asChild(target), 'Codex', {
        platform: 'linux',
        timeoutMs: 1000,
        spawnFn
      })
    ).resolves.toBeUndefined()

    expect(target.kill).toHaveBeenCalledWith('SIGKILL')
    expect(spawnFn).not.toHaveBeenCalled()
  })

  it.runIf(process.platform === 'win32')(
    '실제 Windows 부모와 자식 프로세스를 함께 종료한다',
    async () => {
      const parent = spawn(
        process.execPath,
        [
          '-e',
          "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});process.stdout.write(String(c.pid)+'\\n');setInterval(()=>{},1000)"
        ],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
      )
      const parentPid = parent.pid
      expect(parentPid).toEqual(expect.any(Number))
      const [chunk] = (await once(parent.stdout!, 'data')) as [Buffer]
      const childPid = Number(chunk.toString('utf8').trim())
      expect(childPid).toBeGreaterThan(0)

      try {
        await terminateProcessTree(parent, 'Windows probe')
        await waitForPidExit(parentPid!)
        await waitForPidExit(childPid)
      } finally {
        for (const pid of [parentPid, childPid]) {
          if (!pid) continue
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            // 이미 taskkill로 사라진 정확한 테스트 PID다.
          }
        }
      }
    }
  )
})
