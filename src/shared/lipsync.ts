import { VOWEL_TO_VISEME } from '@shared/protocol'
import type { Viseme, VisemeFrame } from '@shared/protocol'

/**
 * VOICEVOX 호환 엔진의 `audio_query` 응답을 입모양 트랙으로 바꾼다.
 *
 * 이게 이 프로젝트가 일본어 TTS 를 고른 가장 큰 실익이다. 엔진이 mora 단위 길이를
 * 그대로 주기 때문에, 음량으로 입 크기를 추정하는 근사가 아니라 **음소 정확 립싱크**가 된다.
 *
 * 필드 이름은 voicevox_engine 의 모델 정의에서 확인했다. 특히:
 *  - `consonant` / `consonant_length` 는 **null 일 수 있다** (모음만 있는 mora).
 *  - `pause_mora` 도 null 일 수 있고, 있으면 그 구간은 입을 다문다.
 *  - 길이는 전부 `speedScale` 로 나뉜다. 앞뒤 무음도 마찬가지다.
 */

export interface Mora {
  text: string
  consonant?: string | null
  consonant_length?: number | null
  vowel: string
  vowel_length: number
  pitch: number
}

export interface AccentPhrase {
  moras: Mora[]
  accent: number
  pause_mora?: Mora | null
  is_interrogative?: boolean
}

export interface AudioQuery {
  accent_phrases: AccentPhrase[]
  speedScale: number
  pitchScale?: number
  intonationScale?: number
  volumeScale?: number
  prePhonemeLength: number
  postPhonemeLength: number
  outputSamplingRate?: number
  outputStereo?: boolean
  kana?: string | null
}

/**
 * 짧은 mora 는 입을 덜 벌린다. 이 값보다 긴 모음은 최대로 벌린다.
 * 전부 1.0 으로 두면 기관총처럼 딱딱 벌어져서 어색하다.
 */
const FULL_OPEN_SEC = 0.11
const MIN_WEIGHT = 0.35

export interface LipsyncResult {
  frames: VisemeFrame[]
  /** 이 쿼리로 합성했을 때 예상되는 길이(초). 실제 WAV 길이와 대조하는 데 쓴다. */
  estimatedDurationSec: number
}

export function buildVisemeTrack(query: AudioQuery): LipsyncResult {
  // speedScale 이 0 이나 음수로 오면 시간이 무한대나 음수가 된다. 방어한다.
  const speed = query.speedScale > 0 ? query.speedScale : 1
  const frames: VisemeFrame[] = []

  // 합성 결과 앞에는 무음이 붙는다. 이걸 빼먹으면 입이 소리보다 먼저 움직인다.
  let t = query.prePhonemeLength / speed

  const push = (time: number, viseme: Viseme, weight: number): void => {
    const last = frames[frames.length - 1]
    // 같은 입모양이 연달아 오면 키프레임을 늘릴 이유가 없다.
    if (last && last.viseme === viseme && Math.abs(last.weight - weight) < 0.05) return
    frames.push({ t: time, viseme, weight })
  }

  for (const phrase of query.accent_phrases) {
    for (const mora of phrase.moras) {
      // 자음 구간에는 아직 입이 그 모음 모양이 아니다. 모음 시작에 키프레임을 둔다.
      const consonant = (mora.consonant_length ?? 0) / speed
      const vowel = mora.vowel_length / speed
      t += consonant

      const viseme = VOWEL_TO_VISEME[mora.vowel] ?? 'sil'
      // 발음 길이에 비례해 입을 벌린다. 'N'(ん)이나 'cl'(촉음)은 다문 상태다.
      const weight =
        viseme === 'sil' ? 0 : Math.max(MIN_WEIGHT, Math.min(1, vowel / FULL_OPEN_SEC))
      push(t, viseme, weight)

      t += vowel
    }

    // 구절 사이 쉼. 있으면 입을 다문다.
    const pause = phrase.pause_mora
    if (pause) {
      push(t, 'sil', 0)
      t += ((pause.consonant_length ?? 0) + pause.vowel_length) / speed
    }
  }

  // 말이 끝나면 입을 다문다. 이게 없으면 마지막 모음 모양으로 굳는다.
  push(t, 'sil', 0)
  t += query.postPhonemeLength / speed

  return { frames, estimatedDurationSec: t }
}

/**
 * 트랙에서 주어진 시각의 입모양을 뽑는다.
 *
 * 렌더러가 매 프레임 호출한다. 키프레임 사이는 선형 보간해야 입이 딱딱 끊기지 않는다.
 * `at` 은 벽시계가 아니라 **오디오의 재생 위치**여야 한다 — 그래야 예상 길이가 실제와
 * 조금 어긋나도 입과 소리가 어긋나지 않는다.
 */
export function sampleViseme(
  frames: readonly VisemeFrame[],
  at: number
): { viseme: Viseme; weight: number } {
  const first = frames[0]
  if (!first) return { viseme: 'sil', weight: 0 }
  // 첫 키프레임 전은 앞쪽 무음 구간이다. 여기서 입을 벌리고 있으면
  // 소리가 나기도 전에 입만 벌린 채 기다리는 꼴이 된다.
  if (at < first.t) return { viseme: 'sil', weight: 0 }

  let i = 0
  while (i + 1 < frames.length && frames[i + 1]!.t <= at) i++

  const cur = frames[i]!
  const next = frames[i + 1]
  if (!next) return { viseme: cur.viseme, weight: cur.weight }

  const span = next.t - cur.t
  const k = span > 0 ? (at - cur.t) / span : 1

  // 한 번에 하나의 입모양만 낼 수 있으므로(두 표정을 동시에 켜면 얼굴이 뭉개진다)
  // 중간 지점에서 갈아타되, 가중치를 깎았다가 올려 딱딱 끊기지 않게 한다.
  if (k < 0.5) return { viseme: cur.viseme, weight: cur.weight * (1 - k) }
  return { viseme: next.viseme, weight: next.weight * k }
}
