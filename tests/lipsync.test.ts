import { describe, expect, it } from 'vitest'
import { buildVisemeTrack, sampleViseme } from '../src/shared/lipsync'
import type { AudioQuery, Mora } from '../src/shared/lipsync'

/** VOICEVOX 의 mora 는 자음이 없을 수 있다. 그 경우 두 필드가 아예 null 로 온다. */
const mora = (vowel: string, vowelLen: number, consonantLen?: number): Mora => ({
  text: vowel,
  consonant: consonantLen == null ? null : 'k',
  consonant_length: consonantLen ?? null,
  vowel,
  vowel_length: vowelLen,
  pitch: 5.5
})

const query = (over: Partial<AudioQuery> = {}): AudioQuery => ({
  accent_phrases: [{ moras: [mora('a', 0.1), mora('i', 0.1)], accent: 1 }],
  speedScale: 1,
  prePhonemeLength: 0.1,
  postPhonemeLength: 0.1,
  ...over
})

describe('buildVisemeTrack', () => {
  it('앞쪽 무음만큼 입을 늦게 연다', () => {
    const { frames } = buildVisemeTrack(query())
    // prePhonemeLength 0.1 을 빼먹으면 입이 소리보다 먼저 움직인다.
    expect(frames[0]!.t).toBeCloseTo(0.1, 5)
    expect(frames[0]!.viseme).toBe('aa')
  })

  it('자음 길이만큼 모음 시작을 뒤로 민다', () => {
    const { frames } = buildVisemeTrack(
      query({ accent_phrases: [{ moras: [mora('a', 0.1, 0.05)], accent: 1 }] })
    )
    expect(frames[0]!.t).toBeCloseTo(0.15, 5)
  })

  it('consonant_length 가 null 이어도 0 으로 다룬다', () => {
    // null 을 그대로 더하면 NaN 이 되어 트랙 전체가 망가진다.
    const { frames, estimatedDurationSec } = buildVisemeTrack(query())
    expect(frames.every((f) => Number.isFinite(f.t))).toBe(true)
    expect(Number.isFinite(estimatedDurationSec)).toBe(true)
  })

  it('speedScale 로 모든 시간을 나눈다', () => {
    const slow = buildVisemeTrack(query())
    const fast = buildVisemeTrack(query({ speedScale: 2 }))
    expect(fast.estimatedDurationSec).toBeCloseTo(slow.estimatedDurationSec / 2, 5)
    expect(fast.frames[0]!.t).toBeCloseTo(slow.frames[0]!.t / 2, 5)
  })

  it('speedScale 이 0 이어도 무한대를 만들지 않는다', () => {
    const { estimatedDurationSec } = buildVisemeTrack(query({ speedScale: 0 }))
    expect(Number.isFinite(estimatedDurationSec)).toBe(true)
  })

  it('일본어 모음을 VRM 입모양으로 옮긴다', () => {
    const { frames } = buildVisemeTrack(
      query({
        accent_phrases: [
          {
            moras: [mora('a', 0.1), mora('i', 0.1), mora('u', 0.1), mora('e', 0.1), mora('o', 0.1)],
            accent: 1
          }
        ]
      })
    )
    expect(frames.slice(0, 5).map((f) => f.viseme)).toEqual(['aa', 'ih', 'ou', 'ee', 'oh'])
  })

  it("발음되지 않는 N·cl 은 입을 다문 상태로 둔다", () => {
    const { frames } = buildVisemeTrack(
      query({ accent_phrases: [{ moras: [mora('a', 0.1), mora('N', 0.08)], accent: 1 }] })
    )
    const n = frames.find((f) => f.t > 0.1 && f.viseme === 'sil')
    expect(n).toBeDefined()
    expect(n!.weight).toBe(0)
  })

  it('구절 사이 pause_mora 동안 입을 다문다', () => {
    const { estimatedDurationSec } = buildVisemeTrack(
      query({
        accent_phrases: [
          { moras: [mora('a', 0.1)], accent: 1, pause_mora: mora('pau', 0.3) },
          { moras: [mora('i', 0.1)], accent: 1 }
        ]
      })
    )
    // 0.1(pre) + 0.1(a) + 0.3(pause) + 0.1(i) + 0.1(post)
    expect(estimatedDurationSec).toBeCloseTo(0.7, 5)
  })

  it('말이 끝나면 입을 다물어 마지막 모음으로 굳지 않게 한다', () => {
    const { frames } = buildVisemeTrack(query())
    expect(frames[frames.length - 1]!.viseme).toBe('sil')
    expect(frames[frames.length - 1]!.weight).toBe(0)
  })

  it('짧은 모음은 입을 덜 벌린다', () => {
    const short = buildVisemeTrack(query({ accent_phrases: [{ moras: [mora('a', 0.02)], accent: 1 }] }))
    const long = buildVisemeTrack(query({ accent_phrases: [{ moras: [mora('a', 0.2)], accent: 1 }] }))
    expect(short.frames[0]!.weight).toBeLessThan(long.frames[0]!.weight)
    expect(long.frames[0]!.weight).toBe(1)
    // 아무리 짧아도 최소한은 벌린다. 0 이면 말하는데 입이 안 움직인다.
    expect(short.frames[0]!.weight).toBeGreaterThan(0.3)
  })
})

describe('sampleViseme', () => {
  const frames = buildVisemeTrack(query()).frames

  it('트랙이 비면 다문 입을 돌려준다', () => {
    expect(sampleViseme([], 0.5)).toEqual({ viseme: 'sil', weight: 0 })
  })

  it('첫 키프레임 이전에는 입을 열지 않는다', () => {
    expect(sampleViseme(frames, 0).weight).toBe(0)
  })

  it('키프레임 시각에 그 입모양을 낸다', () => {
    expect(sampleViseme(frames, 0.1).viseme).toBe('aa')
  })

  it('트랙 끝을 넘어가도 마지막 상태를 유지한다', () => {
    const end = sampleViseme(frames, 999)
    expect(end.viseme).toBe('sil')
    expect(end.weight).toBe(0)
  })

  it('가중치가 항상 0..1 범위에 있다', () => {
    for (let t = 0; t < 1; t += 0.005) {
      const s = sampleViseme(frames, t)
      expect(s.weight).toBeGreaterThanOrEqual(0)
      expect(s.weight).toBeLessThanOrEqual(1)
    }
  })
})
