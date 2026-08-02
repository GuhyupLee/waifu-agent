import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupStaleTempFiles,
  stopActiveWhispers,
  superviseWhisper,
  transcribe
} from '../src/main/voice/stt'
import type { SpawnWhisper, SttConfig } from '../src/main/voice/stt'

// ─────────────────────── fake whisper 자식 ───────────────────────

class FakeStdout {
  resumed = 0
  resume(): void {
    this.resumed++
  }
}

class FakeStderr extends EventEmitter {
  encoding: string | null = null
  setEncoding(enc: string): void {
    this.encoding = enc
  }
  feed(chunk: string): void {
    this.emit('data', chunk)
  }
}

class FakeChild extends EventEmitter {
  readonly stdout = new FakeStdout()
  readonly stderr = new FakeStderr()
  killSignal: NodeJS.Signals | null = null
  kill(signal?: NodeJS.Signals): boolean {
    this.killSignal = signal ?? 'SIGTERM'
    return true
  }
  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('close', code, signal)
  }
  fail(err: Error): void {
    this.emit('error', err)
  }
}

describe('superviseWhisper — 자식 하나의 수명', () => {
  it('stdout 을 흘려보내고 stderr 는 tail 만 남긴다', async () => {
    const child = new FakeChild()
    const p = superviseWhisper(child, 1000)
    // stdout 소비는 동기적으로 시작한다 — backpressure 로 프로세스가 멈추면 안 된다.
    expect(child.stdout.resumed).toBeGreaterThan(0)

    child.stderr.feed('a'.repeat(5000))
    child.stderr.feed('b'.repeat(1000))
    child.close(0)

    const outcome = await p
    expect(outcome.code).toBe(0)
    expect(outcome.timedOut).toBe(false)
    expect(outcome.spawnError).toBeNull()
    // 무제한으로 쌓지 않고 끝부분만 보존한다.
    expect(outcome.stderrTail.length).toBeLessThanOrEqual(4000)
    expect(outcome.stderrTail.endsWith('b'.repeat(1000))).toBe(true)
  })

  it('응답이 없으면 timeout 에 kill 하고 한 번만 settle 한다', async () => {
    const child = new FakeChild()
    const outcome = await superviseWhisper(child, 20, 5)
    expect(outcome.timedOut).toBe(true)
    expect(outcome.signal).toBe('SIGKILL')
    expect(outcome.closed).toBe(false)
    expect(child.killSignal).toBe('SIGKILL')
  })

  it('timeout kill 뒤에는 close를 기다리고, close가 오면 grace 전에 끝낸다', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    let done = false
    const pending = superviseWhisper(child, 20, 100).then((outcome) => {
      done = true
      return outcome
    })

    await vi.advanceTimersByTimeAsync(20)
    expect(child.killSignal).toBe('SIGKILL')
    expect(done).toBe(false)

    child.close(null, 'SIGKILL')
    const outcome = await pending
    expect(outcome.timedOut).toBe(true)
    expect(outcome.signal).toBe('SIGKILL')
    expect(outcome.closed).toBe(true)
  })

  it('close 뒤에 온 늦은 error 는 결과를 바꾸지 않는다 (single-settle)', async () => {
    const child = new FakeChild()
    const p = superviseWhisper(child, 1000)
    child.close(0)
    child.fail(new Error('too late'))
    const outcome = await p
    expect(outcome.code).toBe(0)
    expect(outcome.spawnError).toBeNull()
  })

  it('spawn 에러를 outcome 에 담는다', async () => {
    const child = new FakeChild()
    const p = superviseWhisper(child, 1000)
    child.fail(new Error('ENOENT'))
    const outcome = await p
    expect(outcome.spawnError?.message).toBe('ENOENT')
    expect(outcome.code).toBeNull()
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('cleanupStaleTempFiles', () => {
  it('오래된 STT 찌꺼기만 다음 실행에서 회수한다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'waifu-stt-stale-'))
    try {
      const oldWav = join(dir, 'old.wav')
      const oldTxt = join(dir, 'old.wav.txt')
      const recentWav = join(dir, 'recent.wav')
      writeFileSync(oldWav, 'x')
      writeFileSync(oldTxt, 'x')
      writeFileSync(recentWav, 'x')
      const now = Date.now()
      const old = new Date(now - 25 * 60 * 60 * 1000)
      utimesSync(oldWav, old, old)
      utimesSync(oldTxt, old, old)

      cleanupStaleTempFiles(dir, now)

      expect(existsSync(oldWav)).toBe(false)
      expect(existsSync(oldTxt)).toBe(false)
      expect(existsSync(recentWav)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ─────────────────────── transcribe — 임시 파일 정리 ───────────────────────

const b64 = Buffer.from('fake-wav-bytes').toString('base64')

function makeCfg(dir: string): SttConfig {
  const whisperPath = join(dir, 'whisper.exe')
  const modelPath = join(dir, 'model.bin')
  writeFileSync(whisperPath, 'x')
  writeFileSync(modelPath, 'x')
  return { whisperPath, modelPath, language: 'ko' }
}

/** args 에서 `-f <wav>` 를 뽑는다. whisper 는 <wav>.txt 로 결과를 쓴다. */
function wavArg(args: readonly string[]): string {
  const i = args.indexOf('-f')
  return args[i + 1]!
}

describe('transcribe — 어느 경로로 끝나든 임시 파일을 남기지 않는다', () => {
  const dirs: string[] = []
  const workDir = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'waifu-stt-'))
    dirs.push(d)
    return d
  }
  afterEach(() => {
    stopActiveWhispers()
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  /** 결과 파일 안에 남은 wav/txt 부스러기. 정리됐으면 빈 배열이어야 한다. */
  const leftovers = (sttDir: string): string[] =>
    existsSync(sttDir) ? readdirSync(sttDir).filter((f) => f.endsWith('.wav') || f.endsWith('.txt')) : []

  it('성공하면 텍스트를 다듬어 주고 wav·txt 를 지운다', async () => {
    const root = workDir()
    const cfg = makeCfg(root)
    const sttDir = join(root, 'work')

    const spawn: SpawnWhisper = (_cmd, args) => {
      const child = new FakeChild()
      queueMicrotask(() => {
        writeFileSync(`${wavArg(args)}.txt`, '  안녕하세요  ')
        child.close(0)
      })
      return child
    }

    const text = await transcribe(b64, cfg, { spawn, dir: sttDir, timeoutMs: 1000 })
    expect(text).toBe('안녕하세요')
    expect(leftovers(sttDir)).toEqual([])
  })

  it('무음 판정을 강화하되 VAD 모델이나 공격적인 logprob 옵션은 임의로 넣지 않는다', async () => {
    const root = workDir()
    const cfg = makeCfg(root)
    const sttDir = join(root, 'work')
    let receivedArgs: readonly string[] = []

    const spawn: SpawnWhisper = (_cmd, args) => {
      receivedArgs = args
      const child = new FakeChild()
      queueMicrotask(() => {
        writeFileSync(`${wavArg(args)}.txt`, '')
        child.close(0)
      })
      return child
    }

    await transcribe(b64, cfg, { spawn, dir: sttDir })
    const nth = receivedArgs.indexOf('-nth')
    expect(receivedArgs[nth + 1]).toBe('0.5')
    expect(receivedArgs).not.toContain('-lpt')
    expect(receivedArgs).not.toContain('-sns')
    expect(receivedArgs).not.toContain('--vad')
    expect(receivedArgs).not.toContain('-vm')
  })

  it('ASR 모델 곁에 공식 Silero VAD가 있으면 자동으로 사용한다', async () => {
    const root = workDir()
    const cfg = makeCfg(root)
    const vadPath = join(root, 'ggml-silero-v6.2.0.bin')
    writeFileSync(vadPath, 'vad')
    const sttDir = join(root, 'work')
    let receivedArgs: readonly string[] = []

    const spawn: SpawnWhisper = (_cmd, args) => {
      receivedArgs = args
      const child = new FakeChild()
      queueMicrotask(() => {
        writeFileSync(`${wavArg(args)}.txt`, '')
        child.close(0)
      })
      return child
    }

    expect(await transcribe(b64, cfg, { spawn, dir: sttDir })).toBe('')
    expect(receivedArgs).toContain('--vad')
    const modelArg = receivedArgs.indexOf('-vm')
    expect(receivedArgs[modelArg + 1]).toBe(vadPath)
  })

  it('비정상 종료면 던지고 임시 파일을 지운다', async () => {
    const root = workDir()
    const cfg = makeCfg(root)
    const sttDir = join(root, 'work')

    const spawn: SpawnWhisper = () => {
      const child = new FakeChild()
      queueMicrotask(() => {
        child.stderr.feed('boom')
        child.close(3)
      })
      return child
    }

    await expect(transcribe(b64, cfg, { spawn, dir: sttDir })).rejects.toThrow(/종료 코드 3/)
    expect(leftovers(sttDir)).toEqual([])
  })

  it('타임아웃이면 kill·던지고 임시 파일을 지운다', async () => {
    const root = workDir()
    const cfg = makeCfg(root)
    const sttDir = join(root, 'work')

    // 절대 close 하지 않는 자식.
    const spawn: SpawnWhisper = () => new FakeChild()

    await expect(
      transcribe(b64, cfg, { spawn, dir: sttDir, timeoutMs: 20, killGraceMs: 5 })
    ).rejects.toThrow(/강제 종료/)
    expect(leftovers(sttDir)).toEqual([])
  })

  it('spawn 이 실패해도 임시 파일을 지운다', async () => {
    const root = workDir()
    const cfg = makeCfg(root)
    const sttDir = join(root, 'work')

    const spawn: SpawnWhisper = () => {
      const child = new FakeChild()
      queueMicrotask(() => child.fail(new Error('EACCES')))
      return child
    }

    await expect(transcribe(b64, cfg, { spawn, dir: sttDir })).rejects.toThrow(/실행 실패/)
    expect(leftovers(sttDir)).toEqual([])
  })

  it('앱 종료 정리는 실행 중인 whisper를 kill하고 임시 파일도 회수한다', async () => {
    const root = workDir()
    const cfg = makeCfg(root)
    const sttDir = join(root, 'work')
    const child = new FakeChild()
    const spawn: SpawnWhisper = () => child

    const pending = transcribe(b64, cfg, { spawn, dir: sttDir, timeoutMs: 10_000 })
    await Promise.resolve()
    stopActiveWhispers()
    expect(child.killSignal).toBe('SIGKILL')
    child.close(null, 'SIGKILL')

    await expect(pending).rejects.toThrow(/종료 코드/)
    expect(leftovers(sttDir)).toEqual([])
  })

  it('종료는 0 인데 결과 파일이 없으면 던지고 wav 를 지운다', async () => {
    const root = workDir()
    const cfg = makeCfg(root)
    const sttDir = join(root, 'work')

    const spawn: SpawnWhisper = () => {
      const child = new FakeChild()
      queueMicrotask(() => child.close(0))
      return child
    }

    await expect(transcribe(b64, cfg, { spawn, dir: sttDir })).rejects.toThrow(/결과 파일/)
    expect(leftovers(sttDir)).toEqual([])
  })

  it('설정이 준비 안 됐으면 spawn 하기 전에 막는다', async () => {
    const root = workDir()
    // whisperPath 가 없다.
    const cfg: SttConfig = { whisperPath: '', modelPath: '', language: 'ko' }
    let spawned = false
    const spawn: SpawnWhisper = () => {
      spawned = true
      return new FakeChild()
    }
    await expect(transcribe(b64, cfg, { spawn, dir: join(root, 'work') })).rejects.toThrow()
    expect(spawned).toBe(false)
  })
})
