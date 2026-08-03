/**
 * main은 첫 getConfig 응답 뒤 setImmediate로 누적 이벤트를 재생한다.
 * 구독보다 hydration을 먼저 시작하면 빠른 응답에서 그 재생을 통째로 잃을 수 있으므로,
 * 두 동작의 순서를 이 작은 경계에서 고정한다.
 */
export function subscribeBeforeHydrate(
  subscribe: () => () => void,
  hydrate: () => void
): () => void {
  const unsubscribe = subscribe()
  try {
    hydrate()
  } catch (error) {
    unsubscribe()
    throw error
  }
  return unsubscribe
}
