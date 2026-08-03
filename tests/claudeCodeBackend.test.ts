import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackendEvent } from '../src/shared/protocol'
import type { ProcessTreeTerminator } from '../src/main/backends/processTree'
import type { SessionOpts } from '../src/main/backends/types'

const childProcess = vi.hoisted(() => ({ spawn: vi.fn() }))

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return { ...actual, spawn: childProcess.spawn }
})

// writeSessionSettings만 Electron app을 쓴다. 백엔드 수명 테스트에서 실제 Electron을 띄우지 않는다.
vi.mock('electron', () => ({ app: { getPath: vi.fn(() => process.cwd()) } }))

import { ClaudeCodeBackend } from '../src/main/backends/claudeCode'

class FakePipe extends EventEmitter {
  readonly setEncoding = vi.fn()
  readonly write = vi.fn(() => true)
  readonly end = vi.fn()
}

class FakeChild extends EventEmitter {
  readonly stdin = new FakePipe()
  readonly stdout = new FakePipe()
  readonly stderr = new FakePipe()
  readonly kill = vi.fn(() => true)
}

const terminateFakeChild: ProcessTreeTerminator = (child) =>
  new Promise<void>((resolve, reject) => {
    child.once('close', resolve)
    try {
      child.kill('SIGKILL')
    } catch (error) {
      reject(error as Error)
    }
  })

function makeBackend(terminateChild: ProcessTreeTerminator = terminateFakeChild): ClaudeCodeBackend {
  return new ClaudeCodeBackend(terminateChild)
}

function options(overrides: Partial<SessionOpts> = {}): SessionOpts {
  return {
    bin: 'C:\\fake-bin\\claude.exe',
    cwd: process.cwd(),
    workspaces: [],
    permissionMode: 'guarded',
    ...overrides
  }
}

let spawned: FakeChild[]

beforeEach(() => {
  spawned = []
  childProcess.spawn.mockReset()
  childProcess.spawn.mockImplementation(() => {
    const child = new FakeChild()
    spawned.push(child)
    return child as unknown as ChildProcessWithoutNullStreams
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ClaudeCodeBackend startup readiness', () => {
  it('child spawn 이벤트 전에는 start를 성공시키거나 입력을 받지 않는다', async () => {
    const backend = makeBackend()
    const starting = backend.start(options())
    let settled = false
    void starting.finally(() => {
      settled = true
    })

    await Promise.resolve()
    expect(settled).toBe(false)
    expect(backend.sessionId).toBeNull()
    await expect(backend.send('too early')).rejects.toThrow('백엔드가 시작되지 않았다')

    spawned[0]!.emit('spawn')
    await expect(starting).resolves.toBeUndefined()
    expect(backend.sessionId).toEqual(expect.any(String))

    await backend.send('hello')
    expect(spawned[0]!.stdin.write).toHaveBeenCalledWith(expect.stringContaining('hello'))

    spawned[0]!.emit('close', 0)
    expect(backend.busy).toBe(false)
  })

  it('startup error를 이벤트로 한 번 알리고 start도 같은 실패로 reject한다', async () => {
    const backend = makeBackend()
    const events: BackendEvent[] = []
    backend.onEvent((event) => events.push(event))
    const starting = backend.start(options())
    const failure = new Error('spawn ENOENT C:\\fake-bin\\claude.exe')

    spawned[0]!.emit('error', failure)
    await expect(starting).rejects.toThrow(failure.message)

    // Node는 spawn 실패 뒤 close를 보낸다. 중복 error도 같은 장애를 두 번 보고하면 안 된다.
    spawned[0]!.emit('error', failure)
    spawned[0]!.emit('close', -2)
    spawned[0]!.emit('close', -2)

    expect(events.filter((event) => event.type === 'error')).toEqual([
      { type: 'error', message: `실행 실패: ${failure.message}`, kind: 'not-found' }
    ])
    expect(events.filter((event) => event.type === 'exit')).toEqual([{ type: 'exit', code: -2 }])
    expect(backend.busy).toBe(false)
    await expect(backend.send('must not run')).rejects.toThrow('백엔드가 시작되지 않았다')
  })

  it('spawn 전에 close만 와도 start가 남지 않고 실패한다', async () => {
    const backend = makeBackend()
    const events: BackendEvent[] = []
    backend.onEvent((event) => events.push(event))
    const starting = backend.start(options())

    spawned[0]!.emit('close', 127)

    await expect(starting).rejects.toThrow('프로세스가 시작 전에 종료됨')
    expect(events.filter((event) => event.type === 'error')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'exit')).toEqual([{ type: 'exit', code: 127 }])
  })

  it('종료한 child의 close를 확인해야 다음 프로세스를 시작한다', async () => {
    const backend = makeBackend()
    const events: BackendEvent[] = []
    backend.onEvent((event) => events.push(event))

    const firstStart = backend.start(options())
    const first = spawned[0]!
    first.emit('spawn')
    await firstStart
    first.kill.mockImplementation(() => {
      first.emit('close', 0)
      return true
    })

    const stopping = backend.stop()
    await stopping
    expect(first.kill).toHaveBeenCalledTimes(1)

    const secondStart = backend.start(options({ bin: 'C:\\fake-bin\\claude-2.exe' }))
    const second = spawned[1]!
    second.emit('spawn')
    await secondStart
    await backend.send('second process')
    expect(backend.busy).toBe(true)

    first.stdout.emit('data', '{"type":"result","result":"stale"}\n')
    first.emit('error', new Error('late error'))

    expect(backend.busy).toBe(true)
    expect(events.filter((event) => event.type === 'error')).toHaveLength(0)
    expect(events.filter((event) => event.type === 'exit')).toEqual([{ type: 'exit', code: 0 }])
    expect(second.stdin.write).toHaveBeenCalledTimes(1)

    second.emit('close', 0)
    expect(backend.busy).toBe(false)
    expect(events.filter((event) => event.type === 'exit')).toEqual([
      { type: 'exit', code: 0 },
      { type: 'exit', code: 0 }
    ])
  })

  it('종료 확인 실패를 성공으로 가장하지 않는다', async () => {
    vi.useFakeTimers()
    const terminateChild = vi.fn<ProcessTreeTerminator>(
      () =>
        new Promise<void>((_resolve, reject) => {
          setTimeout(() => reject(new Error('Claude Code 프로세스 트리가 종료 신호 뒤에도 남아 있습니다')), 5000)
        })
    )
    const backend = makeBackend(terminateChild)
    const starting = backend.start(options())
    const child = spawned[0]!
    child.emit('spawn')
    await starting

    const stopping = backend.stop()
    const failure = stopping.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(5000)
    expect(await failure).toEqual(
      expect.objectContaining({ message: expect.stringContaining('종료 신호 뒤에도 남아 있습니다') })
    )
    expect(terminateChild).toHaveBeenCalledTimes(1)
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('interrupt가 old child를 닫는 동안 full stop이 오면 resume child를 띄우지 않는다', async () => {
    const backend = makeBackend()
    const starting = backend.start(options())
    const first = spawned[0]!
    first.emit('spawn')
    await starting

    const interrupting = backend.interrupt()
    // full stop은 같은 종료 작업을 공유하면서 세대를 올려 resume spawn만 취소한다.
    const stopping = backend.stop()
    first.emit('close', 0)
    await Promise.all([interrupting, stopping])

    expect(spawned).toHaveLength(1)
    await expect(backend.send('must stay stopped')).rejects.toThrow('백엔드가 시작되지 않았다')
  })

  it('종료 확인 실패 뒤 같은 child 트리로 stop을 재시도한다', async () => {
    let attempts = 0
    const terminateChild = vi.fn<ProcessTreeTerminator>((child) => {
      attempts += 1
      if (attempts === 1) return Promise.reject(new Error('first taskkill failed'))
      return new Promise<void>((resolve) => {
        child.once('close', resolve)
        child.kill('SIGKILL')
      })
    })
    const backend = makeBackend(terminateChild)
    const starting = backend.start(options())
    const child = spawned[0]!
    child.emit('spawn')
    await starting

    await expect(backend.stop()).rejects.toThrow('first taskkill failed')
    child.kill.mockImplementation(() => {
      child.emit('close', 0)
      return true
    })
    await expect(backend.stop()).resolves.toBeUndefined()

    expect(terminateChild).toHaveBeenCalledTimes(2)
    expect(terminateChild.mock.calls[0]![0]).toBe(terminateChild.mock.calls[1]![0])
  })
})
