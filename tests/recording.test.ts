import { describe, expect, it, vi } from 'vitest'
import { RecordingCoordinator } from '../src/renderer/avatar/recording'
import type { RecordingDevice } from '../src/renderer/avatar/recording'

function deferred<T = void>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

class FakeDevice implements RecordingDevice {
  recording = false
  starts = 0
  stops = 0
  startGate: Promise<void> | null = null
  stopGate: Promise<void> | null = null
  startError: Error | null = null

  async start(): Promise<void> {
    this.starts += 1
    if (this.startError) throw this.startError
    if (this.startGate) await this.startGate
    this.recording = true
  }

  async stop(): Promise<string | null> {
    this.stops += 1
    if (this.stopGate) await this.stopGate
    this.recording = false
    return 'wav'
  }
}

function setup(device = new FakeDevice()): {
  device: FakeDevice
  coordinator: RecordingCoordinator
  states: boolean[]
  recordings: Array<string | null>
  onError: ReturnType<typeof vi.fn>
} {
  const states: boolean[] = []
  const recordings: Array<string | null> = []
  const onError = vi.fn()
  const coordinator = new RecordingCoordinator(device, {
    onRecording: (on) => states.push(on),
    onRecorded: (wav) => recordings.push(wav),
    onError
  })
  return { device, coordinator, states, recordings, onError }
}

describe('RecordingCoordinator — 마지막 토글이 이긴다', () => {
  it('일반적인 시작과 종료를 직렬로 수행한다', async () => {
    const s = setup()
    s.coordinator.request(true)
    await s.coordinator.settled()
    s.coordinator.request(false)
    await s.coordinator.settled()

    expect(s.states).toEqual([true, false])
    expect(s.recordings).toEqual(['wav'])
    expect(s.device.recording).toBe(false)
  })

  it('start 대기 중 on→off면 stale true 없이 시작 직후 정리한다', async () => {
    const gate = deferred()
    const s = setup()
    s.device.startGate = gate.promise

    s.coordinator.request(true)
    s.coordinator.request(false)
    gate.resolve()
    await s.coordinator.settled()

    expect(s.states).toEqual([false])
    expect(s.device.starts).toBe(1)
    expect(s.device.stops).toBe(1)
    expect(s.device.recording).toBe(false)
  })

  it('start 대기 중 on→off→on이면 중간 off를 버리고 켠 상태로 끝낸다', async () => {
    const gate = deferred()
    const s = setup()
    s.device.startGate = gate.promise

    s.coordinator.request(true)
    s.coordinator.request(false)
    s.coordinator.request(true)
    gate.resolve()
    await s.coordinator.settled()

    expect(s.states).toEqual([true])
    expect(s.device.starts).toBe(1)
    expect(s.device.stops).toBe(0)
    expect(s.device.recording).toBe(true)
  })

  it('stop 대기 중 다시 on이면 stale false를 숨기고 새 녹음을 시작한다', async () => {
    const s = setup()
    s.coordinator.request(true)
    await s.coordinator.settled()

    const gate = deferred()
    s.device.stopGate = gate.promise
    s.coordinator.request(false)
    s.coordinator.request(true)
    gate.resolve()
    await s.coordinator.settled()

    expect(s.states).toEqual([true, true])
    expect(s.recordings).toEqual(['wav'])
    expect(s.device.starts).toBe(2)
    expect(s.device.recording).toBe(true)
  })

  it('시작 실패는 실제 off 상태와 오류를 한 번 보고한다', async () => {
    const s = setup()
    s.device.startError = new Error('permission denied')
    s.coordinator.request(true)
    await s.coordinator.settled()

    expect(s.states).toEqual([false])
    expect(s.coordinator.target).toBe(false)
    expect(s.onError).toHaveBeenCalledOnce()
  })

  it('Recorder 자체 제한 종료를 최종 off와 녹음 결과로 반영한다', () => {
    const s = setup()
    s.device.recording = false
    s.coordinator.autoStopped('limited-wav')
    expect(s.states).toEqual([false])
    expect(s.recordings).toEqual(['limited-wav'])
    expect(s.coordinator.target).toBe(false)
  })

  it('자동 종료 콜백보다 늦게 시작된 새 on 의도를 덮지 않는다', async () => {
    const s = setup()
    s.coordinator.request(true)
    await s.coordinator.settled()

    // Recorder가 기존 세션을 이미 멈췄지만 onAutoStop 콜백은 아직 오지 않은 짧은 구간.
    s.device.recording = false
    const gate = deferred()
    s.device.startGate = gate.promise
    s.coordinator.request(false)
    s.coordinator.request(true)
    s.coordinator.autoStopped('old-wav')

    expect(s.coordinator.target).toBe(true)
    expect(s.states).toEqual([true])
    expect(s.recordings).toEqual(['old-wav'])

    gate.resolve()
    await s.coordinator.settled()
    expect(s.device.recording).toBe(true)
    expect(s.coordinator.target).toBe(true)
  })
})
