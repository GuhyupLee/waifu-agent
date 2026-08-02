import { existsSync, readdirSync } from 'node:fs'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { IPC } from '@shared/protocol'
import type { AvatarEvent, WaifuConfig } from '@shared/protocol'
import { applyOverlaySwitches, createAvatarWindow, setAvatarInteractive } from './windows/avatarWindow'
import { createPanelWindow } from './windows/panelWindow'
import { mcpLaunchSpec, permissionHookCommand } from './childEntries'
import { assetUrl, handleAssetProtocol, registerAssetScheme } from './assetProtocol'
import { loadConfig, saveConfig } from './config/store'
import { Waifu } from './waifu'
import type { PermissionDecision } from '@shared/protocol'

// 둘 다 app 준비 **전에** 걸어야 한다. 준비 후에 부르면 조용히 무시된다.
applyOverlaySwitches()
registerAssetScheme()

let avatarWindow: BrowserWindow | null = null
let panelWindow: BrowserWindow | null = null
let lastFpsLog = 0

/** 드래그 중에는 커서가 실루엣을 벗어나도 클릭 통과로 되돌리면 안 된다. */
let dragging = false

function registerIpc(): void {
  ipcMain.on(IPC.avatarEvent, (_e, event: AvatarEvent) => {
    const win = avatarWindow
    if (!win || win.isDestroyed()) return

    switch (event.type) {
      case 'hover':
        // 드래그 중이면 무시한다. 여기서 클릭 통과로 돌아가면 mouseup 을 못 받아
        // 드래그가 영영 안 끝난다.
        if (!dragging) setAvatarInteractive(win, event.over)
        break

      case 'drag-start':
        dragging = true
        setAvatarInteractive(win, true)
        break

      case 'drag-move': {
        const b = win.getBounds()
        win.setBounds({ ...b, x: b.x + Math.round(event.dx), y: b.y + Math.round(event.dy) })
        break
      }

      case 'drag-end':
        dragging = false
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
          sendMotions(win)
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

  ipcMain.on(IPC.sendMessage, (_e, text: string) => waifu?.send(text))
  ipcMain.on(IPC.interrupt, () => waifu?.interrupt())
  ipcMain.on(IPC.permissionRespond, (_e, p: { id: string; decision: PermissionDecision }) =>
    waifu?.resolvePermission(p.id, p.decision)
  )
}

/**
 * 화면 전역 커서를 폴링해 아바타에게 시선 방향을 넘긴다.
 *
 * 렌더러의 mousemove 로는 부족하다 — setIgnoreMouseEvents(true, {forward:true}) 는
 * 커서가 창 위에 있을 때만 WM_MOUSEMOVE 를 전달하므로, 데스크탑 반대편을 보고 있는지 알 수 없다.
 *
 * 33ms(약 30Hz)면 눈으로는 충분히 부드럽다. 어차피 렌더러에서 감쇠를 걸어 따라가므로
 * 폴링 주기가 그대로 움직임의 거칠기가 되지는 않는다.
 */
function startGazeTracking(): NodeJS.Timeout {
  let lastX = 0
  let lastY = 0
  return setInterval(() => {
    const win = avatarWindow
    if (!win || win.isDestroyed() || !win.isVisible()) return

    const cursor = screen.getCursorScreenPoint()
    const b = win.getBounds()
    // 창 중심을 원점으로, 창 크기의 절반을 1 로 정규화한다. 창 밖이면 ±1 을 넘는다.
    const x = (cursor.x - (b.x + b.width / 2)) / (b.width / 2)
    const y = (cursor.y - (b.y + b.height / 2)) / (b.height / 2)

    // 변화가 미미하면 보내지 않는다. 가만히 있는 동안 초당 30번 IPC 를 태울 이유가 없다.
    if (Math.abs(x - lastX) < 0.01 && Math.abs(y - lastY) < 0.01) return
    lastX = x
    lastY = y

    // 너무 멀리 있는 커서까지 따라가면 목이 끝까지 돌아간 채로 굳는다. 렌더러에서
    // 다시 제한하지만, 여기서 미리 눌러두면 화면 끝에서의 반응이 자연스럽다.
    win.webContents.send(IPC.avatarCommand, {
      type: 'gaze',
      x: Math.max(-2.5, Math.min(2.5, x)) / 2.5,
      y: Math.max(-2.5, Math.min(2.5, y)) / 2.5
    })
  }, 33)
}

/** resources/motions 의 .vrma 를 전부 등록한다. 파일 이름이 곧 모션 이름이 된다. */
function sendMotions(win: BrowserWindow): void {
  const dir = resolve(app.getAppPath(), 'resources/motions')
  if (!existsSync(dir)) return

  const files = readdirSync(dir).filter((f) => extname(f).toLowerCase() === '.vrma')
  if (files.length === 0) {
    process.stdout.write(
      '[avatar] resources/motions 에 .vrma 가 없다. 절차적 기본 자세로만 동작한다.\n'
    )
    return
  }
  for (const f of files) {
    win.webContents.send(IPC.avatarCommand, {
      type: 'load-motion',
      name: basename(f, extname(f)),
      url: assetUrl(join(dir, f))
    })
  }
  process.stdout.write(`[avatar] 모션 ${files.length}개 등록: ${files.join(', ')}\n`)
}

/**
 * 설정에 적힌 VRM 을 아바타 창에 실어 보낸다.
 * 렌더러는 파일 시스템에 직접 닿을 수 없으므로 waifu-asset:// 로 감싼다.
 * 그 과정에서 이 경로만 허용 목록에 오른다 — 렌더러에 디스크 전체를 열어주지 않는다.
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

  // once 가 아니라 on 이어야 한다 — 개발 중 HMR 로 페이지가 다시 로드되면 씬이 새로
  // 만들어지므로, 한 번만 보내면 그 뒤로는 빈 아바타가 남는다.
  avatarWindow.webContents.on('did-finish-load', () => {
    if (avatarWindow) sendModel(avatarWindow, config)
  })

  avatarWindow.on('closed', () => (avatarWindow = null))
  panelWindow.on('closed', () => (panelWindow = null))
}

let gazeTimer: NodeJS.Timeout | null = null
let waifu: Waifu | null = null

void app.whenReady().then(async () => {
  handleAssetProtocol()
  verifyChildEntries()
  registerIpc()

  const config = loadConfig()
  process.stdout.write(`[config] 퍼소나=${config.persona.name} 권한=${config.permission.mode}\n`)
  createWindows(config)
  gazeTimer = startGazeTracking()

  waifu = new Waifu(
    config,
    () => avatarWindow,
    () => panelWindow
  )
  try {
    // 작업 루트는 첫 번째 workspace, 없으면 홈. 에이전트가 아무 데나 쓰지 못하게 한다.
    const cwd = config.permission.workspaces[0] ?? app.getPath('home')
    await waifu.start(cwd)
    process.stdout.write(`[waifu] 백엔드 시작 (cwd=${cwd})\n`)
  } catch (err) {
    process.stderr.write(`[waifu] 백엔드 시작 실패: ${String(err)}\n`)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindows(loadConfig())
  })
})

app.on('before-quit', () => {
  if (gazeTimer) clearInterval(gazeTimer)
  void waifu?.stop()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
