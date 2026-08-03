import { describe, expect, it, vi } from 'vitest'
import { subscribeBeforeHydrate } from '../src/renderer/panel/hydration'

describe('renderer hydration order', () => {
  it('이벤트 구독을 hydration 요청보다 먼저 완료한다', () => {
    const order: string[] = []
    const unsubscribe = vi.fn()

    const cleanup = subscribeBeforeHydrate(
      () => {
        order.push('subscribe')
        return unsubscribe
      },
      () => order.push('hydrate')
    )

    expect(order).toEqual(['subscribe', 'hydrate'])
    cleanup()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('hydration 시작이 동기적으로 실패하면 이미 붙인 listener를 정리한다', () => {
    const unsubscribe = vi.fn()

    expect(() =>
      subscribeBeforeHydrate(
        () => unsubscribe,
        () => {
          throw new Error('hydrate failed')
        }
      )
    ).toThrow('hydrate failed')
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
