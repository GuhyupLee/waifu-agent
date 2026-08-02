/**
 * 푸시투토크 녹음.
 *
 * MediaRecorder 를 쓰지 않는 이유: 그쪽은 webm/opus 로 나오는데 whisper.cpp 는
 * 16kHz 모노 WAV 만 받는다. 변환하려면 ffmpeg 같은 걸 하나 더 끌어와야 한다.
 * AudioContext 의 sampleRate 를 16000 으로 강제하면 리샘플링 없이 바로 원하는 형식이 나온다.
 */
export class Recorder {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: ScriptProcessorNode | null = null
  private chunks: Float32Array[] = []

  private static readonly SAMPLE_RATE = 16000

  get recording(): boolean {
    return this.ctx !== null
  }

  async start(): Promise<void> {
    if (this.ctx) return
    this.chunks = []

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })

    // sampleRate 를 지정하면 브라우저가 리샘플링해서 준다. whisper 가 원하는 값에 바로 맞춘다.
    const ctx = new AudioContext({ sampleRate: Recorder.SAMPLE_RATE })
    this.ctx = ctx

    const source = ctx.createMediaStreamSource(this.stream)
    // ScriptProcessorNode 는 deprecated 지만 AudioWorklet 은 별도 모듈 파일과 번들 설정이
    // 필요하다. 몇 초짜리 푸시투토크에는 이쪽이 실용적이다.
    const node = ctx.createScriptProcessor(4096, 1, 1)
    this.node = node

    node.onaudioprocess = (e) => {
      // 이벤트의 버퍼는 재사용된다. 복사하지 않으면 나중에 전부 같은 내용이 된다.
      this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
    }

    source.connect(node)
    // 목적지에 연결하지 않으면 일부 환경에서 onaudioprocess 가 아예 불리지 않는다.
    // 게인 0 으로 이어서 소리는 새어 나가지 않게 한다.
    const mute = ctx.createGain()
    mute.gain.value = 0
    node.connect(mute)
    mute.connect(ctx.destination)
  }

  /** 녹음을 끝내고 base64 WAV 를 돌려준다. 소리가 없었으면 null. */
  async stop(): Promise<string | null> {
    const ctx = this.ctx
    this.ctx = null

    this.node?.disconnect()
    this.node = null
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = null
    if (ctx) await ctx.close()

    const total = this.chunks.reduce((n, c) => n + c.length, 0)
    if (total === 0) return null

    const pcm = new Float32Array(total)
    let off = 0
    for (const c of this.chunks) {
      pcm.set(c, off)
      off += c.length
    }
    this.chunks = []

    return encodeWavBase64(pcm, Recorder.SAMPLE_RATE)
  }
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
