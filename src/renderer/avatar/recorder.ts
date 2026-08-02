import recorderWorkletUrl from './pcm-recorder.worklet.ts?worker&url'

/**
 * 푸시투토크 녹음.
 *
 * MediaRecorder 를 쓰지 않는 이유: 그쪽은 webm/opus 로 나오는데 whisper.cpp 는
 * 16kHz 모노 WAV 만 받는다. 변환하려면 ffmpeg 같은 걸 하나 더 끌어와야 한다.
 * AudioContext 의 sampleRate 를 16000 으로 강제하면 리샘플링 없이 바로 원하는 형식이 나온다.
 */
export const MAX_RECORDING_MS = 120_000

export interface RecorderOptions {
  maxDurationMs?: number
  /** 제한 시간이나 processor 실패로 자동 종료된 녹음을 main 쪽으로 넘긴다. */
  onAutoStop?: (
    wavBase64: string | null,
    reason: 'limit' | 'processor-error'
  ) => void | Promise<void>
}

export interface RecorderEnvironment {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>
  createAudioContext(sampleRate: number): AudioContext
  loadWorklet(context: AudioContext, url: string): Promise<void>
  createWorkletNode(
    context: AudioContext,
    name: string,
    options: AudioWorkletNodeOptions
  ): AudioWorkletNode
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
  clearTimeout(handle: ReturnType<typeof setTimeout>): void
}

const DEFAULT_ENVIRONMENT: RecorderEnvironment = {
  getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
  createAudioContext: (sampleRate) => new AudioContext({ sampleRate }),
  loadWorklet: (context, url) => context.audioWorklet.addModule(url),
  createWorkletNode: (context, name, options) => new AudioWorkletNode(context, name, options),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle)
}

export class Recorder {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private node: AudioWorkletNode | null = null
  private mute: GainNode | null = null
  private chunks: Float32Array[] = []
  private sampleCount = 0
  private maxSamples = 0
  private acceptingSamples = false
  private flushPending: {
    resolve: () => void
    timer: ReturnType<typeof setTimeout>
  } | null = null
  private starting: Promise<void> | null = null
  private stopping: Promise<string | null> | null = null
  private autoStopTimer: ReturnType<typeof setTimeout> | null = null

  private static readonly SAMPLE_RATE = 16000

  constructor(
    private readonly options: RecorderOptions = {},
    private readonly environment: RecorderEnvironment = DEFAULT_ENVIRONMENT
  ) {}

  get recording(): boolean {
    return this.ctx !== null
  }

  async start(): Promise<void> {
    if (this.stopping) await this.stopping.catch(() => null)
    if (this.ctx) return
    if (this.starting) return await this.starting

    const pending = this.startInternal()
    this.starting = pending
    try {
      await pending
    } finally {
      if (this.starting === pending) this.starting = null
    }
  }

  private async startInternal(): Promise<void> {
    this.chunks = []
    this.sampleCount = 0
    this.maxSamples = Math.max(
      1,
      Math.floor(((this.options.maxDurationMs ?? MAX_RECORDING_MS) / 1000) * Recorder.SAMPLE_RATE)
    )
    this.acceptingSamples = false

    let stream: MediaStream | null = null
    let ctx: AudioContext | null = null
    let source: MediaStreamAudioSourceNode | null = null
    let node: AudioWorkletNode | null = null
    let mute: GainNode | null = null

    try {
      stream = await this.environment.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      })

      // sampleRate 를 지정하면 브라우저가 리샘플링해서 준다. whisper 가 원하는 값에 바로 맞춘다.
      ctx = this.environment.createAudioContext(Recorder.SAMPLE_RATE)
      await this.environment.loadWorklet(ctx, recorderWorkletUrl)
      source = ctx.createMediaStreamSource(stream)
      node = this.environment.createWorkletNode(ctx, 'waifu-pcm-recorder', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
        processorOptions: { maxSamples: this.maxSamples }
      })
      node.port.onmessage = (event: MessageEvent<unknown>) => this.handleWorkletMessage(event.data)
      node.onprocessorerror = () => this.handleProcessorError(node)
      source.connect(node)
      // 출력 graph가 살아 있어야 worklet의 process가 계속 호출된다. 게인 0으로 소리는 막는다.
      mute = ctx.createGain()
      mute.gain.value = 0
      node.connect(mute)
      mute.connect(ctx.destination)

      if (ctx.state === 'suspended') await ctx.resume()

      this.stream = stream
      this.ctx = ctx
      this.source = source
      this.node = node
      this.mute = mute
      this.acceptingSamples = true

      const maxDurationMs = this.options.maxDurationMs ?? MAX_RECORDING_MS
      this.autoStopTimer = this.environment.setTimeout(() => {
        this.autoStopTimer = null
        if (!this.ctx || this.stopping) return
        void this.stop()
          .then((wavBase64) => this.options.onAutoStop?.(wavBase64, 'limit'))
          .catch((error: unknown) => console.error('[voice] 녹음 자동 종료 실패:', error))
      }, maxDurationMs)
    } catch (error) {
      this.acceptingSamples = false
      try {
        source?.disconnect()
      } catch {
        // 생성 도중 graph 연결이 실패했을 수 있다.
      }
      try {
        node?.disconnect()
      } catch {
        // 이미 연결이 끊겼거나 생성 도중 실패한 노드는 무시한다.
      }
      try {
        mute?.disconnect()
      } catch {
        // 같은 cleanup 경로를 끝까지 진행한다.
      }
      node?.port.close()
      for (const track of stream?.getTracks() ?? []) track.stop()
      if (ctx) await ctx.close().catch(() => undefined)
      this.stream = null
      this.ctx = null
      this.source = null
      this.node = null
      this.mute = null
      this.chunks = []
      this.sampleCount = 0
      this.maxSamples = 0
      throw error
    }
  }

  private handleWorkletMessage(value: unknown): void {
    if (!isWorkletMessage(value)) return
    if (value.type === 'flushed') {
      this.finishFlush()
      return
    }
    if (!this.acceptingSamples) return

    const input = new Float32Array(value.samples)
    const remaining = this.maxSamples - this.sampleCount
    if (remaining <= 0 || input.length === 0) return
    const copy = input.slice(0, Math.min(input.length, remaining))
    this.chunks.push(copy)
    this.sampleCount += copy.length
  }

  private handleProcessorError(node: AudioWorkletNode | null): void {
    if (!node || this.node !== node || !this.ctx) return
    console.error('[voice] AudioWorklet 처리기가 중단됐다')
    void this.stop()
      .then((wavBase64) => this.options.onAutoStop?.(wavBase64, 'processor-error'))
      .catch((error: unknown) => console.error('[voice] 녹음 오류 정리 실패:', error))
  }

  private async flushWorklet(node: AudioWorkletNode): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = this.environment.setTimeout(() => this.finishFlush(), 250)
      this.flushPending = { resolve, timer }
      try {
        node.port.postMessage({ type: 'flush' })
      } catch {
        this.finishFlush()
      }
    })
  }

  private finishFlush(): void {
    const pending = this.flushPending
    if (!pending) return
    this.flushPending = null
    this.environment.clearTimeout(pending.timer)
    pending.resolve()
  }

  /** 녹음을 끝내고 base64 WAV 를 돌려준다. 소리가 없었으면 null. */
  async stop(): Promise<string | null> {
    // 자동 종료와 사용자 토글이 같은 순간 들어와도 PCM을 두 번 인코딩·전송하지 않는다.
    if (this.stopping) {
      await this.stopping.catch(() => null)
      return null
    }

    const pending = this.stopInternal()
    this.stopping = pending
    try {
      return await pending
    } finally {
      if (this.stopping === pending) this.stopping = null
    }
  }

  private async stopInternal(): Promise<string | null> {
    if (this.starting) {
      try {
        await this.starting
      } catch {
        return null
      }
    }

    const ctx = this.ctx
    this.ctx = null
    const source = this.source
    this.source = null
    const node = this.node
    const mute = this.mute

    if (this.autoStopTimer !== null) {
      this.environment.clearTimeout(this.autoStopTimer)
      this.autoStopTimer = null
    }

    // 새 입력을 먼저 끊은 뒤 worklet 안의 4096 미만 마지막 조각을 flush한다. 이 ACK가
    // ScriptProcessor 시절의 256ms 빈 구간을 없앤다.
    try {
      source?.disconnect()
    } catch {
      // 장치 제거와 동시에 끝난 경우에도 나머지 자원은 계속 정리한다.
    }
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = null
    if (node) await this.flushWorklet(node)
    this.acceptingSamples = false

    try {
      node?.disconnect()
    } catch {
      // 이미 graph가 끊겼어도 port와 context는 계속 닫는다.
    }
    try {
      mute?.disconnect()
    } catch {
      // cleanup은 멱등적으로 끝낸다.
    }
    if (node) {
      node.onprocessorerror = null
      node.port.onmessage = null
      node.port.close()
    }
    this.node = null
    this.mute = null
    if (ctx) await ctx.close().catch(() => undefined)

    const total = this.chunks.reduce((n, c) => n + c.length, 0)
    if (total === 0) {
      this.chunks = []
      this.sampleCount = 0
      this.maxSamples = 0
      return null
    }

    const pcm = new Float32Array(total)
    let off = 0
    for (const c of this.chunks) {
      pcm.set(c, off)
      off += c.length
    }
    this.chunks = []
    this.sampleCount = 0
    this.maxSamples = 0

    if (!hasVoiceActivity(pcm, Recorder.SAMPLE_RATE)) return null
    return encodeWavBase64(pcm, Recorder.SAMPLE_RATE)
  }
}

type WorkletMessage = { type: 'chunk'; samples: ArrayBuffer } | { type: 'flushed' }

function isWorkletMessage(value: unknown): value is WorkletMessage {
  if (typeof value !== 'object' || value === null) return false
  const message = value as { type?: unknown; samples?: unknown }
  if (message.type === 'flushed') return true
  return message.type === 'chunk' && message.samples instanceof ArrayBuffer
}

/**
 * Whisper에 보내기 전에 짧은 탭·무음·낮은 정상 잡음을 거른다.
 *
 * 20ms 프레임마다 DC offset을 뺀 RMS를 보고, 잡음 바닥보다 10dB 높은 구간이 사람 음성만큼
 * 이어졌는지 확인한다. 계속 말해 P20 자체가 높아지는 발화는 -40dBFS 강도 조건으로 살린다.
 */
export function hasVoiceActivity(pcm: Float32Array, sampleRate: number): boolean {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return false
  const frameSamples = Math.max(1, Math.round(sampleRate * 0.02))
  if (pcm.length < Math.round(sampleRate * 0.3)) return false

  const rms: number[] = []
  for (let offset = 0; offset + frameSamples <= pcm.length; offset += frameSamples) {
    let mean = 0
    for (let i = offset; i < offset + frameSamples; i++) mean += pcm[i] ?? 0
    mean /= frameSamples

    let squareSum = 0
    for (let i = offset; i < offset + frameSamples; i++) {
      const centered = (pcm[i] ?? 0) - mean
      squareSum += centered * centered
    }
    rms.push(Math.sqrt(squareSum / frameSamples))
  }
  if (rms.length === 0) return false

  const sorted = [...rms].sort((a, b) => a - b)
  const noiseFloor = sorted[Math.floor((sorted.length - 1) * 0.2)] ?? 0
  const upperLevel = sorted[Math.floor((sorted.length - 1) * 0.8)] ?? 0
  const activeThreshold = Math.max(10 ** (-50 / 20), noiseFloor * 10 ** (10 / 20))

  let activeFrames = 0
  let longestRun = 0
  let currentRun = 0
  let strongFrames = 0
  let quietFrames = 0
  for (const level of rms) {
    if (level >= activeThreshold) {
      activeFrames++
      currentRun++
      longestRun = Math.max(longestRun, currentRun)
    } else {
      currentRun = 0
    }
    if (level >= 0.01) strongFrames++
    if (level >= 10 ** (-49 / 20)) quietFrames++
  }

  // 저감도 마이크의 연속 발화는 P20도 함께 올라가 상대 문턱을 못 넘을 수 있다. 다만 일정한
  // 팬 소리까지 살리지 않도록 250ms 이상이고 프레임 envelope가 35% 이상 변할 때만 구제한다.
  const modulatedQuietSpeech =
    quietFrames >= 13 && upperLevel >= Math.max(10 ** (-47 / 20), noiseFloor * 1.35)

  return (activeFrames >= 6 && longestRun >= 3) || strongFrames >= 13 || modulatedQuietSpeech
}

/** Float32 PCM 을 16bit 모노 WAV 로 만든다. */
function encodeWavBase64(pcm: Float32Array, sampleRate: number): string {
  const bytesPerSample = 2
  const buffer = new ArrayBuffer(44 + pcm.length * bytesPerSample)
  const view = new DataView(buffer)

  const ascii = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }

  ascii(0, 'RIFF')
  view.setUint32(4, 36 + pcm.length * bytesPerSample, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // 모노
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * bytesPerSample, true) // byteRate
  view.setUint16(32, bytesPerSample, true) // blockAlign
  view.setUint16(34, 16, true) // bits
  ascii(36, 'data')
  view.setUint32(40, pcm.length * bytesPerSample, true)

  let p = 44
  for (const sample of pcm) {
    // 클리핑을 하지 않으면 큰 소리에서 값이 감싸돌아 지직거린다.
    const s = Math.max(-1, Math.min(1, sample))
    view.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    p += bytesPerSample
  }

  // 큰 배열을 String.fromCharCode 에 한 번에 넘기면 스택이 터진다. 조각내서 넘긴다.
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
