import { describe, expect, it } from 'vitest'
import {
  CLOSE,
  FrameParser,
  MAX_MESSAGE_BYTES,
  OPCODE,
  WsProtocolError,
  acceptKey,
  encodeClose,
  encodeFrame,
  encodeText
} from '../src/main/avatar/wsFrame'

/** 클라이언트가 보내는 프레임. 규격상 **반드시** 마스킹돼 있다. */
function clientFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const mask = Buffer.from([0x37, 0xfa, 0x21, 0x3d])
  const masked = Buffer.from(payload)
  for (let i = 0; i < masked.length; i++) {
    masked.writeUInt8(masked.readUInt8(i) ^ mask.readUInt8(i & 3), i)
  }

  const len = payload.length
  let header: Buffer
  if (len < 126) {
    header = Buffer.alloc(2)
    header[1] = 0x80 | len
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[1] = 0x80 | 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  header[0] = (fin ? 0x80 : 0) | opcode
  return Buffer.concat([header, mask, masked])
}

function clientText(text: string, fin = true): Buffer {
  return clientFrame(OPCODE.text, Buffer.from(text, 'utf8'), fin)
}

describe('핸드셰이크 키', () => {
  it('RFC 6455 예제 벡터와 일치한다', () => {
    // 규격 §1.3 의 예제. 우리 구현이 표준 클라이언트와 통하는지 보는 가장 싼 확인이다.
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  })
})

describe('서버 -> 클라이언트 인코딩', () => {
  it('서버 프레임은 마스킹하지 않는다', () => {
    // 서버가 마스킹해서 보내면 규격 준수 클라이언트가 연결을 끊는다.
    const frame = encodeText('안녕')
    expect(frame.readUInt8(1) & 0x80).toBe(0)
  })

  it('길이 구간마다 헤더 크기가 달라진다', () => {
    const small = encodeFrame(OPCODE.binary, Buffer.alloc(125))
    expect(small.length).toBe(2 + 125)
    expect(small.readUInt8(1) & 0x7f).toBe(125)

    const medium = encodeFrame(OPCODE.binary, Buffer.alloc(126))
    expect(medium.readUInt8(1) & 0x7f).toBe(126)
    expect(medium.readUInt16BE(2)).toBe(126)
    expect(medium.length).toBe(4 + 126)

    const large = encodeFrame(OPCODE.binary, Buffer.alloc(70000))
    expect(large.readUInt8(1) & 0x7f).toBe(127)
    expect(large.readBigUInt64BE(2)).toBe(70000n)
    expect(large.length).toBe(10 + 70000)
  })

  it('close 는 코드와 사유를 싣는다', () => {
    const frame = encodeClose(CLOSE.policyViolation, 'bad-token')
    expect(frame.readUInt8(0)).toBe(0x80 | OPCODE.close)
    expect(frame.readUInt16BE(2)).toBe(1008)
    expect(frame.subarray(4).toString('utf8')).toBe('bad-token')
  })
})

describe('클라이언트 -> 서버 파싱', () => {
  it('마스킹된 텍스트를 원문으로 되돌린다', () => {
    const parser = new FrameParser()
    expect(parser.push(clientText('{"type":"hello"}'))).toEqual([
      { kind: 'text', data: '{"type":"hello"}' }
    ])
  })

  it('한 번에 여러 프레임이 와도 순서대로 다 뽑는다', () => {
    const parser = new FrameParser()
    const messages = parser.push(Buffer.concat([clientText('첫째'), clientText('둘째')]))
    expect(messages).toEqual([
      { kind: 'text', data: '첫째' },
      { kind: 'text', data: '둘째' }
    ])
  })

  it('바이트 하나씩 쪼개 넣어도 결과가 같다', () => {
    // TCP 는 우리가 write 한 단위를 지켜주지 않는다. 헤더 2바이트가 두 chunk 에
    // 걸쳐 오는 상황이 실제로 생기고, 그때 파서가 무너지면 안 된다.
    const frame = clientText('경계를 넘는 메시지')
    const parser = new FrameParser()

    const collected = []
    for (const byte of frame) collected.push(...parser.push(Buffer.from([byte])))

    expect(collected).toEqual([{ kind: 'text', data: '경계를 넘는 메시지' }])
  })

  it('분할된 메시지를 이어붙인다', () => {
    const parser = new FrameParser()
    expect(parser.push(clientFrame(OPCODE.text, Buffer.from('앞'), false))).toEqual([])
    const done = parser.push(clientFrame(OPCODE.continuation, Buffer.from('뒤'), true))
    expect(done).toEqual([{ kind: 'text', data: '앞뒤' }])
  })

  it('조립 중에 끼어든 제어 프레임은 조각을 망가뜨리지 않는다', () => {
    // 규격 §5.4 가 명시적으로 허용하는 순서다. ping 때문에 조각이 깨지면
    // 큰 메시지를 보내는 도중 keepalive 만으로 연결이 죽는다.
    const parser = new FrameParser()
    parser.push(clientFrame(OPCODE.text, Buffer.from('앞'), false))

    const ping = parser.push(clientFrame(OPCODE.ping, Buffer.from('hi')))
    expect(ping).toEqual([{ kind: 'ping', data: Buffer.from('hi') }])

    const done = parser.push(clientFrame(OPCODE.continuation, Buffer.from('뒤'), true))
    expect(done).toEqual([{ kind: 'text', data: '앞뒤' }])
  })

  it('close 의 코드와 사유를 읽는다', () => {
    const body = Buffer.alloc(2 + 4)
    body.writeUInt16BE(1000, 0)
    body.write('done', 2, 'utf8')

    const parser = new FrameParser()
    expect(parser.push(clientFrame(OPCODE.close, body))).toEqual([
      { kind: 'close', code: 1000, reason: 'done' }
    ])
  })

  it('빈 close 는 "상태 코드 없음"(1005)이 된다', () => {
    const parser = new FrameParser()
    expect(parser.push(clientFrame(OPCODE.close, Buffer.alloc(0)))).toEqual([
      { kind: 'close', code: 1005, reason: '' }
    ])
  })
})

describe('파싱 거절', () => {
  it('마스킹되지 않은 클라이언트 프레임을 거절한다', () => {
    // 서버가 이걸 받아주면 규격을 모르는 구현이 붙을 수 있게 되고,
    // 프록시가 프레임을 캐시하는 공격 표면이 열린다.
    const parser = new FrameParser()
    expect(() => parser.push(encodeText('마스킹 없음'))).toThrow(WsProtocolError)
  })

  it('RSV 비트가 켜져 있으면 거절한다', () => {
    const frame = clientText('x')
    frame.writeUInt8(frame.readUInt8(0) | 0x40, 0)
    expect(() => new FrameParser().push(frame)).toThrow(/RSV/)
  })

  it('제어 프레임은 분할할 수 없다', () => {
    const parser = new FrameParser()
    expect(() => parser.push(clientFrame(OPCODE.ping, Buffer.from('x'), false))).toThrow(
      /분할/
    )
  })

  it('125바이트를 넘는 제어 프레임을 거절한다', () => {
    const parser = new FrameParser()
    expect(() => parser.push(clientFrame(OPCODE.ping, Buffer.alloc(126)))).toThrow(/125/)
  })

  it('이어질 메시지가 없는 continuation 을 거절한다', () => {
    const parser = new FrameParser()
    expect(() => parser.push(clientFrame(OPCODE.continuation, Buffer.from('x')))).toThrow(
      /continuation/
    )
  })

  it('조립 중에 새 메시지가 시작되면 거절한다', () => {
    const parser = new FrameParser()
    parser.push(clientText('앞', false))
    expect(() => parser.push(clientText('새로'))).toThrow(/조립 중/)
  })

  it('알 수 없는 opcode 를 거절한다', () => {
    const parser = new FrameParser()
    expect(() => parser.push(clientFrame(0x3, Buffer.from('x')))).toThrow(/opcode/)
  })

  it('상한을 넘는 길이는 할당 전에 끊는다', () => {
    // 실제로 그만큼 보내지 않아도 길이 필드만으로 메모리를 요구할 수 있다.
    // 헤더 10바이트만 넣고도 거절되는지가 핵심이다.
    const header = Buffer.alloc(14)
    header[0] = 0x80 | OPCODE.text
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(MAX_MESSAGE_BYTES) + 1n, 2)

    const parser = new FrameParser()
    let thrown: unknown
    try {
      parser.push(header)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(WsProtocolError)
    expect((thrown as WsProtocolError).closeCode).toBe(CLOSE.tooLarge)
  })

  it('조각을 이어붙여 상한을 넘기는 것도 막는다', () => {
    // 프레임 하나하나는 작아도 무한히 이어붙이면 결과는 같다.
    const parser = new FrameParser(true, 64)
    parser.push(clientFrame(OPCODE.text, Buffer.alloc(40), false))
    expect(() => parser.push(clientFrame(OPCODE.continuation, Buffer.alloc(40), false))).toThrow(
      /상한/
    )
  })

  it('깨진 UTF-8 text 를 거절한다', () => {
    // node 의 toString 은 깨진 바이트를 U+FFFD 로 바꿔 조용히 통과시킨다.
    const parser = new FrameParser()
    expect(() => parser.push(clientFrame(OPCODE.text, Buffer.from([0xff, 0xfe])))).toThrow(
      /UTF-8/
    )
  })
})
