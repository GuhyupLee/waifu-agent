import { createHash } from 'node:crypto'

/**
 * RFC 6455 프레이밍. 소켓을 모른다 — 바이트만 다룬다.
 *
 * 왜 직접 짜는가: node 에 WebSocket **클라이언트**는 전역으로 있지만 **서버**는 없다.
 * `ws` 는 선택적 네이티브 가속기(bufferutil, utf-8-validate)를 정적 import 로 끌어와
 * 이미 한 번 앱을 죽인 전력이 있다 (`control/server.ts` 의 같은 주석 참고).
 * 여기는 루프백·단일 클라이언트라 필요한 범위가 좁고, 소켓에서 떼어내면 전부
 * 순수 함수로 테스트할 수 있다.
 *
 * 상대는 Unity 의 `System.Net.WebSockets.ClientWebSocket` — 표준 구현이다.
 * 그래서 "우리끼리만 통하는" 지름길을 쓰면 안 된다. 마스킹과 close 핸드셰이크를
 * 규격대로 지켜야 한다.
 */

/** RFC 6455 §1.3 의 고정 GUID. 핸드셰이크 응답 키를 만드는 데만 쓴다. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa
} as const

/**
 * 한 메시지의 상한. 아바타 명령은 자막과 viseme 트랙이 제일 큰데도 수십 KB 다.
 *
 * 상한이 없으면 길이 필드에 2^63 을 적어 보내는 것만으로 메모리를 고갈시킬 수 있다.
 * 토큰을 가진 클라이언트만 여기까지 오지만, 그건 버그난 Unity 도 마찬가지다.
 */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024

/** close 코드. 끊는 이유를 상대가 알 수 있어야 재연결 로직이 판단할 수 있다. */
export const CLOSE = {
  normal: 1000,
  protocolError: 1002,
  invalidPayload: 1007,
  policyViolation: 1008,
  tooLarge: 1009
} as const

export class WsProtocolError extends Error {
  constructor(
    message: string,
    readonly closeCode: number = CLOSE.protocolError
  ) {
    super(message)
    this.name = 'WsProtocolError'
  }
}

export type WsMessage =
  | { kind: 'text'; data: string }
  | { kind: 'binary'; data: Buffer }
  | { kind: 'ping'; data: Buffer }
  | { kind: 'pong'; data: Buffer }
  | { kind: 'close'; code: number; reason: string }

/** `Sec-WebSocket-Key` 에 대한 `Sec-WebSocket-Accept` 값. */
export function acceptKey(key: string): string {
  return createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64')
}

/**
 * 서버 -> 클라이언트 프레임. **마스킹하지 않는다** (RFC 6455 §5.1).
 * 서버가 마스킹해서 보내면 규격 준수 클라이언트는 연결을 끊는다.
 */
export function encodeFrame(opcode: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const len = payload.length
  let header: Buffer

  if (len < 126) {
    header = Buffer.alloc(2)
    header[1] = len
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  // FIN=1. 우리는 메시지를 쪼개 보내지 않는다 — 받는 쪽 조립 코드가 한 겹 줄어든다.
  header[0] = 0x80 | opcode

  return Buffer.concat([header, payload])
}

export function encodeText(text: string): Buffer {
  return encodeFrame(OPCODE.text, Buffer.from(text, 'utf8'))
}

export function encodeClose(code: number, reason = ''): Buffer {
  const body = Buffer.alloc(2 + Buffer.byteLength(reason, 'utf8'))
  body.writeUInt16BE(code, 0)
  body.write(reason, 2, 'utf8')
  return encodeFrame(OPCODE.close, body)
}

/**
 * 바이트 스트림에서 메시지를 뽑아낸다.
 *
 * **chunk 경계가 프레임 경계와 무관하다는 게 핵심이다.** TCP 는 우리가 write 한 단위를
 * 지켜주지 않는다 — 헤더 2바이트가 두 chunk 에 걸쳐 오는 일이 실제로 생긴다.
 * 그래서 파서는 상태를 들고 있고, 완성된 프레임이 나올 때까지 버퍼에 쌓아둔다.
 * (`claudeCode.ts` 의 NDJSON 파서가 같은 이유로 부분 라인을 다룬다.)
 */
export class FrameParser {
  private buf: Buffer = Buffer.alloc(0)
  private fragments: Buffer[] = []
  private fragmentOpcode = 0
  private fragmentBytes = 0

  constructor(
    /** 서버는 클라이언트 프레임이 마스킹돼 있기를 **요구한다** (RFC 6455 §5.1). */
    private readonly requireMask = true,
    private readonly maxMessageBytes = MAX_MESSAGE_BYTES
  ) {}

  /** 던지는 예외는 전부 `WsProtocolError` 다. 호출자는 closeCode 로 끊으면 된다. */
  push(chunk: Buffer): WsMessage[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])

    const out: WsMessage[] = []
    for (;;) {
      const frame = this.readFrame()
      if (!frame) break
      const message = this.accept(frame)
      if (message) out.push(message)
    }
    return out
  }

  /** 프레임 하나를 떼어낸다. 아직 다 안 왔으면 null — 버퍼는 그대로 둔다. */
  private readFrame(): { fin: boolean; opcode: number; payload: Buffer } | null {
    const buf = this.buf
    if (buf.length < 2) return null

    // 인덱스 접근은 `noUncheckedIndexedAccess` 때문에 undefined 가 섞인다.
    // 길이는 위에서 이미 확인했으므로 readUInt8 로 number 를 직접 받는다.
    const b0 = buf.readUInt8(0)
    const b1 = buf.readUInt8(1)

    // RSV1-3 은 확장 협상을 했을 때만 쓴다. 우리는 확장을 협상하지 않으므로 0 이어야 한다.
    if ((b0 & 0x70) !== 0) throw new WsProtocolError('RSV 비트가 설정됐다')

    const fin = (b0 & 0x80) !== 0
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    const isControl = (opcode & 0x08) !== 0

    // 제어 프레임은 쪼갤 수 없고 125바이트를 넘을 수 없다 (§5.5).
    // 이걸 검사하지 않으면 close 프레임 하나로 조립 버퍼를 부풀릴 수 있다.
    if (isControl && !fin) throw new WsProtocolError('제어 프레임은 분할할 수 없다')

    let len = b1 & 0x7f
    if (isControl && len > 125) throw new WsProtocolError('제어 프레임이 125바이트를 넘는다')

    let offset = 2
    if (len === 126) {
      if (buf.length < 4) return null
      len = buf.readUInt16BE(2)
      offset = 4
    } else if (len === 127) {
      if (buf.length < 10) return null
      const big = buf.readBigUInt64BE(2)
      // 길이를 먼저 검사한다. Number 로 바꾼 뒤 할당을 시도하면 이미 늦다.
      if (big > BigInt(this.maxMessageBytes)) {
        throw new WsProtocolError('프레임이 상한을 넘는다', CLOSE.tooLarge)
      }
      len = Number(big)
      offset = 10
    }

    if (len > this.maxMessageBytes) {
      throw new WsProtocolError('프레임이 상한을 넘는다', CLOSE.tooLarge)
    }

    if (this.requireMask && !masked) {
      throw new WsProtocolError('클라이언트 프레임이 마스킹되지 않았다')
    }

    let maskKey: Buffer | null = null
    if (masked) {
      if (buf.length < offset + 4) return null
      maskKey = buf.subarray(offset, offset + 4)
      offset += 4
    }

    if (buf.length < offset + len) return null

    // subarray 는 원본 메모리를 공유한다. 아래에서 this.buf 를 잘라내도 살아남도록 복사한다.
    const payload = Buffer.from(buf.subarray(offset, offset + len))
    if (maskKey) {
      for (let i = 0; i < payload.length; i++) {
        payload.writeUInt8(payload.readUInt8(i) ^ maskKey.readUInt8(i & 3), i)
      }
    }

    this.buf = buf.subarray(offset + len)
    return { fin, opcode, payload }
  }

  /** 프레임을 메시지로 조립한다. 아직 안 끝났으면 null. */
  private accept(frame: {
    fin: boolean
    opcode: number
    payload: Buffer
  }): WsMessage | null {
    const { fin, opcode, payload } = frame

    // 제어 프레임은 조립 중인 메시지 **사이에 끼어들 수 있다** (§5.4).
    // 그래서 조각 상태를 건드리지 않고 그대로 흘려보낸다.
    if (opcode === OPCODE.close) return decodeClose(payload)
    if (opcode === OPCODE.ping) return { kind: 'ping', data: payload }
    if (opcode === OPCODE.pong) return { kind: 'pong', data: payload }

    if (opcode === OPCODE.continuation) {
      if (this.fragments.length === 0) {
        throw new WsProtocolError('이어질 메시지가 없는데 continuation 이 왔다')
      }
    } else if (opcode === OPCODE.text || opcode === OPCODE.binary) {
      if (this.fragments.length > 0) {
        throw new WsProtocolError('조립 중인 메시지가 있는데 새 메시지가 시작됐다')
      }
      this.fragmentOpcode = opcode
    } else {
      throw new WsProtocolError(`알 수 없는 opcode: ${opcode}`)
    }

    this.fragmentBytes += payload.length
    // 조각을 합친 총량도 상한을 넘으면 안 된다. 프레임마다 통과시켜도
    // 무한히 이어붙이면 같은 결과가 된다.
    if (this.fragmentBytes > this.maxMessageBytes) {
      throw new WsProtocolError('메시지가 상한을 넘는다', CLOSE.tooLarge)
    }
    this.fragments.push(payload)

    if (!fin) return null

    const data = Buffer.concat(this.fragments)
    const kind = this.fragmentOpcode === OPCODE.text ? 'text' : 'binary'
    this.fragments = []
    this.fragmentBytes = 0

    if (kind === 'binary') return { kind: 'binary', data }

    // 규격상 text 는 유효한 UTF-8 이어야 한다. node 의 toString 은 깨진 바이트를
    // U+FFFD 로 바꿔 조용히 통과시키므로, 왕복시켜 실제로 깨졌는지 확인한다.
    const text = data.toString('utf8')
    if (!Buffer.from(text, 'utf8').equals(data)) {
      throw new WsProtocolError('text 프레임이 유효한 UTF-8 이 아니다', CLOSE.invalidPayload)
    }
    return { kind: 'text', data: text }
  }
}

function decodeClose(payload: Buffer): WsMessage {
  // 빈 페이로드는 "상태 코드 없음" 이다. 1005 는 실제로 전송되면 안 되는 코드라
  // 여기서 만들어 쓰기만 하고 되돌려 보내지 않는다.
  if (payload.length === 0) return { kind: 'close', code: 1005, reason: '' }
  if (payload.length === 1) throw new WsProtocolError('close 페이로드가 1바이트다')
  return {
    kind: 'close',
    code: payload.readUInt16BE(0),
    reason: payload.subarray(2).toString('utf8')
  }
}
