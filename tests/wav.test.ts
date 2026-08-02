import { describe, expect, it } from 'vitest'
import { wavDurationSec } from '../src/main/voice/tts'

/**
 * WAV 를 조립한다. `extraChunks` 로 fmt 와 data 사이에 다른 청크를 끼워 넣을 수 있다 —
 * 44바이트 고정 헤더를 가정한 코드가 깨지는 지점이다.
 */
function wav(opts: {
  sampleRate?: number
  channels?: number
  bits?: number
  dataBytes: number
  extraChunks?: { id: string; size: number }[]
}): Buffer {
  const sampleRate = opts.sampleRate ?? 24000
  const channels = opts.channels ?? 1
  const bits = opts.bits ?? 16
  const byteRate = (sampleRate * channels * bits) / 8

  const fmt = Buffer.alloc(8 + 16)
  fmt.write('fmt ', 0, 'ascii')
  fmt.writeUInt32LE(16, 4)
  fmt.writeUInt16LE(1, 8)
  fmt.writeUInt16LE(channels, 10)
  fmt.writeUInt32LE(sampleRate, 12)
  fmt.writeUInt32LE(byteRate, 16)
  fmt.writeUInt16LE((channels * bits) / 8, 20)
  fmt.writeUInt16LE(bits, 22)

  const extras = (opts.extraChunks ?? []).map((c) => {
    const pad = c.size % 2
    const b = Buffer.alloc(8 + c.size + pad)
    b.write(c.id, 0, 'ascii')
    b.writeUInt32LE(c.size, 4)
    return b
  })

  const data = Buffer.alloc(8 + opts.dataBytes)
  data.write('data', 0, 'ascii')
  data.writeUInt32LE(opts.dataBytes, 4)

  const body = Buffer.concat([fmt, ...extras, data])
  const header = Buffer.alloc(12)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(4 + body.length, 4)
  header.write('WAVE', 8, 'ascii')
  return Buffer.concat([header, body])
}

describe('wavDurationSec', () => {
  it('표준 WAV 의 길이를 읽는다', () => {
    // 24kHz 모노 16bit -> 초당 48000 바이트. 1초치.
    expect(wavDurationSec(wav({ dataBytes: 48000 }))).toBeCloseTo(1, 5)
  })

  it('fmt 와 data 사이에 LIST 청크가 껴 있어도 찾아낸다', () => {
    // 44바이트 고정 헤더를 가정하면 여기서 엉뚱한 값을 읽는다.
    const b = wav({ dataBytes: 24000, extraChunks: [{ id: 'LIST', size: 26 }] })
    expect(wavDurationSec(b)).toBeCloseTo(0.5, 5)
  })

  it('홀수 크기 청크의 패딩 1바이트를 건너뛴다', () => {
    const b = wav({ dataBytes: 48000, extraChunks: [{ id: 'LIST', size: 13 }] })
    expect(wavDurationSec(b)).toBeCloseTo(1, 5)
  })

  it('스테레오·48kHz 도 맞게 계산한다', () => {
    const b = wav({ sampleRate: 48000, channels: 2, dataBytes: 192000 })
    expect(wavDurationSec(b)).toBeCloseTo(1, 5)
  })

  it('WAV 가 아니면 null 을 돌려준다', () => {
    expect(wavDurationSec(Buffer.from('not a wav file at all'))).toBeNull()
  })

  it('잘린 버퍼에도 죽지 않는다', () => {
    const b = wav({ dataBytes: 48000 }).subarray(0, 20)
    expect(wavDurationSec(b)).toBeNull()
  })

  it('data 청크가 없으면 null 을 돌려준다', () => {
    const b = wav({ dataBytes: 0 })
    expect(wavDurationSec(b)).toBeNull()
  })
})
