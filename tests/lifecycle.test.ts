import { describe, expect, it, vi } from 'vitest'
import { stopOwnedService } from '../src/main/lifecycle'

describe('owned service shutdown', () => {
  it('첫 종료가 실패하면 같은 서비스에 다시 시도한다', async () => {
    const stop = vi
      .fn()
      .mockRejectedValueOnce(new Error('still running'))
      .mockResolvedValueOnce(undefined)
    const onRetry = vi.fn()

    await expect(stopOwnedService(stop, 2, onRetry)).resolves.toBeUndefined()
    expect(stop).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error))
  })

  it('모든 종료 시도가 실패하면 마지막 원인을 보존한다', async () => {
    const first = new Error('first')
    const last = new Error('last')
    const stop = vi.fn().mockRejectedValueOnce(first).mockRejectedValueOnce(last)

    await expect(stopOwnedService(stop, 2)).rejects.toBe(last)
  })

  it('잘못된 시도 횟수는 거절한다', async () => {
    await expect(stopOwnedService(vi.fn(), 0)).rejects.toThrow('1 이상의 정수')
  })
})
