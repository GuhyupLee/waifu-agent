import { AVATAR_WINDOW_ENV } from '@shared/protocol'
import type { AvatarCommand, AvatarEvent, WaifuConfig } from '@shared/protocol'
import { AvatarBridgeServer } from './bridge'
import { UnityProcessManager } from './unityProcess'

/**
 * 브리지 + 프로세스를 한 덩어리로 묶는다.
 *
 * index.ts 가 서버와 프로세스를 각각 들고 순서를 맞추게 하면 배선 실수가 나기 쉽다 —
 * 포트를 얻기 **전에** Unity 를 띄우면 셸이 붙을 곳을 모른다. 그 순서를 여기 가둔다.
 *
 * Phase 1 의 역할은 "붙고, 모델을 띄우고, 상태를 반영한다" 까지다.
 * 에이전트 턴과의 연결(`Waifu` 가 명령을 흘려보내는 경로)은 Phase 2 다.
 */

export interface UnityShellDeps {
  onEvent?: (event: AvatarEvent) => void
  /** 사용자에게 보여야 하는 사건. 조용히 실패하면 아바타가 왜 없는지 알 수 없다. */
  notify?: (level: 'info' | 'warn' | 'error', message: string) => void
}

export class UnityAvatarShell {
  private bridge: AvatarBridgeServer | null = null
  private process: UnityProcessManager | null = null

  constructor(
    private readonly config: WaifuConfig,
    private readonly deps: UnityShellDeps = {}
  ) {}

  get connected(): boolean {
    return this.bridge?.connected ?? false
  }

  /** 설정이 Unity 셸을 쓰지 않으면 아무것도 하지 않는다. */
  async start(): Promise<void> {
    const { avatar, unity } = this.config
    if (avatar.renderer !== 'unity') return

    if (!unity.playerPath) {
      this.log('warn', 'unity.playerPath 가 비어 있다. Unity 셸을 띄우지 않는다.')
      return
    }

    const bridge = new AvatarBridgeServer({
      onEvent: (event) => this.deps.onEvent?.(event),
      onConnect: () => {
        this.log('info', 'Unity 셸이 연결됐다.')
        // 이 실행은 성공이다. 재시작 예산을 되돌려준다.
        this.process?.notifyConnected()
      },
      onDisconnect: (reason) => this.log('warn', `Unity 셸 연결 끊김 — ${reason}`),
      onReject: (reason) => this.log('error', `Unity 셸 연결 거절 — ${reason}`)
    })
    this.bridge = bridge

    // **포트를 먼저 얻어야 한다.** 환경변수에 넣어 보낼 값이라 spawn 보다 앞선다.
    const port = await bridge.start()
    this.log('info', `아바타 브리지 127.0.0.1:${port}`)

    this.process = new UnityProcessManager({
      playerPath: unity.playerPath,
      bridgeEnv: { ...bridge.childEnv(), ...this.windowEnv() },
      maxRestarts: unity.maxRestarts,
      launchTimeoutMs: unity.launchTimeoutMs,
      log: (level, message) => this.log(level, message),
      onGaveUp: (reason) => this.log('error', reason)
    })
    this.process.start()
  }

  /**
   * 창 배치값과 모델 경로. 첫 프레임 전에 정해져야 해서 명령이 아니라 환경변수다.
   * 비밀값은 하나도 넣지 않는다 — Unity 는 권한 게이트 바깥이다.
   */
  private windowEnv(): Record<string, string> {
    const { avatar } = this.config
    return {
      [AVATAR_WINDOW_ENV.anchorX]: String(avatar.anchor.x),
      [AVATAR_WINDOW_ENV.anchorY]: String(avatar.anchor.y),
      [AVATAR_WINDOW_ENV.alwaysOnTop]: avatar.alwaysOnTop ? '1' : '0',
      [AVATAR_WINDOW_ENV.hitAlpha]: String(avatar.hitAlpha),
      [AVATAR_WINDOW_ENV.scale]: String(avatar.scale),
      [AVATAR_WINDOW_ENV.modelPath]: avatar.modelPath ?? ''
    }
  }

  /** 연결이 없으면 false. 큐에 쌓지 않는다. */
  send(command: AvatarCommand): boolean {
    return this.bridge?.send(command) ?? false
  }

  /**
   * Unity 를 먼저 죽이고 브리지를 닫는다.
   *
   * 순서가 중요하다 — 브리지를 먼저 닫으면 Unity 는 연결이 끊긴 것으로 보고 스스로
   * 종료하는데, 그 사이 우리가 프로세스를 놓치면 종료를 확인할 방법이 없어진다.
   */
  async stop(): Promise<void> {
    const process = this.process
    const bridge = this.bridge
    this.process = null
    this.bridge = null

    await process?.stop()
    await bridge?.stop()
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.deps.notify?.(level, message)
  }
}
