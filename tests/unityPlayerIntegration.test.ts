import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/shared/protocol'
import { UnityAvatarShell } from '../src/main/avatar/shell'
import type { AvatarEvent } from '../src/shared/protocol'

/**
 * 실제 빌드된 Unity 프로그램과 localhost 브리지의 선택적 종단 테스트.
 *
 * 평소 CI에는 플레이어가 없으므로 건너뛴다. 로컬 빌드 뒤
 * `WAIFU_TEST_UNITY_PLAYER=.../WaifuAvatar.exe`를 주면 spawn→인증→명령→종료를 확인한다.
 */
const playerPath = process.env.WAIFU_TEST_UNITY_PLAYER
const ready = Boolean(playerPath && existsSync(playerPath))
const modelPath = process.env.WAIFU_TEST_UNITY_MODEL
const modelReady = Boolean(modelPath && existsSync(modelPath))

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${timeoutMs}ms 안에 Unity 셸이 연결되지 않았다`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe.runIf(ready)('local Unity player integration', () => {
  it(
    '플레이어를 spawn하고 인증한 뒤 AgentState 명령을 보내고 함께 종료한다',
    async () => {
      const config = structuredClone(DEFAULT_CONFIG)
      config.avatar.renderer = 'unity'
      config.avatar.modelPath = null
      config.unity.playerPath = playerPath!
      config.unity.maxRestarts = 0
      config.unity.launchTimeoutMs = 15_000

      const notices: string[] = []
      const shell = new UnityAvatarShell(config, {
        notify: (_level, message) => notices.push(message)
      })

      try {
        await shell.start()
        await waitUntil(() => shell.connected, 15_000)
        expect(notices).toContain('Unity 셸이 연결됐다.')
        expect(shell.send({ type: 'status', state: 'working' })).toBe(true)
      } finally {
        await shell.stop()
      }

      expect(shell.connected).toBe(false)
    },
    30_000
  )

  it.runIf(modelReady)(
    '빌드 플레이어가 실제 VRM과 런타임 셰이더를 불러온다',
    async () => {
      const config = structuredClone(DEFAULT_CONFIG)
      config.avatar.renderer = 'unity'
      config.avatar.modelPath = modelPath!
      config.unity.playerPath = playerPath!
      config.unity.maxRestarts = 0
      config.unity.launchTimeoutMs = 15_000

      const events: AvatarEvent[] = []
      const shell = new UnityAvatarShell(config, {
        onEvent: (event) => events.push(event)
      })

      try {
        await shell.start()
        await waitUntil(() => shell.connected, 15_000)
        await waitUntil(() => events.some((event) => event.type === 'model-loaded'), 20_000)
        expect(events.find((event) => event.type === 'model-loaded')).toMatchObject({
          type: 'model-loaded',
          ok: true
        })
        await waitUntil(
          () => events.some((event) => event.type === 'motions' && event.names.includes('nod')),
          5_000
        )
        expect(shell.send({ type: 'motion', name: 'nod', loop: false })).toBe(true)
        // nod는 1.8초 원샷이다. 끝을 지나 idle 복귀까지 플레이어가 살아 있어야 한다.
        await new Promise((resolve) => setTimeout(resolve, 2_400))
        // 같은 캐시 인스턴스를 재요청해도 from/to 양쪽에서 서로 다른 시각으로 샘플하면 안 된다.
        expect(shell.send({ type: 'motion', name: 'idle-breathe', loop: true })).toBe(true)
        expect(shell.send({ type: 'motion', name: 'idle-breathe', loop: true })).toBe(true)
        // 빠른 A→B→C는 진행 중인 혼합을 버리지 않고 최신 요청만 다음 전환으로 잇는다.
        expect(shell.send({ type: 'motion', name: 'idle-soft-sway', loop: true })).toBe(true)
        expect(shell.send({ type: 'motion', name: 'idle-attentive', loop: true })).toBe(true)
        await new Promise((resolve) => setTimeout(resolve, 800))
        expect(shell.connected).toBe(true)
      } finally {
        await shell.stop()
      }
    },
    35_000
  )
})
