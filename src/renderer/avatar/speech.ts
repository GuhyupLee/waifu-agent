import type { SpeechAudio, Viseme, VisemeFrame } from '@shared/protocol'
import { sampleViseme } from '@shared/lipsync'

/** SpeechPlayer 가 다루는 오디오 엘리먼트의 최소 표면. 테스트에서 fake 로 갈아끼운다. */
export interface PlayableAudio {
  currentTime: number
  src: string
  play(): Promise<void>
  pause(): void
  addEventListener(
    type: 'ended' | 'error',
    listener: () => void,
    options?: { signal?: AbortSignal }
  ): void
}

/** 오디오 엘리먼트 생성과 object URL 수명을 감싼다. 브라우저 밖(테스트)에서 주입한다. */
export interface AudioEnv {
  createAudio(url: string): PlayableAudio
  createObjectUrl(blob: Blob): string
  revokeObjectUrl(url: string): void
}

const browserAudioEnv: AudioEnv = {
  createAudio: (url) => new Audio(url),
  createObjectUrl: (blob) => URL.createObjectURL(blob),
  revokeObjectUrl: (url) => URL.revokeObjectURL(url)
}

/**
 * 합성된 음성을 재생하면서 입모양을 맞춘다.
 *
 * 벽시계가 아니라 **오디오의 재생 위치(`currentTime`)** 를 기준으로 샘플링한다.
 * 그래야 디코딩 지연이나 예상 길이 오차가 있어도 입과 소리가 어긋나지 않는다.
 * 벽시계로 하면 재생이 조금만 늦게 시작해도 끝까지 어긋난 채로 간다.
 */
export class SpeechPlayer {
  private audio: PlayableAudio | null = null
  private frames: readonly VisemeFrame[] = []
  private objectUrl: string | null = null
  private onEnd: (() => void) | null = null
  /** 현재 발화의 listener 를 한 번에 떼기 위한 controller. */
  private controller: AbortController | null = null

  constructor(private readonly env: AudioEnv = browserAudioEnv) {}

  get speaking(): boolean {
    return this.audio !== null
  }

  /** 재생을 시작한다. 이전 발화가 남아 있으면 잘라낸다. */
  play(audio: SpeechAudio, visemes: VisemeFrame[], onEnd: () => void): void {
    this.stop()

    const bytes = Uint8Array.from(atob(audio.wavBase64), (c) => c.charCodeAt(0))
    // base64 를 data: URL 로 넘기면 긴 발화에서 URL 길이 제한에 걸린다. Blob 이 안전하다.
    const url = this.env.createObjectUrl(new Blob([bytes], { type: 'audio/wav' }))
    const el = this.env.createAudio(url)
    const controller = new AbortController()

    this.audio = el
    this.frames = visemes
    this.objectUrl = url
    this.onEnd = onEnd
    this.controller = controller

    // 콜백을 이 el 에 귀속시킨다. 이전 발화의 늦은 ended/error/play 거부가 새 발화를
    // 끝내버리는 race 를 막는다 — finish 는 el 이 아직 현재 발화일 때만 동작한다.
    el.addEventListener('ended', () => this.finish(el), { signal: controller.signal })
    el.addEventListener(
      'error',
      () => {
        console.warn('[voice] 재생 실패')
        this.finish(el)
      },
      { signal: controller.signal }
    )
    void el.play().catch((err: unknown) => {
      // 새 발화가 이미 이 el 을 교체했다면 pause/src 초기화 때문에 난 정상적인 stale 거부다.
      if (this.audio !== el) return
      console.warn('[voice] 재생 거부됨:', err)
      this.finish(el)
    })
  }

  /** 매 프레임 호출한다. 재생 중이 아니면 다문 입을 돌려준다. */
  sample(): { viseme: Viseme; weight: number } {
    if (!this.audio) return { viseme: 'sil', weight: 0 }
    return sampleViseme(this.frames, this.audio.currentTime)
  }

  stop(): void {
    const el = this.audio
    const controller = this.controller
    const url = this.objectUrl
    this.audio = null
    this.controller = null
    this.frames = []
    this.onEnd = null
    this.objectUrl = null

    // listener 를 먼저 뗀다. src='' 가 error 이벤트를 부를 수 있는데, 그게 stale finish 로
    // 흘러들지 못하게 하고 leak 도 막는다.
    controller?.abort()
    if (el) {
      el.pause()
      el.src = ''
    }
    if (url) {
      // 해제하지 않으면 발화마다 WAV 하나씩 메모리에 쌓인다.
      this.env.revokeObjectUrl(url)
    }
  }

  /**
   * el 의 재생이 끝났을 때 정리하고 콜백을 부른다.
   *
   * el 이 이미 현재 발화가 아니면(새 play 가 들어왔거나 stop 됐으면) 이 호출은 stale 이다.
   * 무시한다 — 아니면 이전 발화의 늦은 ended/error/play 거부가 새 발화의 onEnd 를 대신 부른다.
   */
  private finish(el: PlayableAudio): void {
    if (this.audio !== el) return
    const cb = this.onEnd
    this.stop()
    cb?.()
  }
}
