import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type WaifuConfig } from '../src/shared/protocol'
import {
  agentRuntimeFingerprint,
  validateAgentWorkspaces
} from '../src/main/config/agentRuntime'

const temporaryPaths: string[] = []

function configWith(patch: Partial<WaifuConfig>): WaifuConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    ...patch
  }
}

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('Agent Core 작업 폴더 경계', () => {
  it('빈 workspace를 홈 폴더로 대체하지 않고 시작을 거절한다', () => {
    const result = validateAgentWorkspaces(structuredClone(DEFAULT_CONFIG))
    expect(result).toEqual({ ok: false, reason: '작업 폴더를 먼저 골라줘.' })
  })

  it('존재하는 절대 디렉터리만 cwd로 받는다', () => {
    const path = mkdtempSync(join(tmpdir(), 'waifu-agent-runtime-'))
    temporaryPaths.push(path)
    const config = structuredClone(DEFAULT_CONFIG)
    config.permission.workspaces = [path]
    expect(validateAgentWorkspaces(config)).toEqual({ ok: true, cwd: path })
  })

  it('상대 경로와 없는 경로를 거절한다', () => {
    const relative = structuredClone(DEFAULT_CONFIG)
    relative.permission.workspaces = ['relative-folder']
    expect(validateAgentWorkspaces(relative).ok).toBe(false)

    const missing = structuredClone(DEFAULT_CONFIG)
    missing.permission.workspaces = [join(tmpdir(), `waifu-agent-missing-${Date.now()}`)]
    expect(validateAgentWorkspaces(missing).ok).toBe(false)
  })
})

describe('앱 시작 스냅샷 fingerprint', () => {
  it('백엔드·권한·persona·알림·Discord·Unity·시스템 변경을 잡는다', () => {
    const base = structuredClone(DEFAULT_CONFIG)
    const original = agentRuntimeFingerprint(base)

    const backend = structuredClone(base)
    backend.backend.active = 'codex'
    expect(agentRuntimeFingerprint(backend)).not.toBe(original)

    const permission = structuredClone(base)
    permission.permission.mode = 'readonly'
    expect(agentRuntimeFingerprint(permission)).not.toBe(original)

    const persona = structuredClone(base)
    persona.persona.name = '새 이름'
    expect(agentRuntimeFingerprint(persona)).not.toBe(original)

    const discord = structuredClone(base)
    discord.discord.maxPermission = 'readonly'
    expect(agentRuntimeFingerprint(discord)).not.toBe(original)

    const notify = structuredClone(base)
    notify.notify.quietFrom = '21:00'
    expect(agentRuntimeFingerprint(notify)).not.toBe(original)

    const discordToken = structuredClone(base)
    discordToken.discord.token = '새 토큰'
    expect(agentRuntimeFingerprint(discordToken)).not.toBe(original)

    const unity = structuredClone(base)
    unity.unity.maxRestarts += 1
    expect(agentRuntimeFingerprint(unity)).not.toBe(original)

    const system = structuredClone(base)
    system.system.trayIcon = !system.system.trayIcon
    expect(agentRuntimeFingerprint(system)).not.toBe(original)
  })

  it('아바타 표시 설정만 바뀌면 백엔드 재시작 대상으로 보지 않는다', () => {
    const base = structuredClone(DEFAULT_CONFIG)
    const avatar = configWith({ avatar: { ...base.avatar, scale: 1.25 } })
    expect(agentRuntimeFingerprint(avatar)).toBe(agentRuntimeFingerprint(base))
  })

  it('Unity 렌더러에서는 프로세스 환경과 presence 변경을 재시작 대상으로 본다', () => {
    const base = structuredClone(DEFAULT_CONFIG)
    base.avatar.renderer = 'unity'
    const original = agentRuntimeFingerprint(base)

    const model = structuredClone(base)
    model.avatar.modelPath = 'D:\\avatar.vrm'
    expect(agentRuntimeFingerprint(model)).not.toBe(original)

    const presence = structuredClone(base)
    presence.avatar.presence.roam.enabled = !presence.avatar.presence.roam.enabled
    expect(agentRuntimeFingerprint(presence)).not.toBe(original)
  })
})
