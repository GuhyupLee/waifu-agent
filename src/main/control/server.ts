import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { ControlRequest, ControlResponse, WaifuToolName } from '@shared/protocol'

/**
 * Claude Code 가 띄운 자식 스크립트(MCP 서버, 권한 훅)가 Electron main 과 이야기하는 창구.
 *
 * 왜 로컬 HTTP 인가: 두 자식 모두 우리가 아니라 **claude 가** spawn 한다. 부모-자식 IPC
 * 채널을 쓸 수 없어서 주소를 환경변수로 흘려보내는 수밖에 없다.
 *
 * WebSocket 이 아닌 이유: 자식은 요청 하나에 응답 하나만 받으면 되고 서버가 먼저 말을 걸
 * 일이 없다. 그리고 `ws` 를 번들에 넣으면 선택적 네이티브 가속기(bufferutil,
 * utf-8-validate)를 정적 import 로 끌어와 로드 타임에 죽는다 — node 빌트인만 쓰면
 * 그 문제 자체가 사라진다.
 *
 * 보안:
 *  - 127.0.0.1 에만 바인딩한다.
 *  - 매 실행마다 새 토큰을 만들고 헤더로 검사한다. 같은 머신의 다른 프로세스가
 *    포트를 찾아 붙는 것을 막는다.
 *  - 포트는 0 으로 열어 OS 가 고르게 한다. 고정 포트는 충돌하고 예측 가능해진다.
 */

export type ToolHandler = (
  tool: WaifuToolName,
  args: Record<string, unknown>
) => Promise<unknown> | unknown

const TOKEN_HEADER = 'x-waifu-token'
const MAX_BODY_BYTES = 1024 * 1024
const RECEIVE_TIMEOUT_MS = 15_000
const STOP_TIMEOUT_MS = 2_000

export class ControlServer {
  private server: Server | null = null
  private stopAttempt: Promise<void> | null = null
  private _port = 0
  readonly token = randomBytes(24).toString('hex')

  constructor(private readonly handle: ToolHandler) {}

  get port(): number {
    return this._port
  }

  /** 자식 스크립트에 넘길 환경변수. `CONTROL_ENV` 의 키와 짝을 이룬다. */
  childEnv(): Record<string, string> {
    return { WAIFU_CONTROL_PORT: String(this._port), WAIFU_CONTROL_TOKEN: this.token }
  }

  async start(): Promise<number> {
    if (this.server) return this._port

    const server = createServer((req, res) => {
      void this.onRequest(req, res).catch((err: unknown) => {
        // partial body를 보낸 자식이 끊기거나 앱 종료가 socket을 닫아도 main까지 죽이면 안 된다.
        process.stderr.write(`[control] 요청 처리 중 연결 종료: ${String(err)}\n`)
        if (!res.destroyed) res.destroy()
      })
    })
    // 권한 handler는 사용자가 누를 때까지 오래 기다려도 된다. 반면 헤더/본문을 덜 보낸
    // socket은 프로그램 종료를 영원히 막으므로 수신 단계만 제한한다.
    server.requestTimeout = RECEIVE_TIMEOUT_MS
    server.headersTimeout = RECEIVE_TIMEOUT_MS
    server.timeout = 0
    this.server = server

    return new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        this._port = typeof addr === 'object' && addr ? addr.port : 0
        resolve(this._port)
      })
    })
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers[TOKEN_HEADER] !== this.token) {
      res.writeHead(401).end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }

    let body = ''
    let bodyBytes = 0
    req.setEncoding('utf8')
    for await (const chunk of req) {
      bodyBytes += Buffer.byteLength(chunk)
      if (bodyBytes > MAX_BODY_BYTES) {
        res.writeHead(413).end()
        return
      }
      body += chunk
    }

    let request: ControlRequest
    try {
      request = JSON.parse(body) as ControlRequest
    } catch {
      res.writeHead(400).end()
      return
    }

    let out: ControlResponse
    try {
      out = { id: request.id, ok: true, result: await this.handle(request.tool, request.args ?? {}) }
    } catch (err) {
      out = { id: request.id, ok: false, error: (err as Error).message }
    }

    // 클라이언트가 이미 끊었으면 쓰기가 예외를 던진다. 사용자가 승인 카드를 오래 방치한
    // 뒤 claude 가 죽는 경우가 여기 해당한다.
    if (res.writableEnded) return
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(out))
  }

  stop(): Promise<void> {
    if (this.stopAttempt) return this.stopAttempt
    const server = this.server
    if (!server) return Promise.resolve()

    const attempt = this.stopServer(server)
    let tracked: Promise<void>
    tracked = attempt.finally(() => {
      if (this.stopAttempt === tracked) this.stopAttempt = null
    })
    this.stopAttempt = tracked
    return tracked
  }

  private async stopServer(server: Server): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      }
      const timer = setTimeout(
        () => finish(new Error('로컬 제어 서버를 제한 시간 안에 닫지 못했다')),
        STOP_TIMEOUT_MS
      )
      timer.unref?.()

      server.close((error) => finish(error ?? undefined))
      // close()만으로는 partial body와 keep-alive 연결을 기다린다. 앱을 닫는 순간에는
      // 진행 중 권한 요청도 이미 deny했으므로 연결을 즉시 끊는 것이 맞다.
      server.closeAllConnections()
    })
    // close callback으로 종료가 확인된 뒤에만 핸들을 놓는다. 실패하면 다음 stop()이
    // 같은 서버에 다시 closeAllConnections를 적용할 수 있어야 한다.
    if (this.server === server) this.server = null
  }
}
