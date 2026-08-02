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

export class ControlServer {
  private server: Server | null = null
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

    const server = createServer((req, res) => void this.onRequest(req, res))
    // 권한 승인은 사용자가 누를 때까지 응답을 붙잡고 있다. 기본 5분 제한에 걸리면
    // 사용자가 자리를 비운 사이 요청이 끊긴다.
    server.requestTimeout = 0
    server.headersTimeout = 0
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
    req.setEncoding('utf8')
    for await (const chunk of req) body += chunk

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

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
