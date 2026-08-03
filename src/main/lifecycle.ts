/** 프로그램이 소유한 자식 서비스는 종료 확인이 실패하면 같은 핸들로 한 번 더 시도한다. */
export async function stopOwnedService(
  stop: () => Promise<void>,
  attempts = 2,
  onRetry?: (attempt: number, error: unknown) => void
): Promise<void> {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError('종료 시도 횟수는 1 이상의 정수여야 한다')
  }

  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await stop()
      return
    } catch (error) {
      lastError = error
      if (attempt < attempts) onRetry?.(attempt, error)
    }
  }

  throw lastError
}
