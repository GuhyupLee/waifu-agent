import { existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { WaifuConfig } from '@shared/protocol'

/** 앱 시작 때 고정되는 설정을 비밀값이 드러나지 않는 비교 문자열로 만든다. */
export function agentRuntimeFingerprint(config: WaifuConfig): string {
  const avatarStartup = config.avatar.renderer === 'unity'
    ? {
        renderer: config.avatar.renderer,
        modelPath: config.avatar.modelPath,
        scale: config.avatar.scale,
        anchor: config.avatar.anchor,
        alwaysOnTop: config.avatar.alwaysOnTop,
        hitAlpha: config.avatar.hitAlpha,
        presence: config.avatar.presence
      }
    : { renderer: config.avatar.renderer }

  const snapshot = JSON.stringify({
    backend: config.backend,
    permission: config.permission,
    persona: config.persona,
    notify: config.notify,
    discord: config.discord,
    unity: config.unity,
    system: {
      launchAtLogin: config.system.launchAtLogin,
      trayIcon: config.system.trayIcon
    },
    avatar: avatarStartup
  })
  return createHash('sha256').update(snapshot).digest('hex')
}

/** 홈 폴더 fallback 없이 실제로 시작 가능한 작업 루트인지 검사한다. */
export function validateAgentWorkspaces(
  config: WaifuConfig
): { ok: true; cwd: string } | { ok: false; reason: string } {
  const workspaces = config.permission.workspaces.map((path) => path.trim()).filter(Boolean)
  if (workspaces.length === 0) {
    return { ok: false, reason: '작업 폴더를 먼저 골라줘.' }
  }

  for (const path of workspaces) {
    if (!isAbsolute(path)) {
      return { ok: false, reason: `작업 폴더는 절대 경로여야 한다: ${path}` }
    }
    try {
      if (!existsSync(path) || !statSync(path).isDirectory()) {
        return { ok: false, reason: `작업 폴더를 찾을 수 없다: ${path}` }
      }
    } catch {
      return { ok: false, reason: `작업 폴더를 확인할 수 없다: ${path}` }
    }
  }

  return { ok: true, cwd: workspaces[0]! }
}
