import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  UNITY_STABLE_RUN_MS,
  UNITY_TERMINATION_TIMEOUT_MS,
  UnityProcessManager,
  type SpawnLike
} from '../src/main/avatar/unityProcess'

/**
 * 실제 Unity 바이너리 없이 수명만 검증한다.
 *
 * 이 파일이 지키는 것은 **고아 프로세스가 남지 않는가**와 **무한 재시작에 빠지지
 * 않는가** 두 가지다. 둘 다 실제 앱에서는 재현시키기 번거롭고, 놓치면 투명한 유령
 * 창이 화면에 박히거나 로그만 채우며 도는 앱이 된다.
 */

class FakeChild extends EventEmitter {
  pid = 4321
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  kill = vi.fn()

  /** 프로세스가 스스로 죽은 상황. */
  die(code = 1): void {
    this.exitCode = code
    this.emit('exit', code, null)
  }
}

/** 존재가 보장된 실행 파일. 매니저는 spawn 전에 경로를 확인한다. */
const REAL_PATH = process.execPath

let spawned: FakeChild[] = []
let terminated: ChildProcess[] = []

const spawnFn: SpawnLike = vi.fn(() => {
  const child = new FakeChild()
  spawned.push(child)
  return child as unknown as ChildProcess
})

/** 기본 종료 경로는 Windows 에서 실제 taskkill 을 부른다. 테스트에서는 절대 쓰면 안 된다. */
const terminateFn = vi.fn((child: ChildProcess) => {
  terminated.push(child)
  const fake = child as unknown as FakeChild
  fake.exitCode = 0
  fake.emit('exit', 0, null)
})

function make(overrides: Partial<Parameters<typeof UnityProcessManager.prototype.constructor>[0]> = {}) {
  return new UnityProcessManager({
    playerPath: REAL_PATH,
    bridgeEnv: { WAIFU_AVATAR_PORT: '51234', WAIFU_AVATAR_TOKEN: 'a'.repeat(48) },
    maxRestarts: 2,
    launchTimeoutMs: 10_000,
    spawnFn,
    terminateFn,
    ...overrides
  })
}

beforeEach(() => {
  spawned = []
  terminated = []
  vi.mocked(spawnFn).mockClear()
  terminateFn.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('실행 조건', () => {
  it('경로가 비어 있으면 띄우지 않는다', () => {
    const log = vi.fn()
    make({ playerPath: '', log }).start()

    expect(spawnFn).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('info', expect.stringContaining('비어 있다'))
  })

  it('경로가 없으면 재시작 루프를 돌지 않고 바로 사용자에게 알린다', () => {
    const onGaveUp = vi.fn()
    make({ playerPath: 'Z:/없는/경로/WaifuAvatar.exe', onGaveUp }).start()

    expect(spawnFn).not.toHaveBeenCalled()
    expect(onGaveUp).toHaveBeenCalledWith(expect.stringContaining('찾을 수 없다'))
  })

  it('브리지 값만 덮어쓴 환경으로 띄운다', () => {
    make().start()

    expect(spawnFn).toHaveBeenCalledTimes(1)
    const options = vi.mocked(spawnFn).mock.calls[0]![2]
    expect(options.env.WAIFU_AVATAR_PORT).toBe('51234')
    expect(options.env.WAIFU_AVATAR_TOKEN).toBe('a'.repeat(48))
    // 부모 환경도 함께 물려받아야 Unity 가 시스템 경로를 찾는다.
    expect(options.env.PATH ?? options.env.Path).toBeDefined()
    // stdout 을 파이프로 열면 Unity 로그가 버퍼를 채워 프로세스가 멈출 수 있다.
    expect(options.stdio).toBe('ignore')
  })

  it('이미 떠 있으면 중복으로 띄우지 않는다', () => {
    const manager = make()
    manager.start()
    manager.start()
    expect(spawnFn).toHaveBeenCalledTimes(1)
  })
})

describe('재시작', () => {
  it('비정상 종료를 상한까지만 되살린다', () => {
    const onGaveUp = vi.fn()
    const manager = make({ maxRestarts: 2, onGaveUp })
    manager.start()

    spawned[0]!.die()
    expect(spawnFn).toHaveBeenCalledTimes(2)
    expect(manager.restartCount).toBe(1)

    spawned[1]!.die()
    expect(spawnFn).toHaveBeenCalledTimes(3)
    expect(manager.restartCount).toBe(2)

    // 상한 도달. 무한 재시작은 죽은 셸을 계속 되살리며 로그만 채운다.
    spawned[2]!.die()
    expect(spawnFn).toHaveBeenCalledTimes(3)
    expect(onGaveUp).toHaveBeenCalledTimes(1)
    expect(manager.running).toBe(false)
  })

  it('포기할 때 조용히 멈추지 않고 이유를 남긴다', () => {
    const onGaveUp = vi.fn()
    const log = vi.fn()
    const manager = make({ maxRestarts: 0, onGaveUp, log })
    manager.start()

    spawned[0]!.die(3)
    expect(onGaveUp).toHaveBeenCalledWith(expect.stringContaining('code=3'))
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining('반복해서 죽거나'))
  })

  it('연결 뒤 안정 가동 시간을 채우면 재시작 예산을 되돌려준다', () => {
    vi.useFakeTimers()
    // 며칠 켜둔 앱에서 어쩌다 난 크래시가 누적돼 멀쩡한 세션에서 상한이 터지면 안 된다.
    const manager = make({ maxRestarts: 1 })
    manager.start()

    spawned[0]!.die()
    expect(manager.restartCount).toBe(1)

    manager.notifyConnected()
    expect(manager.restartCount).toBe(1)
    vi.advanceTimersByTime(UNITY_STABLE_RUN_MS)
    expect(manager.restartCount).toBe(0)

    spawned[1]!.die()
    expect(manager.restartCount).toBe(1)
    expect(spawnFn).toHaveBeenCalledTimes(3)
  })

  it('연결 직후 반복 크래시는 재시작 상한을 우회하지 못한다', () => {
    vi.useFakeTimers()
    const onGaveUp = vi.fn()
    const manager = make({ maxRestarts: 1, onGaveUp })
    manager.start()

    manager.notifyConnected()
    spawned[0]!.die()
    expect(spawnFn).toHaveBeenCalledTimes(2)

    manager.notifyConnected()
    spawned[1]!.die()
    expect(spawnFn).toHaveBeenCalledTimes(2)
    expect(onGaveUp).toHaveBeenCalledTimes(1)
  })

  it('같은 child의 error 뒤 exit를 두 번 종료로 세지 않는다', () => {
    const manager = make({ maxRestarts: 2 })
    manager.start()

    spawned[0]!.emit('error', new Error('kill failed'))
    spawned[0]!.die()

    expect(spawnFn).toHaveBeenCalledTimes(2)
    expect(manager.restartCount).toBe(1)
  })

  it('핸드셰이크 timeout 종료 신호를 무시한 프로세스는 조용히 남기지 않는다', () => {
    vi.useFakeTimers()
    const onGaveUp = vi.fn()
    const manager = make({
      launchTimeoutMs: 10,
      terminateFn: vi.fn(),
      onGaveUp
    })
    manager.start()

    vi.advanceTimersByTime(10 + UNITY_TERMINATION_TIMEOUT_MS)

    expect(spawnFn).toHaveBeenCalledTimes(1)
    expect(onGaveUp).toHaveBeenCalledWith(expect.stringContaining('프로세스가 남아 있다'))
    expect(manager.running).toBe(true)
  })

  it('핸드셰이크가 없으면 시간 초과로 죽이고 다시 띄운다', () => {
    vi.useFakeTimers()
    const manager = make({ launchTimeoutMs: 5000 })
    manager.start()

    expect(terminateFn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(5000)

    // 프로세스는 떴는데 말이 안 통하는 상태다. 살려두면 화면에 유령이 남는다.
    expect(terminateFn).toHaveBeenCalledTimes(1)
    expect(spawnFn).toHaveBeenCalledTimes(2)
  })

  it('연결되면 시간 초과 타이머가 더 이상 죽이지 않는다', () => {
    vi.useFakeTimers()
    const manager = make({ launchTimeoutMs: 5000 })
    manager.start()

    manager.notifyConnected()
    vi.advanceTimersByTime(20_000)

    expect(terminateFn).not.toHaveBeenCalled()
    expect(spawnFn).toHaveBeenCalledTimes(1)
  })
})

describe('종료', () => {
  it('stop 은 프로세스를 죽이고 다시 띄우지 않는다', async () => {
    const manager = make()
    manager.start()

    await manager.stop()

    expect(terminated).toHaveLength(1)
    // 의도적 종료 뒤의 exit 는 재시작 사유가 아니다.
    expect(spawnFn).toHaveBeenCalledTimes(1)
    expect(manager.running).toBe(false)
  })

  it('stop 뒤에 늦게 도착한 exit 도 재시작을 부르지 않는다', async () => {
    const manager = make()
    manager.start()
    const child = spawned[0]!

    await manager.stop()
    child.emit('exit', 1, null)

    expect(spawnFn).toHaveBeenCalledTimes(1)
  })

  it('띄운 적 없으면 stop 은 아무것도 하지 않는다', async () => {
    await expect(make({ playerPath: '' }).stop()).resolves.toBeUndefined()
    expect(terminateFn).not.toHaveBeenCalled()
  })

  it('종료 명령 뒤에도 exit가 없으면 고아가 없다고 가장하지 않는다', async () => {
    vi.useFakeTimers()
    const neverExits = vi.fn()
    const manager = make({ terminateFn: neverExits })
    manager.start()

    const stopping = manager.stop()
    const rejected = expect(stopping).rejects.toThrow('종료 신호 뒤에도 남아 있다')
    await vi.advanceTimersByTimeAsync(UNITY_TERMINATION_TIMEOUT_MS)
    await rejected
    expect(neverExits).toHaveBeenCalledTimes(1)
    expect(manager.running).toBe(true)
  })

  it('종료 확인 실패 뒤 같은 child 핸들로 다시 종료를 시도할 수 있다', async () => {
    vi.useFakeTimers()
    const retryingTerminate = vi.fn((child: ChildProcess) => {
      if (retryingTerminate.mock.calls.length < 2) return
      const fake = child as unknown as FakeChild
      fake.exitCode = 0
      fake.emit('exit', 0, null)
    })
    const manager = make({ terminateFn: retryingTerminate })
    manager.start()

    const firstStop = manager.stop()
    const rejected = expect(firstStop).rejects.toThrow('종료 신호 뒤에도 남아 있다')
    await vi.advanceTimersByTimeAsync(UNITY_TERMINATION_TIMEOUT_MS)
    await rejected

    expect(manager.running).toBe(true)
    await expect(manager.stop()).resolves.toBeUndefined()
    expect(retryingTerminate).toHaveBeenCalledTimes(2)
    expect(retryingTerminate.mock.calls[0]![0]).toBe(retryingTerminate.mock.calls[1]![0])
    expect(manager.running).toBe(false)
  })

  it('동시에 들어온 stop은 하나의 종료 시도만 공유한다', async () => {
    const delayedTerminate = vi.fn()
    const manager = make({ terminateFn: delayedTerminate })
    manager.start()

    const firstStop = manager.stop()
    const secondStop = manager.stop()
    expect(delayedTerminate).toHaveBeenCalledTimes(1)

    spawned[0]!.die(0)
    await expect(Promise.all([firstStop, secondStop])).resolves.toEqual([undefined, undefined])
    expect(manager.running).toBe(false)
  })
})
