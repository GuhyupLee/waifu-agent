import { describe, expect, it, vi } from 'vitest'
import { SpeechPlayer } from '../src/renderer/avatar/speech'
import type { AudioEnv, PlayableAudio } from '../src/renderer/avatar/speech'
import type { SpeechAudio } from '../src/shared/protocol'

// ─────────────────────── fake Audio / URL ───────────────────────

class FakeAudio implements PlayableAudio {
  currentTime = 0
  src = ''
  paused = false
  playCalls = 0
  aborted = false
  private resolvePlay: (() => void) | null = null
  private rejectPlay: ((err: unknown) => void) | null = null
  private readonly handlers = new Map<string, Set<() => void>>()

  play(): Promise<void> {
    this.playCalls++
    return new Promise<void>((resolve, reject) => {
      this.resolvePlay = resolve
      this.rejectPlay = reject
    })
  }

  pause(): void {
    this.paused = true
  }

  addEventListener(
    type: 'ended' | 'error',
    listener: () => void,
    options?: { signal?: AbortSignal }
  ): void {
    let set = this.handlers.get(type)
    if (!set) {
      set = new Set()
      this.handlers.set(type, set)
    }
    set.add(listener)
    // signal 로 등록을 풀 수 있어야 한다 — stop() 이 controller.abort() 로 leak 을 막는다.
    options?.signal?.addEventListener('abort', () => {
      set!.delete(listener)
      this.aborted = true
    })
  }

  // ── 테스트에서 브라우저 이벤트를 흉내낸다 ──
  fire(type: 'ended' | 'error'): void {
    for (const l of [...(this.handlers.get(type) ?? [])]) l()
  }
  settlePlay(): void {
    this.resolvePlay?.()
  }
  rejectPlayWith(err: unknown): void {
    this.rejectPlay?.(err)
  }
  listenerCount(type: 'ended' | 'error'): number {
    return this.handlers.get(type)?.size ?? 0
  }
}

class FakeEnv implements AudioEnv {
  readonly created: FakeAudio[] = []
  readonly createdUrls: string[] = []
  readonly revokedUrls: string[] = []
  private seq = 0

  createAudio(url: string): PlayableAudio {
    const a = new FakeAudio()
    a.src = url
    this.created.push(a)
    return a
  }
  createObjectUrl(_blob: Blob): string {
    const url = `blob:${this.seq++}`
    this.createdUrls.push(url)
    return url
  }
  revokeObjectUrl(url: string): void {
    this.revokedUrls.push(url)
  }
}

const audio = (): SpeechAudio => ({ wavBase64: btoa('wav'), durationSec: 1 })

describe('SpeechPlayer — 발화 하나의 콜백은 그 el 에만 귀속된다', () => {
  it('정상 재생이 끝나면 onEnd 를 한 번 부르고 정리한다', () => {
    const env = new FakeEnv()
    const player = new SpeechPlayer(env)
    let ended = 0
    player.play(audio(), [], () => ended++)

    const el = env.created[0]!
    el.settlePlay()
    el.fire('ended')

    expect(ended).toBe(1)
    expect(player.speaking).toBe(false)
    expect(env.revokedUrls).toEqual(env.createdUrls)
    expect(el.src).toBe('')
  })

  it('이전 발화의 늦은 ended 는 새 발화를 끝내지 않는다', () => {
    const env = new FakeEnv()
    const player = new SpeechPlayer(env)
    let first = 0
    let second = 0

    player.play(audio(), [], () => first++)
    const a = env.created[0]!
    // 아직 끝나기 전에 새 발화가 들어온다.
    player.play(audio(), [], () => second++)
    const b = env.created[1]!

    // 이전 audio 의 listener 는 stop() 에서 이미 떨어졌다 (leak 방지).
    expect(a.aborted).toBe(true)
    expect(a.listenerCount('ended')).toBe(0)

    // 그래도 늦게 ended 가 온다고 가정해 직접 쏴 본다 — 무시돼야 한다.
    a.fire('ended')
    expect(first).toBe(0)
    expect(second).toBe(0)
    expect(player.speaking).toBe(true)

    // 두 번째가 정상적으로 끝나면 그때만 onEnd 가 불린다.
    b.fire('ended')
    expect(second).toBe(1)
  })

  it('이전 발화의 늦은 play 거부는 새 발화를 끝내지 않는다', async () => {
    const env = new FakeEnv()
    const player = new SpeechPlayer(env)
    let first = 0
    let second = 0

    player.play(audio(), [], () => first++)
    const a = env.created[0]!
    player.play(audio(), [], () => second++)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    // 이전 audio 의 play() 가 이제야 거부된다 (autoplay 차단 등).
    a.rejectPlayWith(new Error('blocked'))
    await Promise.resolve()

    expect(first).toBe(0)
    expect(second).toBe(0)
    expect(player.speaking).toBe(true)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('error 이벤트도 한 번만 끝낸다', () => {
    const env = new FakeEnv()
    const player = new SpeechPlayer(env)
    let ended = 0
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    player.play(audio(), [], () => ended++)
    const el = env.created[0]!

    el.fire('error')
    el.fire('ended') // 이미 정리됐으므로 listener 가 없다 — 무시된다.

    expect(ended).toBe(1)
    expect(player.speaking).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('stop 은 object URL 을 해제하고 listener 를 뗀다', () => {
    const env = new FakeEnv()
    const player = new SpeechPlayer(env)
    player.play(audio(), [], () => {})
    const el = env.created[0]!
    expect(el.listenerCount('ended')).toBe(1)

    player.stop()

    expect(el.aborted).toBe(true)
    expect(el.listenerCount('ended')).toBe(0)
    expect(el.paused).toBe(true)
    expect(env.revokedUrls).toEqual(env.createdUrls)
  })
})
