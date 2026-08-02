import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { synthesize } from '../src/main/voice/tts'
import { transcribe } from '../src/main/voice/stt'

/**
 * 실제 로컬 엔진을 쓰는 선택적 종단 테스트.
 *
 * 평소 npm test 에서는 건너뛴다. 릴리스 전이나 음성 설치 직후 아래 환경변수를 지정하면
 * VOICEVOX 합성 → viseme → whisper.cpp 전사 → 임시파일 정리까지 한 번에 확인한다.
 */
const engineUrl = process.env.WAIFU_TEST_VOICE_ENGINE_URL
const whisperPath = process.env.WAIFU_TEST_WHISPER_PATH
const modelPath = process.env.WAIFU_TEST_WHISPER_MODEL
const speakerId = Number(process.env.WAIFU_TEST_VOICE_SPEAKER_ID ?? '0')
const ready = Boolean(engineUrl && whisperPath && modelPath && Number.isInteger(speakerId))

describe.runIf(ready)('local voice integration', () => {
  it(
    'VOICEVOX 음성을 viseme과 함께 만들고 whisper.cpp로 다시 받아쓴다',
    async () => {
      const sttDir = mkdtempSync(join(tmpdir(), 'waifu-voice-integration-'))
      try {
        const synthesized = await synthesize('こんにちは。音声認識のテストです。', {
          engineUrl: engineUrl!,
          speakerId,
          speedScale: 1
        })

        const wav = Buffer.from(synthesized.audio.wavBase64, 'base64')
        expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
        expect(synthesized.audio.durationSec).toBeGreaterThan(0)
        expect(synthesized.visemes.some((frame) => frame.viseme !== 'sil')).toBe(true)

        const text = await transcribe(
          synthesized.audio.wavBase64,
          { whisperPath: whisperPath!, modelPath: modelPath!, language: 'ja' },
          { dir: sttDir, timeoutMs: 120_000 }
        )

        expect(text).toMatch(/音声.*認識.*テスト/)
        expect(readdirSync(sttDir)).toEqual([])
      } finally {
        rmSync(sttDir, { recursive: true, force: true })
      }
    },
    180_000
  )
})
