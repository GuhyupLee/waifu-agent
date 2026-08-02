import { afterEach, describe, expect, it, vi } from 'vitest'
import { ControlServer } from '../src/main/control/server'

const running = new Set<ControlServer>()

async function start(handler = vi.fn(() => ({ accepted: true }))): Promise<{
  server: ControlServer
  port: number
  handler: typeof handler
}> {
  const server = new ControlServer(handler)
  running.add(server)
  const port = await server.start()
  return { server, port, handler }
}

afterEach(async () => {
  await Promise.all([...running].map((server) => server.stop()))
  running.clear()
})

describe('ControlServer localhost 경계', () => {
  it('127.0.0.1에서는 열리지만 IPv6 전체 인터페이스에는 열리지 않는다', async () => {
    const { port } = await start()
    const local = await fetch(`http://127.0.0.1:${port}/`)
    expect(local.status).toBe(401)

    await expect(
      fetch(`http://[::1]:${port}/`, { signal: AbortSignal.timeout(500) })
    ).rejects.toThrow()
  })

  it('자식 환경에는 실제 임의 포트와 48자리 토큰만 준다', async () => {
    const { server, port } = await start()
    const env = server.childEnv()
    expect(env.WAIFU_CONTROL_PORT).toBe(String(port))
    expect(env.WAIFU_CONTROL_TOKEN).toMatch(/^[0-9a-f]{48}$/)
  })
})

describe('ControlServer 요청 인증과 응답', () => {
  it('토큰이 없거나 틀리면 본문 없이 401이고 handler를 부르지 않는다', async () => {
    const { server, port, handler } = await start()
    for (const headers of [{}, { 'x-waifu-token': 'wrong' }]) {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: 'request-1', tool: 'waifu_say', args: {} })
      })
      expect(response.status).toBe(401)
      expect(await response.text()).toBe('')
    }
    expect(handler).not.toHaveBeenCalled()
    expect(server.token).not.toBe('wrong')
  })

  it('인증돼도 POST가 아니면 405, 깨진 JSON이면 400이다', async () => {
    const { server, port, handler } = await start()
    const headers = { 'x-waifu-token': server.token }

    const get = await fetch(`http://127.0.0.1:${port}/`, { headers })
    expect(get.status).toBe(405)

    const malformed = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers,
      body: '{'
    })
    expect(malformed.status).toBe(400)
    expect(handler).not.toHaveBeenCalled()
  })

  it('인증된 요청은 id를 보존하고 handler 결과를 JSON으로 돌려준다', async () => {
    const { server, port, handler } = await start()
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-waifu-token': server.token
      },
      body: JSON.stringify({
        id: 'request-1',
        tool: 'waifu_say',
        args: { text: '안녕' }
      })
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      id: 'request-1',
      ok: true,
      result: { accepted: true }
    })
    expect(handler).toHaveBeenCalledWith('waifu_say', { text: '안녕' })
  })

  it('handler 실패는 토큰을 노출하지 않고 구조화된 실패 응답이 된다', async () => {
    const handler = vi.fn(() => {
      throw new Error('거절됨')
    })
    const { server, port } = await start(handler)
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'x-waifu-token': server.token },
      body: JSON.stringify({ id: 'request-2', tool: 'waifu_motion', args: {} })
    })
    const text = await response.text()

    expect(JSON.parse(text)).toEqual({ id: 'request-2', ok: false, error: '거절됨' })
    expect(text).not.toContain(server.token)
  })
})
