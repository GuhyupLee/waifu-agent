import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, Display, Rectangle } from 'electron'
import { displayInDirection, roamTo } from '../src/main/roaming'

function fakeDisplay(id: number, x: number, y: number, width = 1920, height = 1080): Display {
  const bounds = { x, y, width, height }
  return { id, bounds, workArea: bounds } as Display
}

function fakeWindow(initial: Rectangle): {
  win: BrowserWindow
  bounds: Rectangle
  setBounds: ReturnType<typeof vi.fn>
  destroy(): void
} {
  let destroyed = false
  const state = { bounds: { ...initial } }
  const setBounds = vi.fn((next: Rectangle) => {
    state.bounds = { ...next }
  })
  const win = {
    getBounds: () => ({ ...state.bounds }),
    setBounds,
    isDestroyed: () => destroyed
  } as unknown as BrowserWindow
  return {
    win,
    get bounds() {
      return state.bounds
    },
    setBounds,
    destroy: () => {
      destroyed = true
    }
  }
}

const fixedDuration = {
  margin: 0,
  pixelsPerSecond: 100,
  minMs: 600,
  maxMs: 600,
  halfStepMs: 600
}

describe('multi-monitor direction selection', () => {
  it('keeps left/right movement on the same row in a 2x2 layout', () => {
    const topLeft = fakeDisplay(1, 0, 0)
    const bottomLeft = fakeDisplay(2, 0, 1080)
    const topRight = fakeDisplay(3, 1920, 0)
    const bottomRight = fakeDisplay(4, 1920, 1080)
    const displays = [topLeft, bottomLeft, topRight, bottomRight]

    expect(displayInDirection(displays, topRight, -1).id).toBe(topLeft.id)
    expect(displayInDirection(displays, topLeft, 1).id).toBe(topRight.id)
    expect(displayInDirection(displays, bottomRight, -1).id).toBe(bottomLeft.id)
  })

  it('returns the current display when there is no monitor in that direction', () => {
    const left = fakeDisplay(1, -1920, 0)
    const right = fakeDisplay(2, 0, 0)
    expect(displayInDirection([left, right], left, -1)).toBe(left)
    expect(displayInDirection([left, right], right, 1)).toBe(right)
  })
})

describe('roam lifecycle', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('arrives exactly once and snaps to the exact destination', async () => {
    const window = fakeWindow({ x: 0, y: 0, width: 420, height: 640 })
    const onStart = vi.fn()
    const onDone = vi.fn()
    const destination = { x: 100, y: 50, width: 420, height: 640 }

    const handle = roamTo(window.win, destination, { onStart, onDone }, fixedDuration)
    expect(onStart).toHaveBeenCalledWith(1)
    await vi.advanceTimersByTimeAsync(650)

    expect(window.bounds).toEqual(destination)
    expect(onDone).toHaveBeenCalledOnce()
    expect(onDone).toHaveBeenCalledWith('completed')
    handle.cancel()
    expect(onDone).toHaveBeenCalledOnce()
  })

  it('settles a cancelled move without snapping to its old destination', async () => {
    const window = fakeWindow({ x: 0, y: 0, width: 420, height: 640 })
    const onDone = vi.fn()
    const handle = roamTo(
      window.win,
      { x: 300, y: 0, width: 420, height: 640 },
      { onStart: vi.fn(), onDone },
      fixedDuration
    )

    await vi.advanceTimersByTimeAsync(160)
    const cancelledAt = window.bounds.x
    handle.cancel()
    await vi.advanceTimersByTimeAsync(1000)

    expect(window.bounds.x).toBe(cancelledAt)
    expect(window.bounds.x).not.toBe(300)
    expect(onDone).toHaveBeenCalledOnce()
    expect(onDone).toHaveBeenCalledWith('cancelled')
  })

  it('settles when the avatar window is destroyed mid-route', async () => {
    const window = fakeWindow({ x: 0, y: 0, width: 420, height: 640 })
    const onDone = vi.fn()
    roamTo(
      window.win,
      { x: 300, y: 0, width: 420, height: 640 },
      { onStart: vi.fn(), onDone },
      fixedDuration
    )

    window.destroy()
    await vi.advanceTimersByTimeAsync(20)

    expect(onDone).toHaveBeenCalledOnce()
    expect(onDone).toHaveBeenCalledWith('destroyed')
    expect(window.setBounds).not.toHaveBeenCalled()
  })

  it('lets an immediate cancellation win over queued same-position completion', async () => {
    const window = fakeWindow({ x: 10, y: 10, width: 420, height: 640 })
    const onDone = vi.fn()
    const handle = roamTo(
      window.win,
      { x: 10, y: 10, width: 420, height: 640 },
      { onStart: vi.fn(), onDone },
      fixedDuration
    )

    handle.cancel()
    await vi.runAllTimersAsync()

    expect(onDone).toHaveBeenCalledOnce()
    expect(onDone).toHaveBeenCalledWith('cancelled')
  })
})
