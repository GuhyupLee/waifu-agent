import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'

/**
 * whisper.cpp 로 음성을 받아쓴다.
 *
 * 바이너리와 모델은 앱이 내려받지 않는다. 사용자가 이미 설치한 것을 설정에서 가리키게 한다 —
 * 수백 MB 짜리 모델을 앱이 마음대로 받는 건 예의가 아니고, 라이선스도 각자 다르다.
 *
 * 입력은 렌더러가 만든 16kHz 모노 WAV 다. whisper.cpp 가 그 형식만 받으므로
 * 녹음 단계에서 맞춰 온다 (ffmpeg 같은 추가 의존을 두지 않으려는 것이다).
 */

export interface SttConfig {
  whisperPath: string
  modelPath: string
  language: string
}

export interface SttAvailability {
  ok: boolean
  reason?: string
}

/** 설정이 실제로 쓸 수 있는 상태인지. 설정 화면과 시작 로그에서 쓴다. */
export function checkStt(cfg: SttConfig): SttAvailability {
  if (!cfg.whisperPath) return { ok: false, reason: 'whisper 실행 파일 경로가 비어 있다' }
  if (!existsSync(cfg.whisperPath)) {
    return { ok: false, reason: `whisper 실행 파일이 없다: ${cfg.whisperPath}` }
  }
  if (!cfg.modelPath) return { ok: false, reason: '모델 경로가 비어 있다' }
  if (!existsSync(cfg.modelPath)) return { ok: false, reason: `모델 파일이 없다: ${cfg.modelPath}` }
  return { ok: true }
}

/**
 * base64 WAV 를 받아 텍스트로 옮긴다.
 *
 * whisper.cpp 는 `-otxt` 로 `<입력경로>.txt` 를 만든다. stdout 파싱은 진행률·타임스탬프가
 * 섞여 있어 취약하므로 파일로 받는다.
 */
export async function transcribe(wavBase64: string, cfg: SttConfig): Promise<string> {
  const avail = checkStt(cfg)
  if (!avail.ok) throw new Error(avail.reason ?? '음성 인식을 쓸 수 없다')

  const dir = join(app.getPath('userData'), 'stt')
  mkdirSync(dir, { recursive: true })
  const wavPath = join(dir, `${randomUUID()}.wav`)
  writeFileSync(wavPath, Buffer.from(wavBase64, 'base64'))

  const args = [
    '-m',
    cfg.modelPath,
    '-f',
    wavPath,
    '-l',
    cfg.language || 'auto',
    '-otxt',
    // 진행률·타임스탬프를 끈다. 결과 파일만 쓸 것이므로 콘솔은 조용한 편이 낫다.
    '-np',
    '-nt'
  ]

  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(cfg.whisperPath, args, { windowsHide: true })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c: string) => (stderr += c))
    child.on('error', (err) => reject(new Error(`whisper 실행 실패: ${err.message}`)))
    child.on('close', (c) => {
      if (c !== 0) reject(new Error(`whisper 종료 코드 ${c}: ${stderr.slice(-300)}`))
      else resolve(c)
    })
  })

  if (code !== 0) throw new Error(`whisper 종료 코드 ${code}`)

  const txtPath = `${wavPath}.txt`
  if (!existsSync(txtPath)) throw new Error('whisper 가 결과 파일을 만들지 않았다')
  return readFileSync(txtPath, 'utf8').trim()
}
