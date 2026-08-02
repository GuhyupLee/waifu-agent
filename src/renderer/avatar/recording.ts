/** 녹음 장치와 비동기 시작/종료를 직렬화하는 데 필요한 최소 표면. */
export interface RecordingDevice {
  readonly recording: boolean
  start(): Promise<void>
  stop(): Promise<string | null>
}

export interface RecordingCallbacks {
  onRecording(on: boolean): void
  onRecorded(wavBase64: string | null): void
  onError(error: Error): void
}

/**
 * 빠르게 연속된 토글을 "마지막 입력이 이긴다"로 합친다.
 *
 * 마이크 권한 요청과 AudioContext 시작은 비동기다. on→off→on 같은 입력을 명령마다
 * 따로 await 하면 오래된 off 완료 이벤트가 마지막 on을 덮어쓴다. 이 조정자는 목표 상태만
 * 즉시 갱신하고 장치 상태가 그 목표와 같아질 때까지 한 루프에서 직렬로 맞춘다.
 */
export class RecordingCoordinator {
  private desired = false
  private running: Promise<void> | null = null

  constructor(
    private readonly device: RecordingDevice,
    private readonly callbacks: RecordingCallbacks
  ) {}

  get target(): boolean {
    return this.desired
  }

  request(on: boolean): void {
    this.desired = on
    this.ensureRunning()
  }

  /** Recorder의 자체 제한 시간으로 끝난 경우. 장치는 이미 정리된 상태다. */
  autoStopped(wavBase64: string | null): void {
    // 자동 stop이 인코딩되는 짧은 틈에 사용자가 새 on을 요청했으면 그 최신 의도를
    // 덮지 않는다. 새 start가 진행 중이거나 이미 끝났으면 이전 녹음만 넘긴다.
    const restarting = this.desired && (this.running !== null || this.device.recording)
    if (!restarting) {
      this.desired = false
      this.callbacks.onRecording(false)
    }
    this.callbacks.onRecorded(wavBase64)
  }

  /** 테스트와 종료 경계에서 현재 직렬화 루프가 잠잠해질 때까지 기다린다. */
  async settled(): Promise<void> {
    while (this.running) await this.running
  }

  private ensureRunning(): void {
    if (this.running) return

    const run = this.reconcile().catch((error: unknown) => {
      // 시작 실패면 실제 상태는 false다. 종료 실패처럼 장치가 살아 있으면 그 실제 상태를
      // 목표로 채택해 무한 재시도를 막는다.
      this.desired = this.device.recording
      this.callbacks.onRecording(this.device.recording)
      this.callbacks.onError(error instanceof Error ? error : new Error(String(error)))
    })
    this.running = run

    void run.finally(() => {
      if (this.running !== run) return
      this.running = null
      // 루프의 마지막 조건 검사와 새 request가 같은 microtask에 겹친 경우를 놓치지 않는다.
      if (this.device.recording !== this.desired) this.ensureRunning()
    })
  }

  private async reconcile(): Promise<void> {
    while (this.device.recording !== this.desired) {
      if (this.desired) {
        await this.device.start()
        // start를 기다리는 동안 최종 목표가 off로 바뀌었으면 stale true를 보내지 않는다.
        if (this.desired && this.device.recording) this.callbacks.onRecording(true)
        continue
      }

      const wavBase64 = await this.device.stop()
      this.callbacks.onRecorded(wavBase64)
      // stop을 기다리는 동안 다시 on이 됐다면 false 이벤트가 최신 on을 덮지 않게 숨기고
      // 다음 반복에서 즉시 새 녹음을 시작한다.
      if (!this.desired) this.callbacks.onRecording(false)
    }
  }
}
