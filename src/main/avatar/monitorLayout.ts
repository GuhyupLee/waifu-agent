import type { WaifuConfig } from '@shared/protocol'

/**
 * 모니터마다 아바타 위치와 배율을 따로 기억한다.
 *
 * 노트북을 외부 모니터에 붙였다 뗐다 하면 해상도와 배치가 바뀐다. 위치를 하나만
 * 기억하면 그때마다 아바타가 엉뚱한 자리에 뜨거나 **화면 밖으로 나간다** —
 * 투명하고 클릭이 통과하는 창이라 화면 밖으로 나가면 되찾을 방법이 없다.
 *
 * Electron 을 import 하지 않는다. `screen` 모듈을 끌어오면 테스트에서 Electron 런타임이
 * 필요해진다. 필요한 것은 사각형 몇 개뿐이라 호출자가 넘긴다.
 */

export interface MonitorInfo {
  bounds: { x: number; y: number; width: number; height: number }
  scaleFactor: number
}

export interface AvatarPlacement {
  anchor: { x: number; y: number }
  scale: number
}

/**
 * 모니터 식별자.
 *
 * Electron 의 `Display.id` 는 **세션을 넘어 안정적이지 않다** — 재부팅하면 바뀐다.
 * 그래서 기하로 만든다. 같은 크기 모니터가 둘이어도 위치가 달라 구분된다.
 *
 * 배치를 바꾸면 키도 바뀌는데, 그건 의도한 동작이다. 모니터를 옮겨 배치했으면
 * 예전 좌표는 더 이상 안전한 목적지가 아니다.
 */
export function monitorKey(monitor: MonitorInfo): string {
  const { x, y, width, height } = monitor.bounds
  // scaleFactor 까지 넣는다. 같은 자리 같은 크기라도 DPI 가 바뀌면 체감 크기가 달라진다.
  return `${width}x${height}+${x}+${y}@${monitor.scaleFactor}`
}

/** 저장된 배치. 없으면 전역 기본값으로 떨어진다. */
export function placementFor(config: WaifuConfig, monitor: MonitorInfo): AvatarPlacement {
  const fallback: AvatarPlacement = {
    anchor: { ...config.avatar.anchor },
    scale: config.avatar.scale
  }
  if (!config.avatar.rememberPerMonitor) return fallback

  const saved = config.avatar.perMonitor[monitorKey(monitor)]
  if (!saved) return fallback

  // 저장된 값이라도 믿지 않는다. 손으로 고친 설정 파일이 들어올 수 있고,
  // 범위를 벗어난 앵커는 아바타를 화면 밖에 놓는다.
  return {
    anchor: {
      x: clamp01(saved.anchor?.x ?? fallback.anchor.x),
      y: clamp01(saved.anchor?.y ?? fallback.anchor.y)
    },
    scale: clampScale(saved.scale ?? fallback.scale)
  }
}

/**
 * 배치를 기록한 새 perMonitor 맵. **원본을 바꾸지 않는다** —
 * 설정 저장은 호출자가 한 곳에서 하도록 남긴다.
 */
export function withPlacement(
  config: WaifuConfig,
  monitor: MonitorInfo,
  placement: AvatarPlacement
): WaifuConfig['avatar']['perMonitor'] {
  return {
    ...config.avatar.perMonitor,
    [monitorKey(monitor)]: {
      anchor: { x: clamp01(placement.anchor.x), y: clamp01(placement.anchor.y) },
      scale: clampScale(placement.scale)
    }
  }
}

/**
 * 창 중심이 어느 모니터에 있는지.
 *
 * 겹치는 넓이가 아니라 중심으로 판정한다 — 위치를 **저장할 때** 쓰는 함수라
 * "이 아바타는 어느 모니터의 것인가" 를 하나로 정해야 하기 때문이다.
 * 어디에도 안 걸리면 null 이고, 그때는 저장하지 않는다.
 */
export function monitorAt(
  point: { x: number; y: number },
  monitors: MonitorInfo[]
): MonitorInfo | null {
  for (const monitor of monitors) {
    const { x, y, width, height } = monitor.bounds
    if (point.x >= x && point.x < x + width && point.y >= y && point.y < y + height) {
      return monitor
    }
  }
  return null
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** 배율 상한이 없으면 화면을 덮는 아바타가 만들어지고, 하한이 없으면 사라진다. */
function clampScale(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1
  return Math.min(4, Math.max(0.2, value))
}
