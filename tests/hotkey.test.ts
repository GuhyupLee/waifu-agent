import { afterEach, describe, expect, it, vi } from 'vitest'
import { PushToTalkHotkey } from '../src/main/voice/hotkey'
import type { HotkeyVoiceConfig, ShortcutHost } from '../src/main/voice/hotkey'
import type { SttAvailability, SttConfig } from '../src/main/voice/stt'

// ─────────────────────── fake globalShortcut ───────────────────────

class FakeShortcut implements ShortcutHost {
  readonly registered = new Map<string, () => void>()
  readonly registerCalls: string[] = []
  readonly unregisterCalls: string[] = []
  /** 다음 register 가 false 를 준다 (다른 앱이 이미 쓰는 상황). */
  failNext = false
  /** 다음 register 가 throw 한다 (잘못된 accelerator 문법). */
  throwNext = false
  /** 다음 unregister 가 throw 한다 (이미 뺏긴 상황). */
  throwOnUnregister = false

  register(accelerator: string, callback: () => void): boolean {
    this.registerCalls.push(accelerator)
    if (this.throwNext) {
      this.throwNext = false
      throw new Error('invalid accelerator')
    }
    if (this.failNext) {
      this.failNext = false
      return false
    }
    this.registered.set(accelerator, callback)
    return true
  }

  unregister(accelerator: string): void {
    this.unregisterCalls.push(accelerator)
    if (this.throwOnUnregister) {
      this.throwOnUnregister = false
      throw new Error('not registered')
    }
    this.registered.delete(accelerator)
  }
}

const okStt = (): SttAvailability => ({ ok: true })
const badStt = (reason = '모델 없음'): SttAvailability => ({ ok: false, reason })

const voice = (over: Partial<HotkeyVoiceConfig> = {}): HotkeyVoiceConfig => ({
  enabled: true,
  sttHotkey: 'Alt+Space',
  stt: { whisperPath: 'w', modelPath: 'm', language: 'ko' } satisfies SttConfig,
  ...over
})

const noop = (): void => {}

afterEach(() => {
  vi.useRealTimers()
})

describe('PushToTalkHotkey — 설정에 맞춰 등록 상태를 유지한다', () => {
  it('가용하면 등록한다', () => {
    const s = new FakeShortcut()
    const h = new PushToTalkHotkey(s, noop, noop, okStt)
    h.sync(voice())
    expect(h.current).toBe('Alt+Space')
    expect(s.registered.has('Alt+Space')).toBe(true)
  })

  it('등록된 콜백이 onTrigger 로 이어진다', () => {
    const s = new FakeShortcut()
    let fired = 0
    const h = new PushToTalkHotkey(s, () => fired++, noop, okStt)
    h.sync(voice())
    s.registered.get('Alt+Space')!()
    expect(fired).toBe(1)
  })

  it('한 번 길게 눌러 들어온 자동 반복은 한 번만 토글한다', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const s = new FakeShortcut()
    let fired = 0
    const h = new PushToTalkHotkey(s, () => fired++, noop, okStt)
    h.sync(voice())
    const trigger = s.registered.get('Alt+Space')!

    trigger()
    // Windows 의 가장 긴 첫 repeat 지연과 느린 반복 간격에서도 한 번만 받아야 한다.
    vi.advanceTimersByTime(1_000)
    for (let i = 0; i < 8; i++) {
      trigger()
      vi.advanceTimersByTime(400)
    }
    expect(fired).toBe(1)

    // 키를 놓아 콜백이 잠잠해진 뒤 새 탭은 정상적으로 받아야 한다.
    vi.advanceTimersByTime(1_100)
    trigger()
    expect(fired).toBe(2)
  })

  it('첫 입력 직후의 짧은 중복 콜백도 무시한다', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const s = new FakeShortcut()
    let fired = 0
    const h = new PushToTalkHotkey(s, () => fired++, noop, okStt)
    h.sync(voice())
    const trigger = s.registered.get('Alt+Space')!

    trigger()
    vi.advanceTimersByTime(20)
    trigger()
    vi.advanceTimersByTime(20)
    trigger()
    expect(fired).toBe(1)
  })

  it('핫키가 바뀌면 이전 것을 풀고 새 것을 건다 (stale 없음)', () => {
    const s = new FakeShortcut()
    const h = new PushToTalkHotkey(s, noop, noop, okStt)
    h.sync(voice())
    h.sync(voice({ sttHotkey: 'Alt+X' }))
    expect(s.unregisterCalls).toContain('Alt+Space')
    expect(s.registered.has('Alt+Space')).toBe(false)
    expect(s.registered.has('Alt+X')).toBe(true)
    expect(h.current).toBe('Alt+X')
  })

  it('같은 설정으로 다시 sync 하면 재등록하지 않는다', () => {
    const s = new FakeShortcut()
    const h = new PushToTalkHotkey(s, noop, noop, okStt)
    h.sync(voice())
    const before = s.registerCalls.length
    h.sync(voice())
    expect(s.registerCalls.length).toBe(before)
    expect(h.current).toBe('Alt+Space')
  })

  it('STT 가 가용하지 않게 되면 기존 등록을 푼다', () => {
    const s = new FakeShortcut()
    let available = true
    const h = new PushToTalkHotkey(s, noop, noop, () => (available ? okStt() : badStt()))
    h.sync(voice())
    expect(h.current).toBe('Alt+Space')
    available = false
    h.sync(voice())
    expect(h.current).toBeNull()
    expect(s.registered.has('Alt+Space')).toBe(false)
    expect(s.unregisterCalls).toContain('Alt+Space')
  })

  it('voice 전체를 끄면 STT 경로가 있어도 기존 핫키를 푼다', () => {
    const s = new FakeShortcut()
    const h = new PushToTalkHotkey(s, noop, noop, okStt)
    h.sync(voice())
    h.sync(voice({ enabled: false }))
    expect(h.current).toBeNull()
    expect(s.registered.has('Alt+Space')).toBe(false)
  })

  it('경로가 없으면 애초에 등록하지 않는다', () => {
    const s = new FakeShortcut()
    const h = new PushToTalkHotkey(s, noop, noop, () => badStt())
    h.sync(voice())
    expect(h.current).toBeNull()
    expect(s.registerCalls).toEqual([])
  })

  it('빈 핫키 문자열이면 등록하지 않는다', () => {
    const s = new FakeShortcut()
    const h = new PushToTalkHotkey(s, noop, noop, okStt)
    h.sync(voice({ sttHotkey: '   ' }))
    expect(h.current).toBeNull()
    expect(s.registerCalls).toEqual([])
  })

  it('다른 앱과 충돌(register=false)하면 stale 로 기억하지 않는다', () => {
    const s = new FakeShortcut()
    s.failNext = true
    const h = new PushToTalkHotkey(s, noop, noop, okStt)
    h.sync(voice())
    expect(h.current).toBeNull()
    // 다음 sync 는 다시 시도해 회복한다.
    h.sync(voice())
    expect(h.current).toBe('Alt+Space')
  })

  it('잘못된 accelerator 로 register 가 throw 해도 예외를 삼키고 stale 이 없다', () => {
    const s = new FakeShortcut()
    s.throwNext = true
    const h = new PushToTalkHotkey(s, noop, noop, okStt)
    expect(() => h.sync(voice({ sttHotkey: 'NotAKey' }))).not.toThrow()
    expect(h.current).toBeNull()
  })

  it('이전 핫키의 unregister 가 throw 해도 새 핫키 등록까지 이어간다', () => {
    const s = new FakeShortcut()
    const h = new PushToTalkHotkey(s, noop, noop, okStt)
    h.sync(voice())
    s.throwOnUnregister = true
    expect(() => h.sync(voice({ sttHotkey: 'Alt+X' }))).not.toThrow()
    expect(h.current).toBe('Alt+X')
    expect(s.registered.has('Alt+X')).toBe(true)
  })

  it('release 는 등록을 푼다', () => {
    const s = new FakeShortcut()
    const h = new PushToTalkHotkey(s, noop, noop, okStt)
    h.sync(voice())
    h.release()
    expect(h.current).toBeNull()
    expect(s.registered.has('Alt+Space')).toBe(false)
  })
})
