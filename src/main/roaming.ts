import { screen } from 'electron'
import type { BrowserWindow, Display, Rectangle } from 'electron'

/**
 * 아바타가 데스크탑을 돌아다니게 한다.
 *
 * 창을 순간이동시키면 "살아 있다" 는 느낌이 깨진다. 목적지까지 경로를 잡고
 * 이징을 걸어 옮기면서, 그 동안 이동 모션을 재생한다.
 */

export type RoamTarget =
  | { kind: 'left' }
  | { kind: 'right' }
  | { kind: 'display'; index: number }
  /** 커서가 있는 디스플레이로. "이리 와" 에 해당한다. */
  | { kind: 'cursor' }

export interface RoamOptions {
  /** 작업 영역 가장자리에서 띄울 간격. */
  margin: number
  /** 화면 폭 기준 이동 속도(초당). 화면이 넓어도 하염없이 걷지 않게 한다. */
  pixelsPerSecond: number
  /** 최소·최대 이동 시간. 너무 짧으면 순간이동처럼, 너무 길면 답답하다. */
  minMs: number
  maxMs: number
  /** walk의 한 발 간격. 이동 시간을 이 배수로 맞춰 도착 순간 발이 지면에 닿게 한다. */
  halfStepMs?: number
}

export const DEFAULT_ROAM: RoamOptions = {
  margin: 24,
  // 900px/s 는 다리보다 창이 먼저 미끄러져 보인다. 보통 크기 아바타가
  // 한 걸음에 이동하는 화면 거리와 1.2초 walk cycle을 맞춘 값이다.
  pixelsPerSecond: 460,
  minMs: 600,
  maxMs: 5400,
  halfStepMs: 600
}

/** 왼쪽부터, 같은 열에서는 위쪽부터. display 번호를 안정적으로 보여줄 때 쓴다. */
export function orderedDisplays(): Display[] {
  return [...screen.getAllDisplays()].sort(
    (a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y || String(a.id).localeCompare(String(b.id))
  )
}

function displayCenter(display: Display): { x: number; y: number } {
  return {
    x: display.bounds.x + display.bounds.width / 2,
    y: display.bounds.y + display.bounds.height / 2
  }
}

/**
 * 2x2 배치에서 배열 index±1을 쓰면 오른쪽 위에서 왼쪽 아래로 대각선 이동한다.
 * 실제 진행 방향 반평면 안의 후보만 고르고, 같은 높이의 가까운 화면을 우선한다.
 */
export function displayInDirection(
  displays: readonly Display[],
  current: Display,
  direction: -1 | 1
): Display {
  const from = displayCenter(current)
  const candidates = displays
    .filter((display) => display.id !== current.id)
    .map((display) => {
      const center = displayCenter(display)
      const dx = center.x - from.x
      const dy = center.y - from.y
      return { display, dx, score: Math.hypot(dx, dy * 1.5) }
    })
    .filter(({ dx }) => dx * direction > 1)
    .sort((a, b) => a.score - b.score)

  return candidates[0]?.display ?? current
}

/**
 * 커서가 아바타와 다른 화면에 있는지.
 *
 * 사용자가 있는 곳에 있는 게 가장 "살아 있는" 행동이라, 자율 이동의 가장 큰 근거다.
 */
export function cursorIsOnOtherDisplay(win: BrowserWindow): boolean {
  if (win.isDestroyed()) return false
  const b = win.getBounds()
  const here = screen.getDisplayNearestPoint({
    x: Math.round(b.x + b.width / 2),
    y: Math.round(b.y + b.height / 2)
  })
  const there = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  return here.id !== there.id
}

/** 창이 지금 어느 디스플레이에 있는지 (순서 인덱스). */
export function currentDisplayIndex(win: BrowserWindow): number {
  const b = win.getBounds()
  const center = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }
  const display = screen.getDisplayNearestPoint(center)
  return orderedDisplays().findIndex((d) => d.id === display.id)
}

/**
 * 목적지 디스플레이를 정한다.
 *
 * 끝에서 더 가려고 하면 반대편으로 넘어가지 않고 제자리에 둔다 —
 * 화면이 갑자기 반대편으로 튀면 어디로 갔는지 못 찾는다.
 */
export function resolveTarget(win: BrowserWindow, target: RoamTarget): Display | null {
  const displays = orderedDisplays()
  if (displays.length === 0) return null
  const bounds = win.getBounds()
  const center = {
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2)
  }
  const current = screen.getDisplayNearestPoint(center)

  switch (target.kind) {
    case 'left':
      return displayInDirection(displays, current, -1)
    case 'right':
      return displayInDirection(displays, current, 1)
    case 'display':
      return displays[target.index] ?? null
    case 'cursor':
      return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    default:
      return null
  }
}

/** 그 디스플레이 안에서 아바타가 설 자리. 오른쪽 아래에 둔다. */
export function restingSpot(display: Display, size: { width: number; height: number }, margin: number): Rectangle {
  const wa = display.workArea
  return {
    // 창보다 작은 작업 영역에서도 최소한 왼쪽 위 모서리는 화면 안에 남긴다.
    x: Math.round(Math.max(wa.x + margin, wa.x + wa.width - size.width - margin)),
    y: Math.round(Math.max(wa.y + margin, wa.y + wa.height - size.height - margin)),
    width: size.width,
    height: size.height
  }
}

/** 0..1 을 부드럽게. 출발과 도착에서 속도가 0 이라 걷는 느낌이 난다. */
export function easeInOut(t: number): number {
  const value = Math.max(0, Math.min(1, t))
  // 전 구간 smootherstep은 중앙 속도가 평균의 1.875배라 일정한 walk와 발이 크게 미끄러진다.
  // 양 끝 18%만 C2로 가감속하고 가운데는 등속으로 두면 접지 속도와 보폭이 오래 맞는다.
  const ramp = 0.18
  const cruiseVelocity = 1 / (1 - ramp)
  if (value < ramp) {
    const phase = value / ramp
    return cruiseVelocity * ramp * (phase ** 3 - phase ** 4 / 2)
  }
  if (value > 1 - ramp) {
    const phase = (1 - value) / ramp
    return 1 - cruiseVelocity * ramp * (phase ** 3 - phase ** 4 / 2)
  }
  return cruiseVelocity * (value - ramp / 2)
}

export type RoamEndReason = 'completed' | 'cancelled' | 'destroyed'

export interface RoamHandle {
  cancel(): void
}

export interface RoamCallbacks {
  /** 이동 시작. 진행 방향을 준다 (-1 왼쪽, +1 오른쪽). */
  onStart(direction: -1 | 0 | 1): void
  /** 정상 도착·취소·창 파괴 중 어느 경로든 정확히 한 번 호출한다. */
  onDone(reason: RoamEndReason): void
}

/**
 * 창을 목적지까지 옮긴다. 이미 이동 중이면 이전 이동을 취소하고 새로 시작한다.
 *
 * 거리에 비례해 시간을 잡되 상·하한을 둔다. 옆 모니터로 한 뼘 가는 것과
 * 4K 세 대를 가로지르는 것이 같은 시간이면 둘 다 어색하다.
 */
export function roamTo(
  win: BrowserWindow,
  destination: Rectangle,
  callbacks: RoamCallbacks,
  options: RoamOptions = DEFAULT_ROAM
): RoamHandle {
  const from = win.getBounds()
  const dx = destination.x - from.x
  const dy = destination.y - from.y
  const distance = Math.hypot(dx, dy)

  if (distance < 2) {
    let settled = false
    const finish = (reason: RoamEndReason): void => {
      if (settled) return
      settled = true
      callbacks.onDone(reason)
    }
    // 호출자가 handle을 저장한 뒤 종결 이벤트를 받게 해 동기 완료 race를 피한다.
    queueMicrotask(() => finish('completed'))
    return { cancel: () => finish('cancelled') }
  }

  const rawDuration = Math.min(
    options.maxMs,
    Math.max(options.minMs, (distance / options.pixelsPerSecond) * 1000)
  )
  const duration = options.halfStepMs
    ? Math.min(
        options.maxMs,
        Math.max(options.minMs, Math.round(rawDuration / options.halfStepMs) * options.halfStepMs)
      )
    : rawDuration
  const direction: -1 | 0 | 1 = dx > 1 ? 1 : dx < -1 ? -1 : 0
  callbacks.onStart(direction)

  const started = performance.now()
  let timer: NodeJS.Timeout | null = null
  let settled = false

  const finish = (reason: RoamEndReason, snapToDestination: boolean): void => {
    if (settled) return
    settled = true
    if (timer) clearInterval(timer)
    timer = null
    if (snapToDestination && !win.isDestroyed()) win.setBounds(destination)
    callbacks.onDone(reason)
  }

  // 60fps 로 옮긴다. setBounds 는 비싸지 않지만 그 이상은 눈에 차이가 없다.
  timer = setInterval(() => {
    if (win.isDestroyed()) {
      finish('destroyed', false)
      return
    }
    const t = Math.min(1, (performance.now() - started) / duration)
    const k = easeInOut(t)
    win.setBounds({
      x: Math.round(from.x + dx * k),
      y: Math.round(from.y + dy * k),
      width: destination.width,
      height: destination.height
    })
    if (t >= 1) finish('completed', true)
  }, 16)

  return {
    cancel: () => finish('cancelled', false)
  }
}
