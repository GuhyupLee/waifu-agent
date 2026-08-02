import { afterEach, describe, expect, it, vi } from 'vitest'
import { Recorder } from '../src/renderer/avatar/recorder'
import type { RecorderEnvironment } from '../src/renderer/avatar/recorder'

interface Harness {
  environment: RecorderEnvironment
  stream: MediaStream
  trackStop: ReturnType<typeof vi.fn>
  node: AudioWorkletNode
  nodeDisconnect: ReturnType<typeof vi.fn>
  sourceConnect: ReturnType<typeof vi.fn>
  sourceDisconnect: ReturnType<typeof vi.fn>
  portClose: ReturnType<typeof vi.fn>
  loadWorklet: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}

function harness(
  options: {
    createContextError?: Error
    loadWorkletError?: Error
    sourceConnectError?: Error
    suspended?: boolean
    flushAck?: boolean
  } = {}
): Harness {
  const trackStop = vi.fn()
  const stream = { getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream
  const sourceConnect = vi.fn(() => {
    if (options.sourceConnectError) throw options.sourceConnectError
  })
  const sourceDisconnect = vi.fn()
  const nodeDisconnect = vi.fn()
  const portClose = vi.fn()
  const port = {
    onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
    postMessage: vi.fn((message: unknown) => {
      if (
        options.flushAck !== false &&
        typeof message === 'object' &&
        message !== null &&
        (message as { type?: unknown }).type === 'flush'
      ) {
        queueMicrotask(() => port.onmessage?.({ data: { type: 'flushed' } } as MessageEvent<unknown>))
      }
    }),
    close: portClose
  }
  const node = {
    port,
    onprocessorerror: null,
    connect: vi.fn(),
    disconnect: nodeDisconnect
  } as unknown as AudioWorkletNode
  const close = vi.fn(async () => undefined)
  const resume = vi.fn(async () => undefined)
  const ctx = {
    state: options.suspended ? 'suspended' : 'running',
    resume,
    createMediaStreamSource: vi.fn(() => ({ connect: sourceConnect, disconnect: sourceDisconnect })),
    createGain: vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() })),
    destination: {},
    close
  } as unknown as AudioContext
  const loadWorklet = vi.fn(async () => {
    if (options.loadWorkletError) throw options.loadWorkletError
  })

  const environment: RecorderEnvironment = {
    getUserMedia: vi.fn(async () => stream),
    createAudioContext: vi.fn(() => {
      if (options.createContextError) throw options.createContextError
      return ctx
    }),
    loadWorklet,
    createWorkletNode: vi.fn(() => node),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle)
  }

  return {
    environment,
    stream,
    trackStop,
    node,
    nodeDisconnect,
    sourceConnect,
    sourceDisconnect,
    portClose,
    loadWorklet,
    resume,
    close
  }
}

function feed(node: AudioWorkletNode, samples: Float32Array): void {
  const copy = samples.slice()
  node.port.onmessage?.({
    data: { type: 'chunk', samples: copy.buffer }
  } as MessageEvent<unknown>)
}

function sine(sampleCount: number, amplitude = 0.03): Float32Array {
  return Float32Array.from(
    { length: sampleCount },
    (_, i) => Math.sin((i / 16_000) * 2 * Math.PI * 220) * amplitude
  )
}

function quietSpeechLike(sampleCount: number): Float32Array {
  return Float32Array.from({ length: sampleCount }, (_, i) => {
    const envelope = 0.005 + 0.003 * (0.5 + 0.5 * Math.sin((i / 16_000) * 2 * Math.PI * 5))
    return Math.sin((i / 16_000) * 2 * Math.PI * 180) * envelope
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Recorder lifecycle', () => {
  it('AudioContext 생성이 실패하면 이미 얻은 마이크 트랙을 반납한다', async () => {
    const h = harness({ createContextError: new Error('context failed') })
    const recorder = new Recorder({}, h.environment)

    await expect(recorder.start()).rejects.toThrow('context failed')
    expect(h.trackStop).toHaveBeenCalledOnce()
    expect(recorder.recording).toBe(false)
  })

  it('오디오 노드 연결 중 실패해도 노드·컨텍스트·마이크를 모두 정리한다', async () => {
    const h = harness({ sourceConnectError: new Error('connect failed') })
    const recorder = new Recorder({}, h.environment)

    await expect(recorder.start()).rejects.toThrow('connect failed')
    expect(h.nodeDisconnect).toHaveBeenCalledOnce()
    expect(h.trackStop).toHaveBeenCalledOnce()
    expect(h.close).toHaveBeenCalledOnce()
    expect(recorder.recording).toBe(false)
  })

  it('worklet 모듈 로드가 실패하면 마이크와 AudioContext를 반납한다', async () => {
    const h = harness({ loadWorkletError: new Error('worklet failed') })
    const recorder = new Recorder({}, h.environment)

    await expect(recorder.start()).rejects.toThrow('worklet failed')
    expect(h.trackStop).toHaveBeenCalledOnce()
    expect(h.close).toHaveBeenCalledOnce()
    expect(recorder.recording).toBe(false)
  })

  it('suspended AudioContext는 녹음 시작 전에 resume한다', async () => {
    const h = harness({ suspended: true })
    const recorder = new Recorder({}, h.environment)

    await recorder.start()
    expect(h.resume).toHaveBeenCalledOnce()
    await recorder.stop()
  })

  it('마이크 권한을 기다리는 중 stop이 오면 시작 직후 바로 정리한다', async () => {
    const h = harness()
    let releaseStream: ((stream: MediaStream) => void) | undefined
    h.environment.getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          releaseStream = resolve
        })
    )
    const recorder = new Recorder({}, h.environment)

    const starting = recorder.start()
    const stopping = recorder.stop()
    releaseStream?.(h.stream)

    await starting
    expect(await stopping).toBeNull()
    expect(h.trackStop).toHaveBeenCalledOnce()
    expect(h.close).toHaveBeenCalledOnce()
    expect(recorder.recording).toBe(false)
  })

  it('최대 시간이 지나면 녹음을 자동 종료하고 WAV와 사유를 콜백으로 넘긴다', async () => {
    vi.useFakeTimers()
    const h = harness()
    const onAutoStop = vi.fn()
    const recorder = new Recorder({ maxDurationMs: 350, onAutoStop }, h.environment)
    await recorder.start()
    feed(h.node, sine(5_600))

    await vi.advanceTimersByTimeAsync(350)

    expect(onAutoStop).toHaveBeenCalledOnce()
    const wavBase64 = onAutoStop.mock.calls[0]?.[0] as string
    expect(onAutoStop.mock.calls[0]?.[1]).toBe('limit')
    expect(Buffer.from(wavBase64, 'base64').toString('ascii', 0, 4)).toBe('RIFF')
    expect(recorder.recording).toBe(false)
    expect(h.trackStop).toHaveBeenCalledOnce()
    expect(h.close).toHaveBeenCalledOnce()
  })

  it('타이머가 늦어져도 보관하는 PCM을 최대 시간 분량으로 제한한다', async () => {
    const h = harness()
    const recorder = new Recorder({ maxDurationMs: 300 }, h.environment)
    await recorder.start()
    feed(h.node, sine(8_192))

    const wavBase64 = await recorder.stop()
    const wav = Buffer.from(wavBase64 ?? '', 'base64')
    // 16kHz의 300ms = 4800 samples, 16-bit mono다.
    expect(wav.length).toBe(44 + 4_800 * 2)
  })

  it('동시에 들어온 stop 둘 중 하나만 녹음 WAV를 가져간다', async () => {
    const h = harness()
    const recorder = new Recorder({}, h.environment)
    await recorder.start()
    feed(h.node, sine(4_800))

    const [first, second] = await Promise.all([recorder.stop(), recorder.stop()])

    expect(typeof first).toBe('string')
    expect(second).toBeNull()
    expect(h.trackStop).toHaveBeenCalledOnce()
    expect(h.close).toHaveBeenCalledOnce()
  })

  it('worklet flush ACK가 유실돼도 250ms 뒤 자원을 정리한다', async () => {
    vi.useFakeTimers()
    const h = harness({ flushAck: false })
    const recorder = new Recorder({}, h.environment)
    await recorder.start()
    feed(h.node, sine(4_800))

    const stopping = recorder.stop()
    await vi.advanceTimersByTimeAsync(250)

    expect(await stopping).toEqual(expect.any(String))
    expect(h.portClose).toHaveBeenCalledOnce()
    expect(h.trackStop).toHaveBeenCalledOnce()
  })
})

describe('Recorder voice activity gate', () => {
  it.each([
    ['순수 무음', new Float32Array(16_000)],
    ['낮은 일정 잡음', sine(16_000, 0.001)],
    ['낮은 일정 톤', sine(16_000, 0.006)],
    ['DC offset', new Float32Array(16_000).fill(0.02)],
    [
      '짧은 클릭',
      Float32Array.from({ length: 16_000 }, (_, i) => (i >= 8_000 && i < 8_320 ? 0.3 : 0))
    ],
    ['300ms보다 짧은 큰 소리', sine(3_200, 0.2)]
  ])('%s는 Whisper로 보내지 않는다', async (_name, samples) => {
    const h = harness()
    const recorder = new Recorder({}, h.environment)
    await recorder.start()
    feed(h.node, samples)
    expect(await recorder.stop()).toBeNull()
  })

  it('무음 사이의 200ms 음성형 구간은 보존한다', async () => {
    const h = harness()
    const recorder = new Recorder({}, h.environment)
    await recorder.start()
    const samples = new Float32Array(16_000)
    samples.set(sine(3_200), 6_400)
    feed(h.node, samples)
    expect(await recorder.stop()).toEqual(expect.any(String))
  })

  it('처음부터 이어지는 300ms 음성형 구간도 보존한다', async () => {
    const h = harness()
    const recorder = new Recorder({}, h.environment)
    await recorder.start()
    feed(h.node, sine(4_800))
    expect(await recorder.stop()).toEqual(expect.any(String))
  })

  it('처음부터 이어지는 저감도 음성형 envelope도 보존한다', async () => {
    const h = harness()
    const recorder = new Recorder({}, h.environment)
    await recorder.start()
    feed(h.node, quietSpeechLike(8_000))
    expect(await recorder.stop()).toEqual(expect.any(String))
  })
})
