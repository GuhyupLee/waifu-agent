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
}

export const DEFAULT_ROAM: RoamOptions = {
  margin: 24,
  pixelsPerSecond: 900,
  minMs: 400,
  maxMs: 2600
}

/** 왼쪽부터 순서대로. 사용자가 말하는 "왼쪽 모니터" 와 일치시키려면 x 기준이어야 한다. */
export function orderedDisplays(): Display[] {
  return [...screen.getAllDisplays()].sort((a, b) => a.bounds.x - b.bounds.x)
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
  const here = currentDisplayIndex(win)

  switch (target.kind) {
    case 'left':
      return displays[Math.max(0, here - 1)] ?? null
    case 'right':
      return displays[Math.min(displays.length - 1, here + 1)] ?? null
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
    x: Math.round(wa.x + wa.width - size.width - margin),
    y: Math.round(wa.y + wa.height - size.height - margin),
    width: size.width,
    height: size.height
  }
}

/** 0..1 을 부드럽게. 출발과 도착에서 속도가 0 이라 걷는 느낌이 난다. */
export function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
}

export interface RoamHandle {
  cancel(): void
}

export interface RoamCallbacks {
  /** 이동 시작. 진행 방향을 준다 (-1 왼쪽, +1 오른쪽). */
  onStart(direction: -1 | 0 | 1): void
  onDone(): void
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
    callbacks.onDone()
    return { cancel: () => {} }
  }

  const duration = Math.min(
    options.maxMs,
    Math.max(options.minMs, (distance / options.pixelsPerSecond) * 1000)
  )
  const direction: -1 | 0 | 1 = dx > 1 ? 1 : dx < -1 ? -1 : 0
  callbacks.onStart(direction)

  const started = Date.now()
  let timer: NodeJS.Timeout | null = null

  const finish = (): void => {
    if (timer) clearInterval(timer)
    timer = null
    if (!win.isDestroyed()) win.setBounds(destination)
    callbacks.onDone()
  }

  // 60fps 로 옮긴다. setBounds 는 비싸지 않지만 그 이상은 눈에 차이가 없다.
  timer = setInterval(() => {
    if (win.isDestroyed()) {
      if (timer) clearInterval(timer)
      return
    }
    const t = Math.min(1, (Date.now() - started) / duration)
    const k = easeInOut(t)
    win.setBounds({
      x: Math.round(from.x + dx * k),
      y: Math.round(from.y + dy * k),
      width: destination.width,
      height: destination.height
    })
    if (t >= 1) finish()
  }, 16)

  return {
    cancel: () => {
      if (timer) clearInterval(timer)
      timer = null
    }
  }
}
