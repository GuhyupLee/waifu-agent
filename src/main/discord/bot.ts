import type { PermissionMode, WaifuConfig } from '@shared/protocol'
import { DiscordGateway } from './gateway'
import type { DiscordMessage } from './gateway'

/**
 * 밖에서 부탁하고 결과를 받는 통로.
 *
 * 보안이 이 파일의 전부다. 이건 **외부에서 내 PC 를 조종하는 입구**이므로,
 * 켜지지 않는 쪽으로 기운다:
 *
 *  - 토큰이 없거나 허용 목록이 비어 있으면 아예 시작하지 않는다.
 *  - 허용 목록에 없는 사용자는 조용히 무시한다. "너는 권한이 없다" 고 답하면
 *    봇이 살아 있다는 것만 알려주는 꼴이다.
 *  - 서버 채널은 받지 않는다. DM 만.
 *  - 원격 요청의 권한은 설정의 상한으로 눌러 내린다. '맡겨두기' 는 고를 수 없다 —
 *    눈앞에 없는 사람이 무제한 자동 실행을 시키는 건 위험하다.
 */

export interface DiscordBotHandlers {
  /** 허용된 사용자의 DM. 여기서 Task 를 만들고 에이전트에 넘긴다. */
  onRequest(text: string, reply: (text: string) => void): void
  onNotice(level: 'info' | 'warn' | 'error', message: string): void
}

export class DiscordBot {
  private gateway: DiscordGateway | null = null
  /** 마지막으로 말을 건 사용자의 DM 채널. 완료 보고를 여기로 보낸다. */
  private lastChannelId: string | null = null

  constructor(
    private readonly config: WaifuConfig['discord'],
    private readonly handlers: DiscordBotHandlers
  ) {}

  /** 시작할 수 있는 상태인지. 이유를 문자열로 돌려준다. */
  static check(config: WaifuConfig['discord']): { ok: boolean; reason?: string } {
    if (!config.enabled) return { ok: false, reason: '꺼져 있다' }
    if (!config.token.trim()) return { ok: false, reason: '봇 토큰이 없다' }
    if (config.allowedUserIds.length === 0) {
      // 허용 목록이 비어 있는데 켜는 건 "아무나 들어와도 된다" 는 뜻이 된다.
      return { ok: false, reason: '허용된 사용자 ID 가 하나도 없다' }
    }
    return { ok: true }
  }

  start(): boolean {
    const check = DiscordBot.check(this.config)
    if (!check.ok) {
      process.stdout.write(`[discord] 시작하지 않음 — ${check.reason}\n`)
      return false
    }

    this.gateway = new DiscordGateway(this.config.token, {
      onReady: (tag) => {
        process.stdout.write(`[discord] ${tag} 로 연결됨 (허용 ${this.config.allowedUserIds.length}명)\n`)
        this.handlers.onNotice('info', `Discord 연결됨 (${tag})`)
      },
      onError: (m) => {
        process.stderr.write(`[discord] ${m}\n`)
        this.handlers.onNotice('error', `Discord: ${m}`)
      },
      onMessage: (msg) => this.onMessage(msg)
    })
    this.gateway.connect()
    return true
  }

  private onMessage(msg: DiscordMessage): void {
    // 서버 채널은 다루지 않는다. 여러 사람이 있는 곳에서 PC 를 조종하게 두지 않는다.
    if (!msg.isDirect) return

    // 허용 목록 밖은 조용히 무시한다. 답하면 봇이 살아 있다는 정보를 준다.
    if (!this.config.allowedUserIds.includes(msg.authorId)) {
      process.stdout.write(`[discord] 허용되지 않은 사용자 무시: ${msg.authorId}\n`)
      return
    }

    const text = msg.content.trim()
    if (!text) return

    this.lastChannelId = msg.channelId
    process.stdout.write(`[discord] ${msg.authorName}: ${text.slice(0, 80)}\n`)

    this.handlers.onRequest(text, (reply) => void this.send(msg.channelId, reply))
  }

  /** 마지막으로 말을 건 사람에게 보고한다. 대화가 없었으면 보낼 곳이 없다. */
  async report(text: string): Promise<void> {
    if (!this.lastChannelId) return
    await this.send(this.lastChannelId, text)
  }

  private async send(channelId: string, text: string): Promise<void> {
    try {
      await this.gateway?.reply(channelId, text)
    } catch (err) {
      process.stderr.write(`[discord] 전송 실패: ${String(err)}\n`)
    }
  }

  stop(): void {
    this.gateway?.close()
    this.gateway = null
  }
}

/**
 * 원격 요청에 적용할 권한을 정한다.
 *
 * 현재 설정보다 **더 강한 권한을 주지 않는다.** 그리고 상한을 넘지도 않는다.
 * 데스크탑에서 '맡겨두기' 로 쓰고 있어도 Discord 요청은 상한까지만 내려간다.
 */
export function clampRemotePermission(
  current: PermissionMode,
  max: 'readonly' | 'guarded'
): PermissionMode {
  if (current === 'readonly') return 'readonly'
  if (max === 'readonly') return 'readonly'
  // current 가 guarded 든 auto 든, 상한이 guarded 면 guarded 다.
  return 'guarded'
}
