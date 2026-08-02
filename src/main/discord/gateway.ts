/**
 * Discord 게이트웨이 최소 구현.
 *
 * discord.js 나 ws 를 쓰지 않는다 — Electron 43 의 Node 24 에 전역 `WebSocket` 과 `fetch` 가
 * 있어서 의존성 없이 붙을 수 있다. `ws` 는 선택적 네이티브 가속기 때문에 이미 한 번
 * 앱을 죽인 적이 있다.
 *
 * DM 수신에 필요한 것만 구현한다. 서버 채널, 슬래시 명령, 음성은 다루지 않는다.
 */

const API = 'https://discord.com/api/v10'

/** DIRECT_MESSAGES(1<<12) + MESSAGE_CONTENT(1<<15). */
const INTENTS = (1 << 12) | (1 << 15)

const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11
} as const

export interface DiscordMessage {
  id: string
  channelId: string
  authorId: string
  authorName: string
  content: string
  /** DM 이 아니면 서버 채널이다. 우리는 DM 만 다룬다. */
  isDirect: boolean
}

export interface GatewayHandlers {
  onMessage(msg: DiscordMessage): void
  onReady(botTag: string): void
  onError(message: string): void
}

interface Payload {
  op: number
  d?: unknown
  s?: number | null
  t?: string | null
}

export class DiscordGateway {
  private ws: WebSocket | null = null
  private heartbeat: NodeJS.Timeout | null = null
  private lastSeq: number | null = null
  private sessionId: string | null = null
  private resumeUrl: string | null = null
  private acked = true
  private closed = false
  /** 재접속 대기 시간. 연달아 실패하면 늘린다. */
  private backoffMs = 1000

  constructor(
    private readonly token: string,
    private readonly handlers: GatewayHandlers
  ) {}

  connect(): void {
    this.closed = false
    this.open(this.resumeUrl ?? 'wss://gateway.discord.gg')
  }

  private open(baseUrl: string): void {
    const url = `${baseUrl}/?v=10&encoding=json`
    const ws = new WebSocket(url)
    this.ws = ws
    this.acked = true

    ws.addEventListener('message', (e) => this.onPayload(String(e.data)))
    ws.addEventListener('error', () => this.handlers.onError('게이트웨이 연결 오류'))
    ws.addEventListener('close', (e) => {
      this.stopHeartbeat()
      if (this.closed) return
      // 4004(인증 실패)는 재시도해도 소용없다. 토큰이 틀린 것이다.
      if (e.code === 4004) {
        this.handlers.onError('Discord 토큰이 거부됐다. 토큰을 다시 확인해라.')
        return
      }
      // 4014 는 특권 인텐트 미허용. 개발자 포털에서 켜야 한다.
      if (e.code === 4014) {
        this.handlers.onError(
          'MESSAGE CONTENT INTENT 가 꺼져 있다. Discord 개발자 포털에서 켜야 DM 내용을 읽을 수 있다.'
        )
        return
      }
      setTimeout(() => this.connect(), this.backoffMs)
      this.backoffMs = Math.min(this.backoffMs * 2, 60_000)
    })
  }

  private send(payload: Payload): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload))
  }

  private onPayload(raw: string): void {
    let p: Payload
    try {
      p = JSON.parse(raw) as Payload
    } catch {
      return
    }
    if (typeof p.s === 'number') this.lastSeq = p.s

    switch (p.op) {
      case OP.HELLO: {
        const interval = (p.d as { heartbeat_interval: number }).heartbeat_interval
        this.startHeartbeat(interval)
        // 세션이 살아 있으면 이어붙인다. 놓친 메시지를 다시 받을 수 있다.
        if (this.sessionId) {
          this.send({
            op: OP.RESUME,
            d: { token: this.token, session_id: this.sessionId, seq: this.lastSeq }
          })
        } else {
          this.send({
            op: OP.IDENTIFY,
            d: {
              token: this.token,
              intents: INTENTS,
              properties: { os: process.platform, browser: 'waifu-agent', device: 'waifu-agent' }
            }
          })
        }
        break
      }

      case OP.HEARTBEAT:
        this.send({ op: OP.HEARTBEAT, d: this.lastSeq })
        break

      case OP.HEARTBEAT_ACK:
        this.acked = true
        // 한 번 성공하면 백오프를 되돌린다.
        this.backoffMs = 1000
        break

      case OP.RECONNECT:
        this.ws?.close(4000)
        break

      case OP.INVALID_SESSION:
        // 이어붙일 수 없다. 세션을 버리고 처음부터 다시.
        this.sessionId = null
        this.resumeUrl = null
        this.ws?.close(4000)
        break

      case OP.DISPATCH:
        this.onDispatch(p)
        break

      default:
        break
    }
  }

  private onDispatch(p: Payload): void {
    if (p.t === 'READY') {
      const d = p.d as {
        session_id: string
        resume_gateway_url?: string
        user: { username: string; discriminator?: string }
      }
      this.sessionId = d.session_id
      this.resumeUrl = d.resume_gateway_url ?? null
      this.handlers.onReady(d.user.username)
      return
    }

    if (p.t !== 'MESSAGE_CREATE') return
    const d = p.d as {
      id: string
      channel_id: string
      content?: string
      guild_id?: string
      author?: { id: string; username: string; bot?: boolean }
    }
    // 봇이 자기 말에 답하면 무한 루프가 된다.
    if (!d.author || d.author.bot) return

    this.handlers.onMessage({
      id: d.id,
      channelId: d.channel_id,
      authorId: d.author.id,
      authorName: d.author.username,
      content: d.content ?? '',
      // guild_id 가 없으면 DM 이다.
      isDirect: d.guild_id === undefined
    })
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat()
    // 첫 하트비트는 지터를 준다. 봇이 많으면 동시에 몰리지 않도록 권장되는 방식이다.
    setTimeout(() => this.send({ op: OP.HEARTBEAT, d: this.lastSeq }), intervalMs * Math.random())
    this.heartbeat = setInterval(() => {
      // 직전 하트비트에 ACK 가 없으면 연결이 죽은 것이다. 좀비 연결을 붙잡고 있으면
      // 메시지를 못 받으면서 연결된 줄 안다.
      if (!this.acked) {
        this.ws?.close(4000)
        return
      }
      this.acked = false
      this.send({ op: OP.HEARTBEAT, d: this.lastSeq })
    }, intervalMs)
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
  }

  /** DM 채널에 답한다. 2000자를 넘으면 잘라 보낸다. */
  async reply(channelId: string, content: string): Promise<void> {
    for (const chunk of splitMessage(content)) {
      const res = await fetch(`${API}/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bot ${this.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ content: chunk })
      })
      if (!res.ok) {
        this.handlers.onError(`Discord 전송 실패 (${res.status})`)
        return
      }
    }
  }

  close(): void {
    this.closed = true
    this.stopHeartbeat()
    this.ws?.close(1000)
    this.ws = null
  }
}

/** Discord 메시지 상한은 2000자다. 넘으면 줄 단위로 끊어 여러 개로 보낸다. */
export function splitMessage(text: string, limit = 1900): string[] {
  if (text.length <= limit) return [text || '(빈 응답)']
  const out: string[] = []
  let buf = ''
  for (const line of text.split('\n')) {
    // 한 줄이 통째로 상한을 넘으면 그 줄만 강제로 자른다.
    if (line.length > limit) {
      if (buf) {
        out.push(buf)
        buf = ''
      }
      for (let i = 0; i < line.length; i += limit) out.push(line.slice(i, i + limit))
      continue
    }
    if (buf.length + line.length + 1 > limit) {
      out.push(buf)
      buf = line
    } else {
      buf = buf ? `${buf}\n${line}` : line
    }
  }
  if (buf) out.push(buf)
  return out
}
