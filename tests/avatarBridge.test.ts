import { afterEach, describe, expect, it, vi } from 'vitest'
import { AVATAR_PROTOCOL_VERSION, type AvatarEvent } from '@shared/protocol'
import { AvatarBridgeServer, type AvatarBridgeHandlers } from '../src/main/avatar/bridge'

/**
 * mock Unity 클라이언트로 브리지를 두드린다.
 *
 * node 24 의 **전역 WebSocket** 을 그대로 쓴다. 직접 짠 클라이언트로 테스트하면 우리
 * 구현의 실수를 그대로 흉내내서 통과해버린다. 표준 구현을 상대로 세워야 Unity 의
 * `ClientWebSocket` 과 실제로 통한다는 근거가 된다.
 */

const running = new Set<AvatarBridgeServer>()
const openSockets = new Set<WebSocket>()

async function start(handlers: AvatarBridgeHandlers = {}): Promise<{
  server: AvatarBridgeServer
  port: number
}> {
  const server = new AvatarBridgeServer(handlers)
  running.add(server)
  return { server, port: await server.start() }
}

function connect(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  openSockets.add(ws)
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(ws), { once: true })
    ws.addEventListener('error', () => reject(new Error('연결 실패')), { once: true })
  })
}

/** 다음 텍스트 메시지 하나를 JSON 으로 받는다. */
function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('메시지 대기 시간 초과')), 3000)
    ws.addEventListener(
      'message',
      (event) => {
        clearTimeout(timer)
        resolve(JSON.parse(String((event as MessageEvent).data)))
      },
      { once: true }
    )
  })
}

function closed(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('close 대기 시간 초과')), 3000)
    ws.addEventListener(
      'close',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })
}

function hello(token: string, protocolVersion = AVATAR_PROTOCOL_VERSION): string {
  return JSON.stringify({ type: 'hello', token, protocolVersion, client: 'unity' })
}

/** 이벤트 루프를 한 바퀴 돌려 서버가 프레임을 처리할 틈을 준다. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60))

afterEach(async () => {
  for (const ws of openSockets) {
    if (ws.readyState === WebSocket.OPEN) ws.close()
  }
  openSockets.clear()
  await Promise.all([...running].map((server) => server.stop()))
  running.clear()
})

describe('브리지 경계', () => {
  it('127.0.0.1 에만 열리고 임의 포트를 쓴다', async () => {
    const { port } = await start()
    expect(port).toBeGreaterThan(0)

    // IPv6 루프백으로는 붙지 못해야 한다. `0.0.0.0` 이면 LAN 에 아바타 제어권이 열린다.
    const ws = new WebSocket(`ws://[::1]:${port}`)
    openSockets.add(ws)
    await expect(
      new Promise((_resolve, reject) => {
        ws.addEventListener('open', () => reject(new Error('열리면 안 된다')), { once: true })
        ws.addEventListener('error', () => reject(new Error('거부됨')), { once: true })
        ws.addEventListener('close', () => reject(new Error('거부됨')), { once: true })
      })
    ).rejects.toThrow('거부됨')
  })

  it('Unity 에 넘기는 환경변수는 포트와 토큰뿐이다', async () => {
    const { server, port } = await start()
    const env = server.childEnv()

    // 모델 제공자 인증 정보·Discord 토큰·권한은 이 경계를 넘지 않는다.
    expect(Object.keys(env).sort()).toEqual(['WAIFU_AVATAR_PORT', 'WAIFU_AVATAR_TOKEN'])
    expect(env.WAIFU_AVATAR_PORT).toBe(String(port))
    expect(env.WAIFU_AVATAR_TOKEN).toMatch(/^[0-9a-f]{48}$/)
  })

  it('평범한 HTTP 요청에는 응답하지 않는다', async () => {
    const { port } = await start()
    const response = await fetch(`http://127.0.0.1:${port}/`)
    expect(response.status).toBe(404)
  })
})

describe('핸드셰이크', () => {
  it('정상 토큰이면 ack 를 주고 연결을 유지한다', async () => {
    const onConnect = vi.fn()
    const { server, port } = await start({ onConnect })
    const ws = await connect(port)

    ws.send(hello(server.token))
    expect(await nextMessage(ws)).toEqual({
      type: 'hello-ack',
      ok: true,
      protocolVersion: AVATAR_PROTOCOL_VERSION
    })

    await settle()
    expect(onConnect).toHaveBeenCalledTimes(1)
    expect(server.connected).toBe(true)
    expect(ws.readyState).toBe(WebSocket.OPEN)
  })

  it('잘못된 토큰은 사유를 알려주고 끊는다', async () => {
    const onConnect = vi.fn()
    const onReject = vi.fn()
    const { port } = await start({ onConnect, onReject })
    const ws = await connect(port)

    ws.send(hello('f'.repeat(48)))
    // 무응답으로 끊으면 셸이 토큰 문제인지 앱이 죽은 건지 구분할 수 없다.
    expect(await nextMessage(ws)).toEqual({
      type: 'hello-ack',
      ok: false,
      reason: 'bad-token'
    })

    await closed(ws)
    expect(onConnect).not.toHaveBeenCalled()
    expect(onReject).toHaveBeenCalledTimes(1)
  })

  it('길이가 다른 토큰도 예외 없이 거절한다', async () => {
    // timingSafeEqual 은 길이가 다르면 던진다. 먼저 걸러내지 않으면 서버가 죽는다.
    const { port } = await start()
    const ws = await connect(port)

    ws.send(hello('짧음'))
    expect(await nextMessage(ws)).toMatchObject({ ok: false, reason: 'bad-token' })
    await closed(ws)
  })

  it('protocolVersion 이 다르면 끊는다', async () => {
    const onConnect = vi.fn()
    const { server, port } = await start({ onConnect })
    const ws = await connect(port)

    ws.send(hello(server.token, AVATAR_PROTOCOL_VERSION + 1))
    expect(await nextMessage(ws)).toEqual({
      type: 'hello-ack',
      ok: false,
      reason: 'bad-version'
    })

    await closed(ws)
    expect(onConnect).not.toHaveBeenCalled()
    expect(server.connected).toBe(false)
  })

  it('인증 전에 보낸 명령은 실행되지 않고 연결이 끊긴다', async () => {
    // 이게 통과하면 토큰은 장식이다. 같은 머신의 아무 프로세스나 아바타를 조종한다.
    const onEvent = vi.fn()
    const onConnect = vi.fn()
    const { port } = await start({ onEvent, onConnect })
    const ws = await connect(port)

    ws.send(JSON.stringify({ type: 'event', event: { type: 'clicked' } }))
    expect(await nextMessage(ws)).toEqual({
      type: 'hello-ack',
      ok: false,
      reason: 'malformed'
    })

    await closed(ws)
    expect(onEvent).not.toHaveBeenCalled()
    expect(onConnect).not.toHaveBeenCalled()
  })

  it('인증 전 깨진 JSON 은 끊는다', async () => {
    const { port } = await start()
    const ws = await connect(port)

    ws.send('{')
    expect(await nextMessage(ws)).toMatchObject({ ok: false, reason: 'malformed' })
    await closed(ws)
  })

  it('인증 전 JSON 배열도 거절한다', async () => {
    const { port } = await start()
    const ws = await connect(port)

    ws.send('[1,2,3]')
    expect(await nextMessage(ws)).toMatchObject({ ok: false, reason: 'malformed' })
    await closed(ws)
  })
})

describe('인증 후 메시지', () => {
  async function authed(handlers: AvatarBridgeHandlers = {}): Promise<{
    server: AvatarBridgeServer
    ws: WebSocket
  }> {
    const { server, port } = await start(handlers)
    const ws = await connect(port)
    ws.send(hello(server.token))
    await nextMessage(ws)
    return { server, ws }
  }

  it('이벤트가 main 으로 올라온다', async () => {
    const onEvent = vi.fn()
    const { ws } = await authed({ onEvent })

    const event: AvatarEvent = { type: 'model-loaded', ok: false, error: '파일 없음' }
    ws.send(JSON.stringify({ type: 'event', event }))
    await settle()

    expect(onEvent).toHaveBeenCalledWith(event)
  })

  it('명령은 seq 가 1부터 순서대로 올라간다', async () => {
    const { server, ws } = await authed()

    const first = nextMessage(ws)
    expect(server.send({ type: 'status', state: 'thinking' })).toBe(true)
    expect(await first).toEqual({
      type: 'command',
      seq: 1,
      command: { type: 'status', state: 'thinking' }
    })

    const second = nextMessage(ws)
    server.send({ type: 'set-scale', scale: 1.5 })
    expect(await second).toMatchObject({ seq: 2 })
  })

  it('깨진 JSON 은 그 메시지만 버리고 연결을 유지한다', async () => {
    // 셸의 버그 하나로 연결까지 끊으면 아바타가 통째로 사라진다.
    const onEvent = vi.fn()
    const onDisconnect = vi.fn()
    const { ws } = await authed({ onEvent, onDisconnect })

    ws.send('{ 깨짐')
    await settle()
    expect(onDisconnect).not.toHaveBeenCalled()
    expect(ws.readyState).toBe(WebSocket.OPEN)

    ws.send(JSON.stringify({ type: 'event', event: { type: 'clicked' } }))
    await settle()
    expect(onEvent).toHaveBeenCalledWith({ type: 'clicked' })
  })

  it('알 수 없는 메시지 타입은 무시하고 연결을 유지한다', async () => {
    // 프로토콜이 늘어날 때 옛 main 이 새 셸을 끊어버리면 곤란하다.
    const onEvent = vi.fn()
    const onDisconnect = vi.fn()
    const { ws } = await authed({ onEvent, onDisconnect })

    ws.send(JSON.stringify({ type: '앞으로 생길 메시지', payload: 1 }))
    await settle()

    expect(onDisconnect).not.toHaveBeenCalled()
    expect(onEvent).not.toHaveBeenCalled()
    expect(ws.readyState).toBe(WebSocket.OPEN)
  })

  it('binary 프레임은 약속에 없으므로 끊는다', async () => {
    const onDisconnect = vi.fn()
    const { ws } = await authed({ onDisconnect })

    ws.send(new Uint8Array([1, 2, 3]))
    await closed(ws)
    expect(onDisconnect).toHaveBeenCalledTimes(1)
  })
})

describe('연결 수명', () => {
  it('연결이 없으면 send 는 false 를 돌려주고 큐에 쌓지 않는다', async () => {
    const { server } = await start()
    // 재연결 뒤 밀린 say 가 한꺼번에 쏟아지면 이상하게 보인다. 지금 못 보낸 건 못 보낸 것이다.
    expect(server.send({ type: 'status', state: 'idle' })).toBe(false)
    expect(server.connected).toBe(false)
  })

  it('Unity 가 끊으면 알리고, 다시 붙으면 이어서 동작한다', async () => {
    const onConnect = vi.fn()
    const onDisconnect = vi.fn()
    const { server, port } = await start({ onConnect, onDisconnect })

    const first = await connect(port)
    first.send(hello(server.token))
    await nextMessage(first)
    expect(server.connected).toBe(true)

    first.close()
    await closed(first)
    await settle()
    expect(onDisconnect).toHaveBeenCalledTimes(1)
    expect(server.connected).toBe(false)
    expect(server.send({ type: 'status', state: 'idle' })).toBe(false)

    const second = await connect(port)
    second.send(hello(server.token))
    await nextMessage(second)
    await settle()

    expect(onConnect).toHaveBeenCalledTimes(2)
    expect(server.connected).toBe(true)

    // 재연결이면 seq 도 1부터 다시 센다 — 셸이 새로 뜬 것이므로 이어붙일 상태가 없다.
    const command = nextMessage(second)
    server.send({ type: 'stop-speaking' })
    expect(await command).toMatchObject({ seq: 1 })
  })

  it('새 연결이 옛 연결을 밀어낸다', async () => {
    // Unity 재시작 때 옛 소켓이 아직 안 닫힌 채로 새 연결이 붙는 경쟁이 실제로 생긴다.
    // 새 쪽을 거절하면 재시작이 영영 실패한다.
    const { server, port } = await start()

    const old = await connect(port)
    old.send(hello(server.token))
    await nextMessage(old)

    const fresh = await connect(port)
    fresh.send(hello(server.token))
    await nextMessage(fresh)

    await closed(old)
    expect(server.connected).toBe(true)

    const command = nextMessage(fresh)
    server.send({ type: 'express', emotion: 'happy' })
    expect(await command).toMatchObject({
      command: { type: 'express', emotion: 'happy' }
    })
  })

  it('stop 은 붙어 있던 연결을 닫는다', async () => {
    const { server, port } = await start()
    const ws = await connect(port)
    ws.send(hello(server.token))
    await nextMessage(ws)

    await server.stop()
    await closed(ws)
    expect(server.connected).toBe(false)
  })
})
