import { PcmChunker } from './pcmChunker'

// TypeScript의 DOM lib에는 AudioWorkletNode는 있지만 worklet 전역 선언은 빠져 있다.
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: AudioWorkletNodeOptions)
  abstract process(inputs: Float32Array[][]): boolean
}
declare function registerProcessor(
  name: string,
  processorCtor: new (options: AudioWorkletNodeOptions) => AudioWorkletProcessor
): void

interface RecorderProcessorOptions {
  maxSamples?: number
}

class PcmRecorderProcessor extends AudioWorkletProcessor {
  private readonly chunks: PcmChunker

  constructor(options: AudioWorkletNodeOptions) {
    super(options)
    const processorOptions = options.processorOptions as RecorderProcessorOptions | undefined
    const maxSamples = Math.max(1, Math.floor(processorOptions?.maxSamples ?? 1))
    this.chunks = new PcmChunker(maxSamples)
    this.port.onmessage = (event: MessageEvent<unknown>) => {
      if (!isFlushMessage(event.data)) return
      this.chunks.flush((chunk) => this.send(chunk))
      // MessagePort는 FIFO라 이 ACK보다 앞선 chunk가 renderer에 먼저 도착한다.
      this.port.postMessage({ type: 'flushed' })
    }
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0]
    if (input) this.chunks.push(input, (chunk) => this.send(chunk))
    return true
  }

  private send(chunk: Float32Array): void {
    this.port.postMessage({ type: 'chunk', samples: chunk.buffer }, [chunk.buffer])
  }
}

function isFlushMessage(value: unknown): value is { type: 'flush' } {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'flush'
}

registerProcessor('waifu-pcm-recorder', PcmRecorderProcessor)
