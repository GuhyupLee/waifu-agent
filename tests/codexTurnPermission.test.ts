import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessTreeTerminator } from '../src/main/backends/processTree'
import type { SessionOpts } from '../src/main/backends/types'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import { CodexBackend } from '../src/main/backends/codex'

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly kill = vi.fn(() => true)

  close(code = 0): void {
    this.emit('close', code, null)
  }
}

function options(overrides: Partial<SessionOpts> = {}): SessionOpts {
  return {
    bin: 'codex',
    cwd: 'C:\\workspace',
    workspaces: ['C:\\workspace'],
    permissionMode: 'auto',
    ...overrides
  }
}

function spawnedArgs(): string[] {
  const call = spawnMock.mock.calls.at(-1)
  if (!call) throw new Error('spawn이 호출되지 않았다')
  return call[1] as string[]
}

function spawnedOptions(): SpawnOptionsWithoutStdio {
  const call = spawnMock.mock.calls.at(-1)
  if (!call) throw new Error('spawn이 호출되지 않았다')
  return call[2] as SpawnOptionsWithoutStdio
}

function installFakeChild(): FakeChild {
  const child = new FakeChild()
  spawnMock.mockReturnValue(child as unknown as ChildProcessWithoutNullStreams)
  return child
}

beforeEach(() => {
  spawnMock.mockReset()
})

describe('CodexBackend 턴별 권한', () => {
  it('데스크톱 auto 턴은 기본값대로 danger-full-access로 실행한다', async () => {
    const child = installFakeChild()
    const backend = new CodexBackend()
    await backend.start(options())

    await backend.send('desktop request')

    const args = spawnedArgs()
    expect(args[args.indexOf('-s') + 1]).toBe('danger-full-access')
    expect(spawnedOptions().cwd).toBe('C:\\workspace')
    child.close()
  })

  it('원격 guarded override를 새 exec의 workspace-write로 낮춘다', async () => {
    const child = installFakeChild()
    const backend = new CodexBackend()
    await backend.start(options())

    await backend.send('remote request', { permissionMode: 'guarded' })

    const args = spawnedArgs()
    expect(args[args.indexOf('-s') + 1]).toBe('workspace-write')
    expect(args).not.toContain('danger-full-access')
    child.close()
  })

  it('원격 권한을 다음 데스크톱 턴으로 누출하지 않는다', async () => {
    const remoteChild = installFakeChild()
    const backend = new CodexBackend()
    await backend.start(options())
    await backend.send('remote request', { permissionMode: 'guarded' })
    remoteChild.close()

    const desktopChild = installFakeChild()
    await backend.send('desktop request')

    const args = spawnedArgs()
    expect(args[args.indexOf('-s') + 1]).toBe('danger-full-access')
    desktopChild.close()
  })

  it('원격 guarded override를 resume의 sandbox_mode로도 다시 주입한다', async () => {
    const child = installFakeChild()
    const backend = new CodexBackend()
    await backend.start(options({ resumeSessionId: 'thread-remote' }))

    await backend.send('continued remote request', { permissionMode: 'guarded' })

    const args = spawnedArgs()
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'thread-remote'])
    expect(args).toContain("sandbox_mode='workspace-write'")
    expect(args).not.toContain('-s')
    expect(args).not.toContain('danger-full-access')
    child.close()
  })

  it('종료 확인 실패 뒤 같은 child 트리로 stop을 재시도한다', async () => {
    const child = installFakeChild()
    let attempts = 0
    const terminateChild = vi.fn<ProcessTreeTerminator>((target) => {
      attempts += 1
      if (attempts === 1) return Promise.reject(new Error('first taskkill failed'))
      return new Promise<void>((resolve) => {
        target.once('close', resolve)
        child.close()
      })
    })
    const backend = new CodexBackend(terminateChild)
    await backend.start(options())
    await backend.send('desktop request')

    await expect(backend.stop()).rejects.toThrow('first taskkill failed')
    await expect(backend.send('must remain blocked')).rejects.toThrow('이전 턴이 아직 끝나지 않았다')
    await expect(backend.stop()).resolves.toBeUndefined()

    expect(terminateChild).toHaveBeenCalledTimes(2)
    expect(terminateChild.mock.calls[0]![0]).toBe(terminateChild.mock.calls[1]![0])
  })
})
