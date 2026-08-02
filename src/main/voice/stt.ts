import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
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

/** superviseWhisper 가 다루는 자식 프로세스의 최소 표면. 테스트에서 fake 로 갈아끼운다. */
export interface WhisperChild {
  /** stdout. 소비하지 않으면 파이프가 차서 프로세스가 멈춘다 — resume 으로 흘려보낸다. */
  readonly stdout: { resume(): void } | null
  /** stderr. tail 만 보존하려고 문자열 청크로 받는다. */
  readonly stderr: { on(event: 'data', listener: (chunk: string) => void): void; setEncoding(encoding: string): void } | null
  on(event: 'error', listener: (err: Error) => void): void
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void
  kill(signal?: NodeJS.Signals): boolean
}

/** whisper 를 띄우는 함수의 최소 시그니처. 기본은 node spawn, 테스트는 fake child 를 준다. */
export type SpawnWhisper = (
  command: string,
  args: readonly string[],
  options: { windowsHide: boolean }
) => WhisperChild

export interface WhisperOutcome {
  code: number | null
  signal: NodeJS.Signals | null
  /** 마지막 STDERR_TAIL_LIMIT 바이트만. 오류 메시지에 쓴다. */
  stderrTail: string
  timedOut: boolean
  /** 실제 close 이벤트를 관측했는지. false면 kill grace가 끝났지만 자식이 남았을 수 있다. */
  closed: boolean
  /** spawn 자체가 실패했을 때(ENOENT 등)의 에러. 정상 경로에서는 null. */
  spawnError: Error | null
}

/** stderr 를 무제한으로 쌓지 않는다. 진행률을 계속 뿜는 빌드면 몇 분에 수십 MB 가 된다. */
const STDERR_TAIL_LIMIT = 4000
/** 응답이 없으면 여기서 끊는다. 짧은 발화 하나가 2분을 넘길 이유가 없다. */
const DEFAULT_TIMEOUT_MS = 120_000
/** kill 뒤 close를 기다리는 상한. 정상 SIGKILL이면 보통 수십 ms 안에 close가 온다. */
const DEFAULT_KILL_GRACE_MS = 2_000
/** 비정상 종료 때 못 지운 찌꺼기를 다음 실행에서 회수하는 나이. 동시 전사는 건드리지 않는다. */
const STALE_TEMP_MS = 24 * 60 * 60 * 1000
/** whisper.cpp v1.9.1 공식 다운로드 스크립트가 제공하는 순서. */
const VAD_MODEL_NAMES = ['ggml-silero-v6.2.0.bin', 'ggml-silero-v5.1.2.bin'] as const

/** 앱 종료 때 살아 있는 whisper를 남기지 않기 위한 프로세스 소유 목록. */
const activeWhispers = new Set<WhisperChild>()

/**
 * 이미 spawn 된 whisper 자식 하나의 수명을 관리한다.
 *
 * 세 가지를 보장한다:
 *  - stdout 을 흘려보내 파이프 backpressure 로 프로세스가 멈추지 않게 한다.
 *  - stderr 는 tail 만 남겨 메모리가 무한히 늘지 않게 한다.
 *  - timeout 이면 kill 하고, 성공/비정상 종료/spawn 에러/timeout 어느 경로로든
 *    **정확히 한 번만** settle 한다 (그래서 호출부의 finally 가 한 번만 돈다).
 */
export function superviseWhisper(
  child: WhisperChild,
  timeoutMs: number,
  killGraceMs = DEFAULT_KILL_GRACE_MS
): Promise<WhisperOutcome> {
  return new Promise<WhisperOutcome>((resolveOutcome) => {
    let settled = false
    let stderrTail = ''
    let timedOut = false
    let timeoutTimer: NodeJS.Timeout | null = null
    let killGraceTimer: NodeJS.Timeout | null = null

    const finish = (outcome: WhisperOutcome): void => {
      if (settled) return
      settled = true
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (killGraceTimer) clearTimeout(killGraceTimer)
      resolveOutcome(outcome)
    }

    // 결과는 파일로 받으므로 stdout 내용은 필요 없다. 다만 소비는 해야 한다 —
    // 아무도 읽지 않으면 whisper 의 write 가 파이프 버퍼가 찬 순간 블록된다.
    child.stdout?.resume()

    const stderr = child.stderr
    if (stderr) {
      stderr.setEncoding('utf8')
      stderr.on('data', (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT)
      })
    }

    // 매달린 프로세스를 끊는다. SIGTERM 은 whisper 가 무시하고 계속 도는 경우가 있어 SIGKILL.
    timeoutTimer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        // 이미 죽었거나 OS가 거부해도 close가 늦게 올 수 있어 grace 동안 기다린다.
      }
      // kill 호출 직후 임시 파일을 지우면 Windows에서 아직 열린 handle과 경합한다.
      // 먼저 close를 기다리고, 이벤트가 유실된 경우에만 짧은 grace 뒤 강제로 끝낸다.
      killGraceTimer = setTimeout(() => {
        finish({
          code: null,
          signal: 'SIGKILL',
          stderrTail,
          timedOut: true,
          closed: false,
          spawnError: null
        })
      }, killGraceMs)
      killGraceTimer.unref?.()
    }, timeoutMs)
    // 이 타이머 하나 때문에 이벤트 루프를 살려둘 이유는 없다.
    timeoutTimer.unref?.()

    child.on('error', (err: Error) => {
      // spawn 실패(ENOENT 등). close 가 뒤따를 수 있으나 single-settle 이라 첫 이벤트만 남는다.
      // timeout 뒤 kill 오류는 close/grace 경계를 건너뛰게 두지 않는다.
      if (timedOut) return
      finish({ code: null, signal: null, stderrTail, timedOut, closed: false, spawnError: err })
    })

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      finish({ code, signal, stderrTail, timedOut, closed: true, spawnError: null })
    })
  })
}

export interface TranscribeDeps {
  /** 기본은 node spawn. 테스트에서 fake child 를 만드는 함수로 갈아끼운다. */
  spawn?: SpawnWhisper
  /** 응답 대기 상한(ms). */
  timeoutMs?: number
  /** timeout kill 뒤 close 대기 상한. 테스트에서 짧게 줄인다. */
  killGraceMs?: number
  /** 임시 WAV/TXT 를 둘 디렉터리. 기본은 userData/stt. 테스트에서 tmp 경로를 준다. */
  dir?: string
}

/** node spawn 을 SpawnWhisper 로 감싼다. readonly args 를 넘길 수 있는 형태로 맞춘다. */
const defaultSpawn: SpawnWhisper = (command, args, options) => spawn(command, [...args], options)

/**
 * base64 WAV 를 받아 텍스트로 옮긴다.
 *
 * whisper.cpp 는 `-otxt` 로 `<입력경로>.txt` 를 만든다. stdout 파싱은 진행률·타임스탬프가
 * 섞여 있어 취약하므로 파일로 받는다.
 *
 * 성공하든 실패하든 임시 WAV 와 whisper 가 만든 TXT 를 **반드시** 지운다 — 안 그러면
 * userData/stt 에 부스러기가 계속 쌓인다.
 */
export async function transcribe(
  wavBase64: string,
  cfg: SttConfig,
  deps: TranscribeDeps = {}
): Promise<string> {
  const avail = checkStt(cfg)
  if (!avail.ok) throw new Error(avail.reason ?? '음성 인식을 쓸 수 없다')

  const spawnFn = deps.spawn ?? defaultSpawn
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const killGraceMs = deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS
  const dir = deps.dir ?? join(app.getPath('userData'), 'stt')
  mkdirSync(dir, { recursive: true })
  cleanupStaleTempFiles(dir)

  const wavPath = join(dir, `${randomUUID()}.wav`)
  const txtPath = `${wavPath}.txt`

  try {
    // 디스크 부족 등으로 부분 파일만 생기고 write가 throw해도 아래 finally가 회수한다.
    writeFileSync(wavPath, Buffer.from(wavBase64, 'base64'))
    const vadModelPath = findVadModel(cfg)
    const args = [
      '-m',
      cfg.modelPath,
      '-f',
      wavPath,
      '-l',
      cfg.language || 'auto',
      // 기본 0.60보다 무음 판정을 조금 강하게 한다. avg_logprob 조건은 기본값을 유지해
      // 조용하지만 실제인 발화까지 버리지 않는다. 1차 방어는 renderer의 PCM energy gate다.
      '-nth',
      '0.5',
      '-otxt',
      // 진행률·타임스탬프를 끈다. 결과 파일만 쓸 것이므로 콘솔은 조용한 편이 낫다.
      '-np',
      '-nt'
    ]
    if (vadModelPath) args.push('--vad', '-vm', vadModelPath)

    const child = spawnFn(cfg.whisperPath, args, { windowsHide: true })
    activeWhispers.add(child)
    // grace 뒤 늦게 close가 와도 소유 목록에서 빠진다.
    child.on('close', () => activeWhispers.delete(child))
    let outcome: WhisperOutcome
    try {
      outcome = await superviseWhisper(child, timeoutMs, killGraceMs)
    } catch (error) {
      activeWhispers.delete(child)
      throw error
    }
    // close를 못 본 timeout은 앱 종료 때 한 번 더 kill할 수 있게 소유 목록에 남긴다.
    // 정상 close와 spawn error는 더 이상 살아 있는 프로세스가 아니다.
    if (outcome.closed || outcome.spawnError) activeWhispers.delete(child)

    if (outcome.timedOut) throw new Error(`whisper 응답이 없어 ${timeoutMs}ms 후 강제 종료했다`)
    if (outcome.spawnError) throw new Error(`whisper 실행 실패: ${outcome.spawnError.message}`)
    if (outcome.code !== 0) {
      throw new Error(`whisper 종료 코드 ${outcome.code}: ${outcome.stderrTail.slice(-300)}`)
    }

    if (!existsSync(txtPath)) throw new Error('whisper 가 결과 파일을 만들지 않았다')
    return readFileSync(txtPath, 'utf8').trim()
  } finally {
    // 어느 경로로 빠져나가든 두 임시 파일을 지운다.
    removeQuietly(wavPath)
    removeQuietly(txtPath)
  }
}

/**
 * 별도 설정 스키마를 늘리지 않고, 사용자가 설치한 공식 Silero VAD를 ASR 모델이나 실행 파일
 * 곁에서 찾는다. 없으면 energy gate + no-speech threshold만 쓰며 STT 자체는 계속 동작한다.
 */
export function findVadModel(cfg: SttConfig): string | null {
  const dirs = [dirname(cfg.modelPath), dirname(cfg.whisperPath)]
  for (const dir of dirs) {
    for (const name of VAD_MODEL_NAMES) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/** 앱 종료 때 아직 계산 중인 whisper들을 정리한다. 새 프로세스는 detached가 아니라 직접 kill한다. */
export function stopActiveWhispers(): void {
  for (const child of activeWhispers) {
    try {
      child.kill('SIGKILL')
    } catch {
      // 종료 중에는 더 복구할 UI가 없다. 부모 프로세스 종료가 마지막 안전망이다.
    }
  }
  activeWhispers.clear()
}

/** 이전 비정상 종료에서 남은 WAV/TXT만 회수한다. 최근 파일은 동시 전사일 수 있어 보존한다. */
export function cleanupStaleTempFiles(dir: string, now = Date.now()): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }

  for (const name of names) {
    if (!name.endsWith('.wav') && !name.endsWith('.wav.txt')) continue
    const path = join(dir, name)
    try {
      if (now - statSync(path).mtimeMs >= STALE_TEMP_MS) rmSync(path, { force: true })
    } catch {
      // 잠겨 있으면 다음 전사에서 다시 시도한다.
    }
  }
}

/** 지우지 못해도 흐름을 막지 않는다. 다음 전사의 stale janitor가 다시 회수한다. */
function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    // 파일이 잠겨 있거나 접근 불가면 다음 기회에 지운다. 여기서 던지면 원래 에러를 가린다.
  }
}
