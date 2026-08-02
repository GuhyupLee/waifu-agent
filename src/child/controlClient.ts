/**
 * Claude Code 가 spawn 하는 자식 스크립트(MCP 서버, 권한 훅)가 Electron main 의
 * ControlServer 와 이야기하는 통로.
 *
 * 이 파일을 `src/shared/` 에 두지 않는 이유: `ws` 는 Node 전용이라 렌더러 번들에 섞이면
 * vite 가 `child_process`/`fs` 를 브라우저용으로 외부화하면서 런타임에 터진다.
 * `src/shared/` 는 순수 타입·상수·순수 함수만 둔다.
 */
import { WebSocket } from 'ws'
import { CONTROL_ENV } from '@shared/protocol'
import type { ControlRequest, ControlResponse, WaifuToolName } from '@shared/protocol'

const CONNECT_TIMEOUT_MS = 3000

export class ControlClient {
  private ws: WebSocket | null = null
  private seq = 0
  private readonly pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >()

  constructor(
    private readonly port: string,
    private readonly token: string
  ) {}

  /** 환경변수에서 접속 정보를 읽는다. 없으면 null — 호출자가 상황에 맞게 실패 처리한다. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): ControlClient | null {
    const port = env[CONTROL_ENV.port]
    const token = env[CONTROL_ENV.token]
    return port && token ? new ControlClient(port, token) : null
  }

  connect(): Promise<void> {
    if (this.ws) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}`, {
        headers: { 'x-waifu-token': this.token }
      })
      const timer = setTimeout(() => {
        ws.terminate()
        reject(new Error('제어 서버 접속 시간 초과'))
      }, CONNECT_TIMEOUT_MS)

      ws.on('open', () => {
        clearTimeout(timer)
        this.ws = ws
        resolve()
      })
      ws.on('message', (data) => this.onMessage(String(data)))
      ws.on('error', (err) => {
        clearTimeout(timer)
        this.failAll(err instanceof Error ? err : new Error(String(err)))
        reject(err instanceof Error ? err : new Error(String(err)))
      })
      ws.on('close', () => {
        this.ws = null
        this.failAll(new Error('제어 서버 연결이 끊겼다'))
      })
    })
  }

  /**
   * 툴 한 번 호출. timeoutMs 는 호출마다 다르다 —
   * 표정 바꾸기는 즉시지만 권한 승인은 사용자가 커피 타러 갔을 수도 있다.
   */
  async call(tool: WaifuToolName, args: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    await this.connect()
    const ws = this.ws
    if (!ws) throw new Error('제어 서버에 연결되지 않았다')

    const id = `${tool}_${++this.seq}_${process.pid}`
    const req: ControlRequest = { id, tool, args }

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${tool} 응답 시간 초과 (${timeoutMs}ms)`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify(req))
    })
  }

  close(): void {
    this.failAll(new Error('클라이언트가 닫혔다'))
    try {
      this.ws?.close()
    } catch {
      /* 이미 닫혔으면 무시 */
    }
    this.ws = null
  }

  private onMessage(raw: string): void {
    let msg: ControlResponse
    try {
      msg = JSON.parse(raw) as ControlResponse
    } catch {
      return
    }
    const entry = this.pending.get(msg.id)
    if (!entry) return
    this.pending.delete(msg.id)
    clearTimeout(entry.timer)
    if (msg.ok) entry.resolve(msg.result)
    else entry.reject(new Error(msg.error ?? '제어 서버가 실패를 알렸다'))
  }

  private failAll(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(err)
    }
    this.pending.clear()
  }
}
