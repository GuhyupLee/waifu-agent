import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import {
  AVATAR_PROTOCOL_VERSION,
  type AvatarCommand,
  type AvatarEvent,
  type AvatarHelloAck
} from '@shared/protocol'
import {
  CLOSE,
  FrameParser,
  OPCODE,
  WsProtocolError,
  acceptKey,
  encodeClose,
  encodeFrame,
  encodeText
} from './wsFrame'

/** 핸드셰이크 실패 사유. `AvatarHelloAck` 의 실패 분기와 같은 집합이다. */
type RejectReason = 'bad-token' | 'bad-version' | 'malformed'

/**
 * Unity Avatar Shell 이 붙는 로컬 WebSocket 서버.
 *
 * **`ControlServer` 와 일부러 분리했다.** 둘은 신뢰 경계가 다르다 — ControlServer 의
 * 클라이언트는 우리가 spawn 한 claude 의 자식들이고, 여기 클라이언트는 별도 프로세스인
 * Unity 다. 한 서버에 합치면 Unity 토큰으로 권한 승인 엔드포인트를 두드릴 수 있게 된다.
 *
 * 왜 HTTP 가 아니라 WebSocket 인가: ControlServer 는 요청 하나에 응답 하나면 됐지만
 * 여기는 **서버가 먼저 말을 건다.** 명령은 main 이 밀어넣고 이벤트는 Unity 가 올린다.
 *
 * 보안:
 *  - 127.0.0.1 에만 바인딩한다. `0.0.0.0` 이면 LAN 에 아바타 제어권이 열린다.
 *  - 포트는 0 으로 열어 OS 가 고르게 한다. 고정 포트는 충돌하고 예측 가능해진다.
 *  - 매 실행마다 새 토큰을 만든다. **첫 프레임이 인증이 아니면 끊는다.**
 *  - Unity 에는 포트와 토큰만 넘어간다. 모델 제공자 인증 정보·Discord 토큰·
 *    에이전트 권한은 이 경계를 넘지 않는다.
 */

export interface AvatarBridgeHandlers {
  /** Unity 가 올린 이벤트. 인증된 연결에서만 불린다. */
  onEvent?: (event: AvatarEvent) => void
  /** 인증까지 끝난 연결이 생겼다. */
  onConnect?: () => void
  /** 연결이 끊겼다. `reason` 은 로그용이다. */
  onDisconnect?: (reason: string) => void
  /** 연결 거절. 토큰·버전이 틀렸을 때 사용자에게 알릴 근거가 된다. */
  onReject?: (reason: string) => void
}

/** 인증 유예. 붙어놓고 아무 말도 안 하는 소켓을 영원히 들고 있지 않는다. */
const HELLO_TIMEOUT_MS = 10_000

export class AvatarBridgeServer {
  private server: Server | null = null
  private _port = 0
  private socket: Duplex | null = null
  private authed = false
  private seq = 0
  readonly token = randomBytes(24).toString('hex')

  constructor(private readonly handlers: AvatarBridgeHandlers = {}) {}

  get port(): number {
    return this._port
  }

  /** 인증까지 끝난 Unity 가 붙어 있는가. */
  get connected(): boolean {
    return this.authed && this.socket !== null
  }

  /** Unity 프로세스에 넘길 환경변수. `AVATAR_BRIDGE_ENV` 의 키와 짝을 이룬다. */
  childEnv(): Record<string, string> {
    return { WAIFU_AVATAR_PORT: String(this._port), WAIFU_AVATAR_TOKEN: this.token }
  }

  async start(): Promise<number> {
    if (this.server) return this._port

    // 평범한 HTTP 요청에는 응답하지 않는다. 이 서버의 유일한 입구는 upgrade 다.
    const server = createServer((_req, res) => res.writeHead(404).end())
    server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head))
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

  /**
   * 명령을 Unity 로 보낸다. 연결이 없으면 **조용히 버리고 false 를 돌려준다.**
   *
   * 큐에 쌓지 않는 이유: 아바타 명령은 대부분 그 순간에만 의미가 있다. 재연결 뒤에
   * 밀린 `say` 가 한꺼번에 쏟아지면 이상하게 보인다. 지금 못 보낸 건 못 보낸 것이다.
   */
  send(command: AvatarCommand): boolean {
    if (!this.socket || !this.authed) return false
    const frame = encodeText(
      JSON.stringify({ type: 'command', seq: ++this.seq, command })
    )
    return this.socket.write(frame)
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const key = req.headers['sec-websocket-key']
    const version = req.headers['sec-websocket-version']

    if (
      String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket' ||
      typeof key !== 'string' ||
      version !== '13'
    ) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }

    // 새 연결이 이긴다. Unity 를 재시작하면 옛 소켓이 아직 안 닫힌 채로 새 연결이
    // 붙는 경쟁이 실제로 생긴다. 거절하면 재시작이 영영 실패한다.
    if (this.socket) {
      this.closeSocket(this.socket, CLOSE.normal, 'replaced')
      this.handlers.onDisconnect?.('새 연결로 교체됨')
    }

    this.socket = socket
    this.authed = false
    this.seq = 0

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
    )

    this.attach(socket, head)
  }

  private attach(socket: Duplex, head: Buffer): void {
    const parser = new FrameParser()
    // upgrade 가 주는 타입은 Duplex 지만 실제로는 net.Socket 이다. 아바타 명령은 작고
    // 잦아서 Nagle 이 붙으면 표정과 말이 눈에 띄게 늦는다.
    if (socket instanceof Socket) socket.setNoDelay(true)

    const timer = setTimeout(() => {
      if (this.socket === socket && !this.authed) {
        this.reject(socket, 'malformed', '인증 시간 초과')
      }
    }, HELLO_TIMEOUT_MS)
    // 이 타이머가 이벤트 루프를 붙잡으면 앱이 종료되지 않는다.
    timer.unref?.()

    const feed = (chunk: Buffer): void => {
      let messages
      try {
        messages = parser.push(chunk)
      } catch (err) {
        const code = err instanceof WsProtocolError ? err.closeCode : CLOSE.protocolError
        this.fail(socket, code, `프레임 오류: ${(err as Error).message}`)
        return
      }

      for (const message of messages) {
        if (message.kind === 'close') {
          this.detach(socket, timer, `Unity 가 연결을 닫았다 (${message.code})`)
          this.closeSocket(socket, CLOSE.normal, '')
          return
        }
        if (message.kind === 'ping') {
          socket.write(encodeFrame(OPCODE.pong, message.data))
          continue
        }
        if (message.kind === 'pong') continue
        // 이 프로토콜은 전부 JSON 텍스트다. binary 는 약속에 없다.
        if (message.kind === 'binary') {
          this.fail(socket, CLOSE.protocolError, 'binary 프레임은 받지 않는다')
          return
        }
        if (!this.onText(socket, message.data, timer)) return
      }
    }

    // upgrade 와 함께 딸려온 첫 바이트를 흘리면 안 된다 — 여기에 hello 가 통째로
    // 들어있는 경우가 있다. 그러면 인증이 영원히 안 끝난 것처럼 보인다.
    if (head?.length) feed(head)

    socket.on('data', feed)
    socket.on('error', (err) => this.detach(socket, timer, `소켓 오류: ${err.message}`))
    socket.on('close', () => this.detach(socket, timer, '연결이 끊겼다'))
  }

  /** 텍스트 메시지 한 건. 계속 읽어도 되면 true. */
  private onText(socket: Duplex, raw: string, timer: NodeJS.Timeout): boolean {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // 인증 전이면 끊는다. 토큰을 모르는 쪽이 두드려보는 중일 수 있다.
      // 인증 후면 메시지 하나만 버린다 — 셸의 버그 때문에 연결까지 끊을 이유는 없다.
      if (!this.authed) {
        this.reject(socket, 'malformed', '깨진 JSON')
        return false
      }
      return true
    }

    if (!isPlainObject(parsed)) {
      if (!this.authed) {
        this.reject(socket, 'malformed', 'JSON 객체가 아니다')
        return false
      }
      return true
    }

    if (!this.authed) return this.handleHello(socket, parsed, timer)

    if (parsed.type === 'event' && isPlainObject(parsed.event)) {
      this.handlers.onEvent?.(parsed.event as unknown as AvatarEvent)
      return true
    }
    // 알 수 없는 타입은 무시한다. 프로토콜이 앞으로 늘어날 때 옛 main 이
    // 새 셸을 끊어버리면 곤란하다.
    return true
  }

  private handleHello(
    socket: Duplex,
    message: Record<string, unknown>,
    timer: NodeJS.Timeout
  ): boolean {
    // **첫 메시지는 반드시 hello 다.** 인증 전에 명령을 실행할 경로를 만들지 않는다.
    if (message.type !== 'hello') {
      this.reject(socket, 'malformed', `인증 전 메시지: ${String(message.type)}`)
      return false
    }
    if (typeof message.token !== 'string' || !this.tokenMatches(message.token)) {
      this.reject(socket, 'bad-token', '토큰 불일치')
      return false
    }
    if (message.protocolVersion !== AVATAR_PROTOCOL_VERSION) {
      this.reject(
        socket,
        'bad-version',
        `프로토콜 버전 불일치: 기대 ${AVATAR_PROTOCOL_VERSION}, 받음 ${String(message.protocolVersion)}`
      )
      return false
    }

    clearTimeout(timer)
    this.authed = true
    const ack: AvatarHelloAck = {
      type: 'hello-ack',
      ok: true,
      protocolVersion: AVATAR_PROTOCOL_VERSION
    }
    socket.write(encodeText(JSON.stringify(ack)))
    this.handlers.onConnect?.()
    return true
  }

  /** 길이가 다르면 timingSafeEqual 이 던진다. 토큰 길이는 고정이라 먼저 걸러도 안전하다. */
  private tokenMatches(given: string): boolean {
    const a = Buffer.from(given)
    const b = Buffer.from(this.token)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  /** 인증 실패. 이유를 알려주고 끊는다 — 무응답이면 셸이 원인을 알 수 없다. */
  private reject(socket: Duplex, reason: RejectReason, log: string): void {
    const ack: AvatarHelloAck = { type: 'hello-ack', ok: false, reason }
    try {
      socket.write(encodeText(JSON.stringify(ack)))
    } catch {
      // 이미 끊긴 소켓이면 알릴 방법이 없다. 로그만 남기고 넘어간다.
    }
    this.handlers.onReject?.(log)
    this.closeSocket(socket, CLOSE.policyViolation, reason)
    if (this.socket === socket) {
      this.socket = null
      this.authed = false
    }
  }

  private fail(socket: Duplex, code: number, log: string): void {
    const wasAuthed = this.authed
    this.closeSocket(socket, code, '')
    if (this.socket === socket) {
      this.socket = null
      this.authed = false
    }
    if (wasAuthed) this.handlers.onDisconnect?.(log)
    else this.handlers.onReject?.(log)
  }

  private detach(socket: Duplex, timer: NodeJS.Timeout, reason: string): void {
    clearTimeout(timer)
    if (this.socket !== socket) return
    const wasAuthed = this.authed
    this.socket = null
    this.authed = false
    if (wasAuthed) this.handlers.onDisconnect?.(reason)
  }

  /**
   * close 프레임을 흘려보낸 뒤 끊는다.
   *
   * `write` 직후 `destroy` 하면 버퍼가 버려질 수 있다 — 그러면 거절 사유가 Unity 에
   * 닿지 않고, 셸은 토큰이 틀린 건지 앱이 죽은 건지 구분하지 못한 채 재시도한다.
   * `end` 는 flush 후 FIN 을 보낸다.
   */
  private closeSocket(socket: Duplex, code: number, reason: string): void {
    try {
      socket.end(encodeClose(code, reason))
    } catch {
      socket.destroy()
      return
    }
    // 상대가 close 를 되돌려주지 않아도 소켓을 영원히 붙잡지 않는다.
    const timer = setTimeout(() => socket.destroy(), 1000)
    timer.unref?.()
    socket.once('close', () => clearTimeout(timer))
  }

  async stop(): Promise<void> {
    const server = this.server
    const socket = this.socket
    this.server = null
    this.socket = null
    this.authed = false

    if (socket) this.closeSocket(socket, CLOSE.normal, 'shutdown')
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

