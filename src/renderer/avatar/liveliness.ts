/**
 * 살아있어 보이게 하는 것들.
 *
 * 캐릭터가 인형처럼 보이는 이유는 대개 자세가 나빠서가 아니라 **움직임의 통계가
 * 사람과 다르기** 때문이다. 완전 주기의 사인, 균등분포 난수, 대칭 이징 —
 * 전부 자연에 없는 신호다. 여기 모인 것은 그 통계를 사람 쪽으로 옮기는 도구다.
 *
 * 전부 순수 함수/클래스로 두어 three.js 없이 테스트한다.
 */

// ─────────────────────── 스프링 ───────────────────────

/**
 * 속도를 가진 2차 스프링.
 *
 * 지수 감쇠(`damp`)에는 속도 상태가 없다. 목표가 갑자기 바뀌면 가속도가 무한대라
 * 관성도 오버슛도 만들 수 없다 — 늘 "부드럽게 미끄러지는" 느낌만 난다.
 * 사람 머리는 빠르게 돌면 살짝 지나쳤다 돌아온다. 그건 속도가 있어야 나온다.
 *
 * 적분은 음함수 오일러다. 명시적 오일러는 프레임이 튀면 발산하는데,
 * 창을 드래그하거나 절전에서 깨어나면 delta 가 실제로 튄다.
 */
export class Spring {
  velocity = 0

  /**
   * @param frequency 초당 진동수(Hz). 클수록 빨리 붙는다.
   * @param damping   1 이면 임계감쇠(오버슛 없음). 0.7 근처면 살짝 지나쳤다 돌아온다.
   */
  constructor(
    public value = 0,
    private frequency = 2.2,
    private damping = 0.78
  ) {}

  update(target: number, delta: number): number {
    if (delta <= 0) return this.value

    const omega = 2 * Math.PI * this.frequency
    const f = 1 + 2 * delta * this.damping * omega
    const oo = omega * omega
    const detInv = 1 / (f + delta * delta * oo)

    this.velocity = (this.velocity + delta * oo * (target - this.value)) * detInv
    this.value += delta * this.velocity
    return this.value
  }

  /** 절전 복귀처럼 시간이 크게 건너뛴 뒤에는 속도를 버리고 목표에 붙인다. */
  snap(value: number): void {
    this.value = value
    this.velocity = 0
  }
}

// ─────────────────────── 표류 노이즈 ───────────────────────

/**
 * 서로 나누어떨어지지 않는 사인의 합.
 *
 * `sin(t)` 하나면 주기가 눈에 보인다. 무리수 비율로 세 개를 겹치면 실질적으로
 * 반복되지 않으면서도 부드럽다. 진짜 펄린 노이즈를 넣을 만큼의 값이 아니다.
 *
 * @returns 대략 -1..1
 */
export function drift(t: number, seed = 0): number {
  return (
    (Math.sin(t * 0.71 + seed * 1.7) * 0.6 +
      Math.sin(t * 1.13 + seed * 3.1) * 0.3 +
      Math.sin(t * 2.39 + seed * 5.9) * 0.1) /
    0.85
  )
}

// ─────────────────────── 호흡 ───────────────────────

/**
 * 들숨보다 날숨이 길다.
 *
 * 안정 호흡의 들숨:날숨은 대략 4:6 이다. 사인파는 5:5 라서, 조용히 보고 있으면
 * "기계로 부풀리는" 느낌이 난다. 한쪽을 시간축에서 압축해 비대칭으로 만든다.
 *
 * @param phase 0..1 로 진행하는 호흡 위상
 * @returns 0(다 내쉼) .. 1(다 들이쉼)
 */
export function breathCurve(phase: number): number {
  const p = phase - Math.floor(phase)
  const INHALE = 0.4
  if (p < INHALE) {
    // 들숨은 짧고 빠르다.
    return 0.5 - 0.5 * Math.cos((p / INHALE) * Math.PI)
  }
  return 0.5 + 0.5 * Math.cos(((p - INHALE) / (1 - INHALE)) * Math.PI)
}

// ─────────────────────── 눈 깜빡임 ───────────────────────

export interface BlinkShape {
  /** 감는 데 걸리는 시간(초). 뜨는 것보다 훨씬 빠르다. */
  closeSec: number
  /** 완전히 감은 채로 머무는 시간(초). */
  holdSec: number
  /** 뜨는 데 걸리는 시간(초). */
  openSec: number
}

/**
 * 감는 건 빠르고 뜨는 건 느리다. 대칭 삼각형으로 만들면 눈이 아니라 셔터로 보인다.
 * 실측 문헌의 대략치(감기 ~70ms, 뜨기 ~150ms)를 따른다.
 */
export const DEFAULT_BLINK: BlinkShape = { closeSec: 0.07, holdSec: 0.02, openSec: 0.15 }

/**
 * 깜빡임 진행 시간 → 눈꺼풀 닫힘 정도.
 * @returns 0(뜬 눈) .. 1(감은 눈)
 */
export function blinkWeight(t: number, shape: BlinkShape = DEFAULT_BLINK): number {
  if (t <= 0) return 0
  if (t < shape.closeSec) {
    // 감을 때는 가속한다. 눈꺼풀은 근육이 아니라 이완으로 떨어진다.
    const p = t / shape.closeSec
    return p * p
  }
  const held = t - shape.closeSec
  if (held < shape.holdSec) return 1
  const opening = held - shape.holdSec
  if (opening >= shape.openSec) return 0
  // 뜰 때는 감속한다. 끝에서 천천히 멈춰야 눈꺼풀에 무게가 있어 보인다.
  const p = opening / shape.openSec
  return 1 - p * (2 - p)
}

export function blinkDuration(shape: BlinkShape = DEFAULT_BLINK): number {
  return shape.closeSec + shape.holdSec + shape.openSec
}

/**
 * 다음 깜빡임까지의 간격.
 *
 * 균등분포를 쓰면 "규칙적으로 깜빡인다" 는 인상이 남는다. 실제 간격은 지수분포에
 * 가깝다 — 대개 짧고 가끔 아주 길다. 평균은 분당 17회 기준 약 3.5초.
 */
export function nextBlinkInterval(random: number, meanSec = 3.5, minSec = 1.1): number {
  const u = Math.min(0.999999, Math.max(1e-6, random))
  return minSec + -Math.log(1 - u) * (meanSec - minSec)
}

/**
 * 깜빡임 스케줄러.
 *
 * 시간만으로 돌지 않는다. 큰 시선 이동은 깜빡임을 부르고(약 20%), 사람은 이따금
 * 두 번 연달아 깜빡인다. 이 두 가지가 "타이머로 깜빡인다" 는 인상을 지운다.
 */
export class BlinkModel {
  private remaining: number
  private elapsedInBlink = -1
  private queued = 0

  constructor(
    private readonly random: () => number = Math.random,
    private readonly shape: BlinkShape = DEFAULT_BLINK
  ) {
    this.remaining = nextBlinkInterval(this.random())
  }

  /** 큰 시선 이동이 일어났음을 알린다. 확률적으로 깜빡임을 앞당긴다. */
  onGazeShift(): void {
    if (this.elapsedInBlink >= 0) return
    if (this.random() < 0.2) this.remaining = 0
  }

  /** @returns 이번 프레임의 눈꺼풀 닫힘 정도 0..1 */
  update(delta: number): number {
    if (this.elapsedInBlink >= 0) {
      this.elapsedInBlink += delta
      if (this.elapsedInBlink >= blinkDuration(this.shape)) {
        this.elapsedInBlink = -1
        if (this.queued > 0) {
          this.queued -= 1
          // 연속 깜빡임은 간격이 짧다. 정상 간격을 다시 뽑으면 두 번처럼 안 보인다.
          this.remaining = 0.09 + this.random() * 0.12
        } else {
          this.remaining = nextBlinkInterval(this.random())
          // 이따금 두 번 연달아 깜빡인다.
          if (this.random() < 0.14) this.queued = 1
        }
        return 0
      }
      return blinkWeight(this.elapsedInBlink, this.shape)
    }

    this.remaining -= delta
    if (this.remaining > 0) return 0

    // 문턱을 넘고 남은 시간을 그대로 이어받는다. 0 부터 시작하면 프레임마다
    // 조금씩 늦어지고, 시선 이동으로 즉시 깜빡이라고 해도 한 프레임 비어 보인다.
    this.elapsedInBlink = Math.min(-this.remaining, blinkDuration(this.shape))
    return blinkWeight(this.elapsedInBlink, this.shape)
  }
}

// ─────────────────────── 사케이드 ───────────────────────

export interface Gaze {
  x: number
  y: number
}

export interface SaccadeResult extends Gaze {
  /** 이번 프레임에 도약이 시작됐다. 깜빡임 트리거로 쓴다. */
  jumped: boolean
}

/**
 * 눈은 미끄러지지 않는다.
 *
 * 커서를 부드럽게 lerp 로 따라가게 하면 사람 눈이 아니라 감시 카메라가 된다.
 * 실제 눈은 **고정(fixation) → 도약(saccade) → 고정** 을 반복한다. 도약은
 * 30~80ms 안에 끝나고, 그 사이 시각은 사실상 꺼져 있다.
 *
 * 도약 시간은 Carpenter 의 선형 근사를 쓴다: `23ms + 2.7ms × 진폭(도)`.
 * 고정 중에는 미세 표류가 있어 완전히 멈추지 않는다 — 멈추면 그림처럼 보인다.
 */
export class SaccadeModel {
  private current: Gaze = { x: 0, y: 0 }
  private from: Gaze = { x: 0, y: 0 }
  private to: Gaze = { x: 0, y: 0 }
  private t = 0
  private duration = 0
  private moving = false
  /** 목표가 움직인 뒤 반응까지의 지연. 즉시 따라가면 기계처럼 보인다. */
  private latency = 0
  private elapsed = 0

  constructor(
    private readonly random: () => number = Math.random,
    /** 정규화 좌표 1.0 을 몇 도로 볼지. 도약 시간 계산에만 쓴다. */
    private readonly degreesPerUnit = 30
  ) {}

  /**
   * @param target 정규화된 응시 목표(-1..1)
   */
  update(delta: number, target: Gaze): SaccadeResult {
    this.elapsed += delta
    let jumped = false

    if (this.moving) {
      this.t += delta
      const p = this.duration > 0 ? Math.min(1, this.t / this.duration) : 1
      // 도약은 거의 등속으로 끝난다. 양 끝만 살짝 둥글린다.
      const ease = p * p * (3 - 2 * p)
      this.current.x = this.from.x + (this.to.x - this.from.x) * ease
      this.current.y = this.from.y + (this.to.y - this.from.y) * ease
      if (p >= 1) this.moving = false
    } else {
      this.latency -= delta
      const dx = target.x - this.current.x
      const dy = target.y - this.current.y
      const dist = Math.hypot(dx, dy)

      // 이보다 작은 어긋남은 눈을 움직이지 않는다. 매 프레임 도약하면 떨림이 된다.
      const THRESHOLD = 0.05
      if (dist > THRESHOLD && this.latency <= 0) {
        this.from = { ...this.current }
        this.to = { ...target }
        const degrees = dist * this.degreesPerUnit
        this.duration = 0.023 + 0.0027 * degrees
        this.t = 0
        this.moving = true
        jumped = true
        // 다음 도약까지의 최소 간격. 사람은 초당 3~4회 이상 도약하지 않는다.
        this.latency = 0.12 + this.random() * 0.18
      }
    }

    // 고정 중에도 눈은 완전히 멈추지 않는다. 아주 작은 표류를 얹는다.
    const micro = this.moving ? 0 : 0.006
    return {
      x: this.current.x + drift(this.elapsed * 2.3, 11) * micro,
      y: this.current.y + drift(this.elapsed * 2.1, 29) * micro,
      jumped
    }
  }

  snap(target: Gaze): void {
    this.current = { ...target }
    this.moving = false
    this.latency = 0
  }
}

// ─────────────────────── 루프 티 없애기 ───────────────────────

/**
 * 같은 idle 클립을 매번 정확히 같은 속도·같은 위상으로 재생하면, 몇 번만 봐도
 * 루프라는 게 보인다. 속도를 몇 퍼센트 흔들고 시작 위상을 옮기면 같은 클립이
 * 매번 다르게 읽힌다.
 *
 * @param random 0..1
 */
export function loopVariation(random: number): { timeScale: number; phase: number } {
  const u = Math.min(0.999999, Math.max(0, random))
  return {
    // ±6% 를 넘기면 걷기 같은 클립에서 발이 미끄러지는 게 보인다.
    timeScale: 0.94 + u * 0.12,
    phase: u
  }
}
