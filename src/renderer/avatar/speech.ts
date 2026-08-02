import type { SpeechAudio, Viseme, VisemeFrame } from '@shared/protocol'
import { sampleViseme } from '@shared/lipsync'

/**
 * 합성된 음성을 재생하면서 입모양을 맞춘다.
 *
 * 벽시계가 아니라 **오디오의 재생 위치(`currentTime`)** 를 기준으로 샘플링한다.
 * 그래야 디코딩 지연이나 예상 길이 오차가 있어도 입과 소리가 어긋나지 않는다.
 * 벽시계로 하면 재생이 조금만 늦게 시작해도 끝까지 어긋난 채로 간다.
 */
export class SpeechPlayer {
  private audio: HTMLAudioElement | null = null
  private frames: readonly VisemeFrame[] = []
  private objectUrl: string | null = null
  private onEnd: (() => void) | null = null

  get speaking(): boolean {
    return this.audio !== null
  }

  /** 재생을 시작한다. 이전 발화가 남아 있으면 잘라낸다. */
  play(audio: SpeechAudio, visemes: VisemeFrame[], onEnd: () => void): void {
    this.stop()

    const bytes = Uint8Array.from(atob(audio.wavBase64), (c) => c.charCodeAt(0))
    // base64 를 data: URL 로 넘기면 긴 발화에서 URL 길이 제한에 걸린다. Blob 이 안전하다.
    this.objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))

    const el = new Audio(this.objectUrl)
    this.audio = el
    this.frames = visemes
    this.onEnd = onEnd

    el.addEventListener('ended', () => this.finish())
    el.addEventListener('error', () => {
      console.warn('[voice] 재생 실패')
      this.finish()
    })
    void el.play().catch((err: unknown) => {
      console.warn('[voice] 재생 거부됨:', err)
      this.finish()
    })
  }

  /** 매 프레임 호출한다. 재생 중이 아니면 다문 입을 돌려준다. */
  sample(): { viseme: Viseme; weight: number } {
    if (!this.audio) return { viseme: 'sil', weight: 0 }
    return sampleViseme(this.frames, this.audio.currentTime)
  }

  stop(): void {
    const el = this.audio
    this.audio = null
    this.frames = []
    this.onEnd = null
    if (el) {
      el.pause()
      el.src = ''
    }
    if (this.objectUrl) {
      // 해제하지 않으면 발화마다 WAV 하나씩 메모리에 쌓인다.
      URL.revokeObjectURL(this.objectUrl)
      this.objectUrl = null
    }
  }

  private finish(): void {
    const cb = this.onEnd
    this.stop()
    cb?.()
  }
}
