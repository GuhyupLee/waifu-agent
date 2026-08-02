import { afterEach, describe, expect, it, vi } from 'vitest'
import { synthesize } from '../src/main/voice/tts'
import type { AudioQuery } from '../src/shared/lipsync'

const OPTIONS = {
  engineUrl: 'http://127.0.0.1:50021',
  speakerId: 0,
  speedScale: 1
}

const QUERY: AudioQuery = {
  accent_phrases: [],
  speedScale: 1,
  prePhonemeLength: 0.1,
  postPhonemeLength: 0.1
}

afterEach(() => {
  vi.useRealTimers()
})

describe('synthesize timeout boundaries', () => {
  it('audio_query 응답 본문이 멈춰도 제한 시간 뒤 종료하고 요청을 abort 한다', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const fetchImpl: typeof fetch = async (_input, init) => {
      signal = init?.signal as AbortSignal
      return {
        ok: true,
        status: 200,
        json: () => new Promise<never>(() => undefined)
      } as Response
    }

    const pending = synthesize('test', OPTIONS, {
      fetch: fetchImpl,
      queryTimeoutMs: 25,
      synthesisTimeoutMs: 50
    })
    const rejected = expect(pending).rejects.toThrow('audio_query 시간 초과 (25ms)')

    await vi.advanceTimersByTimeAsync(25)
    await rejected
    expect(signal?.aborted).toBe(true)
  })

  it('synthesis WAV 본문이 멈춰도 해당 단계의 제한 시간과 signal을 유지한다', async () => {
    vi.useFakeTimers()
    const signals: AbortSignal[] = []
    let calls = 0
    const fetchImpl: typeof fetch = async (_input, init) => {
      signals.push(init?.signal as AbortSignal)
      calls += 1
      if (calls === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => structuredClone(QUERY)
        } as Response
      }
      return {
        ok: true,
        status: 200,
        arrayBuffer: () => new Promise<never>(() => undefined)
      } as Response
    }

    const pending = synthesize('test', OPTIONS, {
      fetch: fetchImpl,
      queryTimeoutMs: 25,
      synthesisTimeoutMs: 40
    })
    const rejected = expect(pending).rejects.toThrow('synthesis 시간 초과 (40ms)')

    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(2)
    await vi.advanceTimersByTimeAsync(40)
    await rejected
    expect(signals[0]?.aborted).toBe(false)
    expect(signals[1]?.aborted).toBe(true)
  })
})
