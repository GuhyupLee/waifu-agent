import { checkStt } from './stt'
import type { SttAvailability, SttConfig } from './stt'

/**
 * 푸시투토크 핫키를 설정에 맞춰 유지한다.
 *
 * 시작할 때 한 번 걸고 마는 게 아니다. voice 설정이 바뀔 때마다 sync() 를 부르면
 * 이전 accelerator 를 안전하게 풀고, STT 가용성을 다시 보고, 필요할 때만 다시 건다.
 * 빈 경로·경로 제거·핫키 변경·충돌·잘못된 accelerator 어디에서도 stale 핫키가 남거나
 * 예외가 새 나가지 않게 한다.
 */

/** Electron globalShortcut 에서 우리가 쓰는 부분만. 테스트에서 fake 로 갈아끼운다. */
export interface ShortcutHost {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

/** sync 가 보는 voice 설정의 부분집합. protocol 의 voice 를 그대로 넘겨도 맞는다. */
export interface HotkeyVoiceConfig {
  enabled: boolean
  sttHotkey: string
  stt: SttConfig
}

/**
 * Windows 의 RegisterHotKey 는 키 반복을 막는 MOD_NOREPEAT 를 쓰지 않으면 한 번 길게 누른
 * 동안에도 콜백을 여러 번 낸다. 첫 반복까지의 OS 지연보다 길게 막고, 반복이 시작된 뒤에는
 * 마지막 콜백에서 잠잠해질 때까지 재무장을 미룬다.
 */
const MIN_TRIGGER_GAP_MS = 1_100
const REPEAT_QUIET_MS = 600

export class PushToTalkHotkey {
  /** 지금 실제로 등록돼 있는 accelerator. 없으면 null. */
  private registered: string | null = null
  private armed = true
  private acceptedAt = Number.NEGATIVE_INFINITY
  private rearmTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly shortcut: ShortcutHost,
    /** 핫키가 눌렸을 때 할 일. 녹음 토글은 호출부가 안다. */
    private readonly onTrigger: () => void,
    private readonly log: (message: string) => void,
    /** STT 가용성 판정. 테스트에서 파일 존재 검사 대신 주입한다. */
    private readonly availability: (cfg: SttConfig) => SttAvailability = checkStt
  ) {}

  /** 관찰용. 지금 등록된 accelerator(없으면 null). */
  get current(): string | null {
    return this.registered
  }

  /**
   * voice 설정에 맞춰 등록 상태를 맞춘다.
   *
   * STT 를 못 쓰거나 핫키가 비어 있으면 "등록 안 함" 이 목표 상태다.
   * 목표와 현재가 같으면 손대지 않는다 — 같은 accelerator 를 풀었다 다시 걸면
   * 그 짧은 틈에 누른 키가 먹지 않는다.
   */
  sync(voice: HotkeyVoiceConfig): void {
    const avail = voice.enabled
      ? this.availability(voice.stt)
      : { ok: false as const, reason: '음성 기능이 꺼져 있다' }
    const desired = avail.ok ? voice.sttHotkey.trim() : ''

    if (this.registered === (desired || null)) return

    // 상태가 바뀌므로 이전 등록부터 확실히 뗀다. 안 그러면 stale 핫키가 남는다.
    this.release()

    if (!desired) {
      if (!avail.ok) this.log(`[voice] 음성 입력 꺼짐 — ${avail.reason}`)
      return
    }

    let ok = false
    try {
      ok = this.shortcut.register(desired, () => this.handleTrigger())
    } catch (err) {
      // 잘못된 accelerator 문자열은 register 가 throw 한다. registered 는 null 그대로 둔다.
      this.log(`[voice] 핫키 ${desired} 등록 실패 — ${(err as Error).message}`)
      return
    }

    if (ok) {
      this.registered = desired
      this.log(`[voice] 푸시투토크 핫키 ${desired} 등록됨 (토글)`)
    } else {
      // register 가 false 면 다른 앱이 이미 쓰는 것이다. stale 로 기억하지 않는다.
      this.log(`[voice] 핫키 ${desired} 등록 실패 — 다른 앱이 쓰고 있다`)
    }
  }

  /** 등록을 해제한다. 종료 시, 그리고 sync 가 상태를 바꾸기 전에 호출한다. */
  release(): void {
    this.resetRepeatGuard()
    if (!this.registered) return
    const acc = this.registered
    this.registered = null
    try {
      this.shortcut.unregister(acc)
    } catch {
      // 이미 풀렸거나 잘못된 상태여도 무시한다. 어차피 등록을 놓는 게 목적이다.
    }
  }

  private handleTrigger(): void {
    const now = Date.now()
    if (this.armed) {
      this.armed = false
      this.acceptedAt = now
      this.onTrigger()
    }

    // 단순 throttle 은 누르고 있는 동안 제한 시간이 지난 뒤 다시 토글한다. 매 반복마다
    // timer 를 뒤로 밀어 실제로 키 입력이 잠잠해진 다음에만 다음 탭을 받는다.
    if (this.rearmTimer !== null) clearTimeout(this.rearmTimer)
    const wait = Math.max(REPEAT_QUIET_MS, this.acceptedAt + MIN_TRIGGER_GAP_MS - now)
    this.rearmTimer = setTimeout(() => {
      this.rearmTimer = null
      this.armed = true
    }, wait)
  }

  private resetRepeatGuard(): void {
    if (this.rearmTimer !== null) clearTimeout(this.rearmTimer)
    this.rearmTimer = null
    this.armed = true
    this.acceptedAt = Number.NEGATIVE_INFINITY
  }
}
