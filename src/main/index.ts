import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { IPC } from '@shared/protocol'
import type { AvatarEvent, WaifuConfig } from '@shared/protocol'
import { applyOverlaySwitches, createAvatarWindow, setAvatarInteractive } from './windows/avatarWindow'
import { createPanelWindow } from './windows/panelWindow'
import { mcpLaunchSpec, permissionHookCommand } from './childEntries'
import { assetUrl, handleAssetProtocol, registerAssetScheme } from './assetProtocol'
import { loadConfig, saveConfig } from './config/store'

// 둘 다 app 준비 **전에** 걸어야 한다. 준비 후에 부르면 조용히 무시된다.
applyOverlaySwitches()
registerAssetScheme()

let avatarWindow: BrowserWindow | null = null
let panelWindow: BrowserWindow | null = null
let lastFpsLog = 0

function registerIpc(): void {
  ipcMain.on(IPC.avatarEvent, (_e, event: AvatarEvent) => {
    if (!avatarWindow || avatarWindow.isDestroyed()) return
    switch (event.type) {
      case 'hover':
        setAvatarInteractive(avatarWindow, event.over)
        break
      case 'fps': {
        const now = Date.now()
        if (now - lastFpsLog > 5000) {
          lastFpsLog = now
          process.stdout.write(`[avatar] ${event.value.toFixed(1)} fps\n`)
        }
        break
      }
      case 'model-loaded':
        if (event.ok) {
          process.stdout.write(
            `[avatar] 모델 로드 완료 (표정=${event.hasExpressions} 시선=${event.hasLookAt})\n` +
              `[avatar] 표정 프리셋: ${event.presets.join(', ') || '(없음)'}\n`
          )
        } else {
          process.stderr.write(`[avatar] 모델 로드 실패: ${event.error}\n`)
        }
        break
      case 'clicked':
        panelWindow?.show()
        break
      default:
        break
    }
  })

  ipcMain.handle(IPC.configGet, () => loadConfig())
  ipcMain.handle(IPC.configSet, (_e, patch: Partial<WaifuConfig>) => saveConfig(patch))
}

/**
 * 설정에 적힌 VRM 을 아바타 창에 실어 보낸다.
 *
 * 렌더러는 파일 시스템에 직접 닿을 수 없으므로 waifu-asset:// 스킴으로 감싼다.
 * 그 과정에서 이 경로만 허용 목록에 올라간다 — 렌더러에 디스크 전체를 열어주지 않기 위해서다.
 */
function sendModel(win: BrowserWindow, config: WaifuConfig): void {
  const configured = config.avatar.modelPath
  if (!configured) {
    process.stdout.write('[avatar] 설정에 modelPath 가 없다. 빈 씬으로 시작한다.\n')
    return
  }
  // 상대 경로는 앱 루트 기준으로 푼다. 동봉 샘플을 가리킬 때 절대 경로를 쓰지 않아도 되게.
  const path = isAbsolute(configured) ? configured : resolve(app.getAppPath(), configured)
  if (!existsSync(path)) {
    process.stderr.write(`[avatar] modelPath 를 찾을 수 없다: ${path}\n`)
    return
  }
  win.webContents.send(IPC.avatarCommand, {
    type: 'load-model',
    url: assetUrl(path),
    format: path.toLowerCase().endsWith('.fbx') ? 'fbx' : 'vrm'
  })
}

/**
 * 자식 스크립트(MCP 서버·권한 훅)가 실제로 존재하는지 시작할 때 확인한다.
 * 패키징에서 asarUnpack 을 빠뜨리면 증상이 한참 뒤에 엉뚱하게 나타난다. 지금 크게 실패하는 게 낫다.
 */
function verifyChildEntries(): void {
  const mcp = mcpLaunchSpec()
  process.stdout.write(`[child] mcp: ${mcp.command} ${mcp.args.join(' ')}\n`)
  process.stdout.write(`[child] hook: ${permissionHookCommand()}\n`)
}

function createWindows(config: WaifuConfig): void {
  avatarWindow = createAvatarWindow()
  panelWindow = createPanelWindow(config.persona.name)

  // 렌더러가 준비된 뒤에 보내야 명령이 유실되지 않는다.
  avatarWindow.webContents.once('did-finish-load', () => {
    if (avatarWindow) sendModel(avatarWindow, config)
  })

  avatarWindow.on('closed', () => (avatarWindow = null))
  panelWindow.on('closed', () => (panelWindow = null))
}

void app.whenReady().then(() => {
  handleAssetProtocol()
  verifyChildEntries()
  registerIpc()

  const config = loadConfig()
  process.stdout.write(`[config] 퍼소나=${config.persona.name} 권한=${config.permission.mode}\n`)
  createWindows(config)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindows(loadConfig())
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
