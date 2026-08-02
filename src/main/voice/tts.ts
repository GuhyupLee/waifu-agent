import { buildVisemeTrack } from '@shared/lipsync'
import type { AudioQuery } from '@shared/lipsync'
import type { SpeechAudio, VisemeFrame } from '@shared/protocol'

/**
 * VOICEVOX 호환 엔진 클라이언트 (AivisSpeech, VOICEVOX, COEIROINK 가 같은 API 를 쓴다).
 *
 * 두 단계로 나뉜다:
 *   1. POST /audio_query  → mora 단위 길이가 담긴 쿼리
 *   2. POST /synthesis    → 그 쿼리로 만든 WAV
 *
 * 1단계 결과를 그대로 립싱크에 쓰는 것이 핵심이다. 음량으로 입 크기를 추정하는
 * 방식과 달리 음소 정확도가 나온다.
 */

export interface TtsOptions {
  engineUrl: string
  speakerId: number
  speedScale: number
}

export interface Synthesized {
  audio: SpeechAudio
  visemes: VisemeFrame[]
}

/** 엔진이 죽어 있는 흔한 상황에서 앱이 멈춰 보이지 않도록 짧게 끊는다. */
const QUERY_TIMEOUT_MS = 10_000
const SYNTH_TIMEOUT_MS = 60_000

async function post(url: string, timeoutMs: number, body?: string): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body })
    })
  } finally {
    clearTimeout(timer)
  }
}

/** 엔진이 살아 있는지. 설정 화면에서 확인 버튼에 쓴다. */
export async function pingEngine(engineUrl: string): Promise<string | null> {
  try {
    const res = await fetch(`${engineUrl}/version`, { signal: AbortSignal.timeout(3000) })
    return res.ok ? (await res.text()).replace(/"/g, '') : null
  } catch {
    return null
  }
}

export async function synthesize(text: string, opts: TtsOptions): Promise<Synthesized> {
  const base = opts.engineUrl.replace(/\/+$/, '')

  // 1) 텍스트 → 운율 쿼리. text 는 쿼리스트링으로 넘긴다 (본문이 아니다).
  const queryUrl = `${base}/audio_query?text=${encodeURIComponent(text)}&speaker=${opts.speakerId}`
  const queryRes = await post(queryUrl, QUERY_TIMEOUT_MS)
  if (!queryRes.ok) {
    throw new Error(`audio_query 실패 (${queryRes.status}). 엔진이 켜져 있는지 확인해라.`)
  }
  const query = (await queryRes.json()) as AudioQuery

  // 속도는 여기서 반영해야 립싱크 타이밍과 실제 음성이 일치한다.
  query.speedScale = opts.speedScale

  // 2) 쿼리 → WAV
  const synthUrl = `${base}/synthesis?speaker=${opts.speakerId}`
  const synthRes = await post(synthUrl, SYNTH_TIMEOUT_MS, JSON.stringify(query))
  if (!synthRes.ok) throw new Error(`synthesis 실패 (${synthRes.status})`)

  const wav = Buffer.from(await synthRes.arrayBuffer())
  const { frames, estimatedDurationSec } = buildVisemeTrack(query)

  return {
    audio: {
      wavBase64: wav.toString('base64'),
      // WAV 헤더에서 실제 길이를 읽는다. 쿼리로 계산한 예상치와 어긋날 수 있고,
      // 어긋나면 재생 위치 기준으로 립싱크하는 쪽이 맞다.
      durationSec: wavDurationSec(wav) ?? estimatedDurationSec
    },
    visemes: frames
  }
}

/**
 * WAV 헤더에서 재생 길이를 읽는다.
 *
 * 엔진이 표준 44바이트 헤더만 쓴다고 가정하지 않는다 — LIST 청크가 끼어 있으면
 * data 청크 위치가 밀린다. 청크를 순회해서 찾는다.
 */
export function wavDurationSec(buf: Buffer): number | null {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF') return null
  if (buf.toString('ascii', 8, 12) !== 'WAVE') return null

  let byteRate = 0
  let dataSize = 0
  let p = 12

  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4)
    const size = buf.readUInt32LE(p + 4)
    if (id === 'fmt ' && p + 8 + 16 <= buf.length) byteRate = buf.readUInt32LE(p + 16)
    else if (id === 'data') {
      dataSize = size
      break
    }
    // 청크는 짝수 바이트로 정렬된다. 홀수면 패딩 1바이트가 붙는다.
    p += 8 + size + (size % 2)
  }

  if (byteRate <= 0 || dataSize <= 0) return null
  return dataSize / byteRate
}
