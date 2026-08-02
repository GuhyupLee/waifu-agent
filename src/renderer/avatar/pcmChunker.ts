/** AudioWorklet의 128-sample 입력을 main thread로 보낼 만한 크기로 모은다. */
export class PcmChunker {
  private readonly buffer: Float32Array
  private length = 0
  private total = 0

  constructor(
    private readonly maxSamples: number,
    chunkSamples = 4096
  ) {
    this.buffer = new Float32Array(Math.max(1, chunkSamples))
  }

  push(input: Float32Array, emit: (chunk: Float32Array) => void): void {
    let offset = 0
    while (offset < input.length && this.total < this.maxSamples) {
      const count = Math.min(
        input.length - offset,
        this.buffer.length - this.length,
        this.maxSamples - this.total
      )
      this.buffer.set(input.subarray(offset, offset + count), this.length)
      this.length += count
      this.total += count
      offset += count

      if (this.length === this.buffer.length) this.emit(emit)
    }
  }

  /** stop 메시지에서 아직 4096개가 안 된 마지막 조각까지 보낸다. */
  flush(emit: (chunk: Float32Array) => void): void {
    if (this.length > 0) this.emit(emit)
  }

  private emit(emit: (chunk: Float32Array) => void): void {
    emit(this.buffer.slice(0, this.length))
    this.length = 0
  }
}
