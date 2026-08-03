import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../src/shared/protocol'
import { UnityAvatarShell } from '../src/main/avatar/shell'

type Stoppable = { stop: () => Promise<void> }

function attachParts(
  shell: UnityAvatarShell,
  process: Stoppable | null,
  bridge: Stoppable | null
): void {
  const internals = shell as unknown as {
    process: Stoppable | null
    bridge: Stoppable | null
  }
  internals.process = process
  internals.bridge = bridge
}

describe('UnityAvatarShell 종료', () => {
  it('프로세스 종료가 실패해도 로컬 브리지를 닫는다', async () => {
    const processStop = vi.fn().mockRejectedValue(new Error('process stuck'))
    const bridgeStop = vi.fn().mockResolvedValue(undefined)
    const shell = new UnityAvatarShell(structuredClone(DEFAULT_CONFIG))
    attachParts(shell, { stop: processStop }, { stop: bridgeStop })

    await expect(shell.stop()).rejects.toThrow('process stuck')
    expect(processStop).toHaveBeenCalledTimes(1)
    expect(bridgeStop).toHaveBeenCalledTimes(1)
  })

  it('여러 번 종료해도 같은 정리 작업을 한 번만 수행한다', async () => {
    const processStop = vi.fn().mockResolvedValue(undefined)
    const bridgeStop = vi.fn().mockResolvedValue(undefined)
    const shell = new UnityAvatarShell(structuredClone(DEFAULT_CONFIG))
    attachParts(shell, { stop: processStop }, { stop: bridgeStop })

    const first = shell.stop()
    const second = shell.stop()
    expect(second).toBe(first)
    await expect(first).resolves.toBeUndefined()
    expect(processStop).toHaveBeenCalledTimes(1)
    expect(bridgeStop).toHaveBeenCalledTimes(1)
  })

  it('프로세스와 브리지 종료가 모두 실패하면 두 원인을 보존한다', async () => {
    const shell = new UnityAvatarShell(structuredClone(DEFAULT_CONFIG))
    attachParts(
      shell,
      { stop: vi.fn().mockRejectedValue(new Error('process stuck')) },
      { stop: vi.fn().mockRejectedValue(new Error('bridge stuck')) }
    )

    const failure = await shell.stop().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toHaveLength(2)
  })

  it('실패한 프로세스 핸들을 보존해 다음 종료에서 다시 시도한다', async () => {
    const processStop = vi
      .fn()
      .mockRejectedValueOnce(new Error('process stuck'))
      .mockResolvedValueOnce(undefined)
    const bridgeStop = vi.fn().mockResolvedValue(undefined)
    const shell = new UnityAvatarShell(structuredClone(DEFAULT_CONFIG))
    attachParts(shell, { stop: processStop }, { stop: bridgeStop })

    await expect(shell.stop()).rejects.toThrow('process stuck')
    await expect(shell.stop()).resolves.toBeUndefined()

    expect(processStop).toHaveBeenCalledTimes(2)
    // 성공이 확인된 브리지는 첫 시도 뒤 놓으므로 다시 닫지 않는다.
    expect(bridgeStop).toHaveBeenCalledTimes(1)
  })
})
