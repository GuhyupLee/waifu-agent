/**
 * 자식 프로세스 stdout 의 청크 경계는 임의다. 한 줄이 두 청크에 걸쳐 도착하는 일이
 * 흔하고, 반대로 한 청크에 여러 줄이 들어오기도 한다. 청크를 그대로 JSON.parse 하면
 * 조용히 이벤트를 흘린다 — 스트리밍 파서에서 가장 흔한 버그다.
 *
 * 마지막 조각을 버퍼에 남겨 다음 청크와 이어 붙이고, 스트림이 끝날 때 flush() 로 회수한다.
 */
export class NdjsonReader {
  private buf = ''

  /** 청크를 밀어넣고 이번에 완성된 줄들만 돌려준다. 빈 줄은 버린다. */
  push(chunk: string): string[] {
    this.buf += chunk
    const parts = this.buf.split('\n')
    // 마지막 조각은 개행으로 끝나지 않았으므로 아직 미완성이다.
    this.buf = parts.pop() ?? ''
    return parts.map(stripCr).filter((l) => l.length > 0)
  }

  /**
   * 스트림 종료 시 호출한다. 마지막 줄이 개행 없이 끝났을 때 그 줄을 잃지 않기 위해 필요하다.
   * Claude Code 는 마지막 result 이벤트에 개행을 붙이지 않고 끝낼 수 있다.
   */
  flush(): string[] {
    const rest = stripCr(this.buf)
    this.buf = ''
    return rest.length > 0 ? [rest] : []
  }
}

/** Windows 파이프에서 CRLF 로 올 수 있다. */
function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1).trim() : line.trim()
}

/**
 * 줄을 JSON 으로 파싱한다. 실패한 줄은 스트림을 죽이지 않고 onError 로 보고하고 건너뛴다.
 * CLI 가 stdout 에 JSON 아닌 경고를 섞어 뱉는 경우가 있어서 관대해야 한다.
 */
export function parseLines(
  lines: readonly string[],
  onError?: (line: string, err: unknown) => void
): unknown[] {
  const out: unknown[] = []
  for (const line of lines) {
    try {
      out.push(JSON.parse(line))
    } catch (err) {
      onError?.(line, err)
    }
  }
  return out
}
