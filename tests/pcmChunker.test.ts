import { describe, expect, it } from 'vitest'
import { PcmChunker } from '../src/renderer/avatar/pcmChunker'

describe('PcmChunker', () => {
  it('작은 AudioWorklet 입력을 4096 sample 조각으로 모은다', () => {
    const chunker = new PcmChunker(10_000)
    const emitted: Float32Array[] = []
    for (let i = 0; i < 32; i++) {
      chunker.push(new Float32Array(128).fill(i), (chunk) => emitted.push(chunk))
    }

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toHaveLength(4096)
    expect(emitted[0]?.[0]).toBe(0)
    expect(emitted[0]?.[4095]).toBe(31)
  })

  it('flush는 한 조각보다 짧은 마지막 PCM도 잃지 않는다', () => {
    const chunker = new PcmChunker(10_000)
    const emitted: Float32Array[] = []
    chunker.push(new Float32Array(128).fill(0.25), (chunk) => emitted.push(chunk))
    chunker.flush((chunk) => emitted.push(chunk))

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toHaveLength(128)
    expect(emitted[0]?.[127]).toBe(0.25)
  })

  it('타이머가 늦어도 maxSamples보다 많이 보관하지 않는다', () => {
    const chunker = new PcmChunker(300, 128)
    const emitted: Float32Array[] = []
    chunker.push(new Float32Array(1_000).fill(0.5), (chunk) => emitted.push(chunk))
    chunker.flush((chunk) => emitted.push(chunk))

    expect(emitted.reduce((sum, chunk) => sum + chunk.length, 0)).toBe(300)
  })
})
