import { existsSync, readdirSync } from 'node:fs'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, powerMonitor, screen } from 'electron'
import { IPC } from '@shared/protocol'
import type { AvatarEvent, WaifuConfig } from '@shared/protocol'
import {
  applyAvatarScale,
  applyOverlaySwitches,
  createAvatarWindow,
  setAvatarInteractive
} from './windows/avatarWindow'
import { createPanelWindow } from './windows/panelWindow'
import { mcpLaunchSpec, permissionHookCommand } from './childEntries'
import { assetUrl, handleAssetProtocol, registerAssetScheme } from './assetProtocol'
import { applyContentSecurityPolicy } from './csp'
import { loadConfig, saveConfig } from './config/store'
import { Waifu } from './waifu'
import { stopActiveWhispers, transcribe } from './voice/stt'
import { PushToTalkHotkey } from './voice/hotkey'
import { pingEngine } from './voice/tts'
import { DiscordBot } from './discord/bot'
import type { PermissionDecision } from '@shared/protocol'

// 둘 다 app 준비 **전에** 걸어야 한다. 준비 후에 부르면 조용히 무시된다.
applyOverlaySwitches()
registerAssetScheme()

let avatarWindow: BrowserWindow | null = null
let panelWindow: BrowserWindow | null = null
let lastFpsLog = 0

/** 드래그 중에는 커서가 실루엣을 벗어나도 클릭 통과로 되돌리면 안 된다. */
let dragging = false
let motionLogTimer: NodeJS.Timeout | null = null

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
        // 자동 이동 timer와 사용자의 drag-move가 동시에 setBounds를 쓰면 창이 매 프레임
        // 원래 경로로 튄다. 손으로 잡는 순간부터는 사용자가 유일한 이동 주체다.
        waifu?.setAvatarDragging(true)
        dragging = true
        setAvatarInteractive(win, true)
        break

      case 'drag-move': {
        const b = win.getBounds()
        win.setBounds({ ...b, x: b.x + Math.round(event.dx), y: b.y + Math.round(event.dy) })
        break
      }

      case 'drag-end':
        waifu?.setAvatarDragging(false)
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
          sendTuning(loadConfig())
        } else {
          process.stderr.write(`[avatar] 모델 로드 실패: ${event.error}\n`)
        }
        break

      case 'motions':
        waifu?.setMotions(event.names)
        // 모션 하나가 로드될 때마다 이벤트가 온다. 54개면 로그가 54줄이 된다.
        // 잠잠해진 뒤 한 번만 찍는다.
        if (motionLogTimer) clearTimeout(motionLogTimer)
        motionLogTimer = setTimeout(() => {
          // 이 목록은 **에이전트가 부를 수 있는** 것만이다. mouse-tether 처럼 포인터
          // 좌표와 함께만 의미가 있는 모션은 렌더러가 일부러 숨긴다. 그래서 등록 수보다
          // 적은 게 정상이다 — 로드 실패로 읽히지 않게 문구를 분명히 해둔다.
          process.stdout.write(
            `[avatar] 에이전트가 부를 수 있는 모션 ${event.names.length}개: ${event.names.join(', ') || '(없음)'}\n`
          )
        }, 500)
        break

      case 'recording':
        if (!event.on) {
          // 권한 거부·초기화 실패·정상 종료·자동 종료 모두 다음 토글을 '시작'으로 되돌린다.
          recordingDesired = false
        } else if (!recordingDesired) {
          // 마이크 권한 창이 떠 있는 동안 사용자가 다시 눌러 취소한 경우, 늦게 도착한
          // recording=true 를 그대로 두지 않는다. 렌더러가 시작을 마치자마자 다시 끈다.
          requestRecording(false)
        } else discardRecorded = false
        break

      case 'recorded':
        void handleRecorded(event.wavBase64)
        break

      case 'clicked':
        panelWindow?.show()
        break

      default:
        break
    }
  })

  ipcMain.handle(IPC.configGet, () => loadConfig())
  ipcMain.handle(IPC.configSet, (_e, patch: Partial<WaifuConfig>) => {
    const next = saveConfig(patch)
    // 모델 경로가 바뀌었으면 즉시 갈아끼운다. 재시작을 요구할 이유가 없다.
    if (patch.avatar?.modelPath !== undefined && avatarWindow && !avatarWindow.isDestroyed()) {
      sendModel(avatarWindow, next)
    }
    // 조절값은 바로 반영한다. 슬라이더를 움직이며 맞추려면 즉시 보여야 한다.
    if (patch.avatar || patch.chat) sendTuning(next)
    if (patch.avatar?.scale !== undefined && avatarWindow && !avatarWindow.isDestroyed()) {
      applyAvatarScale(avatarWindow, next.avatar.scale)
    }
    if (patch.avatar?.alwaysOnTop !== undefined && avatarWindow && !avatarWindow.isDestroyed()) {
      // 생성자 옵션만으로는 레벨이 floating 이라 작업표시줄 뒤로 간다.
      if (next.avatar.alwaysOnTop) avatarWindow.setAlwaysOnTop(true, 'screen-saver')
      else avatarWindow.setAlwaysOnTop(false)
    }
    // voice 변경은 재시작 없이 반영한다. say() 가 쓰는 값과 STT 핫키 등록 둘 다 시작
    // 스냅샷으로 굳어 있으므로 여기서 갱신하지 않으면 재시작 전까지 무효다.
    if (patch.voice) {
      waifu?.updateVoice(next.voice)
      pushToTalk?.sync(next.voice)
      // 음성을 끄거나 STT 경로를 지워 핫키를 풀었다면 진행 중인 마이크도 같이 닫는다.
      // 그렇지 않으면 사용자는 종료 핫키를 잃고 2분 자동 제한까지 기다려야 한다.
      if (!pushToTalk?.current && recordingDesired) {
        // master voice off/경로 제거로 중단한 캡처는 설정을 다시 켜더라도 에이전트 턴으로
        // 보내지 않는다. 다음 정상 recording=true가 올 때만 discard를 해제한다.
        discardRecorded = true
        requestRecording(false)
      }
    }
    return next
  })

  ipcMain.handle(IPC.changesList, () =>
    (waifu?.recentSnapshots() ?? []).map((s) => ({
      id: s.id,
      path: s.path,
      at: s.at,
      toolName: s.toolName,
      hasBackup: s.backupPath !== null,
      restoredAt: s.restoredAt
    }))
  )

  ipcMain.handle(IPC.changesUndo, (_e, id: string) =>
    waifu?.restoreSnapshot(id) ?? { ok: false, reason: '아직 준비되지 않았다' }
  )

  ipcMain.handle(IPC.memoryList, () =>
    (waifu?.listMemories() ?? []).map((m) => ({
      key: m.key,
      value: m.value,
      updatedAt: m.updatedAt
    }))
  )
  ipcMain.handle(IPC.memoryForget, (_e, key: string) => waifu?.forgetMemory(key) ?? false)

  ipcMain.handle(IPC.routineList, () =>
    (waifu?.listRoutines() ?? []).map((r) => ({
      name: r.name,
      summary: r.summary,
      runCount: r.runCount,
      lastRunAt: r.lastRunAt
    }))
  )
  ipcMain.handle(IPC.routineRemove, (_e, name: string) => waifu?.removeRoutine(name) ?? false)

  ipcMain.handle(IPC.reminderList, () =>
    (waifu?.listReminders() ?? []).map((r) => ({
      id: r.id,
      text: r.text,
      dueAt: r.dueAt,
      repeat: r.repeat,
      channel: r.channel
    }))
  )
  ipcMain.handle(IPC.reminderCancel, (_e, id: string) => waifu?.cancelReminder(id) ?? false)

  ipcMain.handle(IPC.diagnostics, () => waifu?.diagnostics() ?? null)
  ipcMain.handle(IPC.pingVoice, (_e, url: string) => pingEngine(url))

  ipcMain.handle(IPC.pickModel, async () => {
    const res = await dialog.showOpenDialog({
      title: '아바타 모델 고르기',
      properties: ['openFile'],
      filters: [{ name: 'VRM / FBX', extensions: ['vrm', 'fbx'] }]
    })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })

  ipcMain.on(IPC.sendMessage, (_e, text: string) => waifu?.send(text))
  ipcMain.on(IPC.interrupt, () => waifu?.interrupt())
  ipcMain.on(IPC.permissionRespond, (_e, p: { id: string; decision: PermissionDecision }) =>
    waifu?.resolvePermission(p.id, p.decision)
  )
}

/** 렌더러의 비동기 시작/종료보다 앞서 움직이는 사용자의 최신 의도. */
let recordingDesired = false
/** 설정 변경으로 강제 중단한 캡처는 개인정보 경계상 전사하지 않는다. */
let discardRecorded = false
let discord: DiscordBot | null = null

/**
 * Discord 봇을 띄운다.
 *
 * 토큰이나 허용 목록이 없으면 시작하지 않는다 — 이건 외부에서 PC 를 조종하는
 * 입구라, 실수로 열어두는 쪽보다 안 켜지는 쪽이 낫다.
 */
function startDiscord(config: WaifuConfig): void {
  discord = new DiscordBot(config.discord, {
    onNotice: (level, message) => panelWindow?.webContents.send(IPC.panelEvent, {
      type: 'notice',
      level,
      message
    }),
    onRequest: (text, reply) => {
      if (!waifu) {
        reply('아직 준비되지 않았다. 잠시 후 다시 말해줘.')
        return
      }
      // origin 이 'discord' 면 권한이 상한까지 눌린다.
      waifu.send(text, 'discord', reply)
    }
  })
  if (discord.start() && waifu) {
    // 알림이 discord 채널로 잡혀 있으면 이 통로로 먼저 연락한다.
    waifu.onRemoteReport = (text) => void discord?.report(text)
  }
}

/**
 * 절전 복귀 처리.
 *
 * 자는 동안 사용량 한도가 풀렸을 수 있으므로 깨어나면 확인한다.
 * 그리고 아바타의 스프링 본을 초기화한다 — 몇 시간치 delta 를 한 번에 적분하면
 * 머리카락이 날아간다.
 */
function registerPowerHandlers(): void {
  powerMonitor.on('resume', () => {
    process.stdout.write('[power] 절전에서 복귀\n')
    waifu?.checkResumable()
    avatarWindow?.webContents.send(IPC.avatarCommand, { type: 'wake' })
  })
  powerMonitor.on('suspend', () => process.stdout.write('[power] 절전 진입\n'))
}

/**
 * 푸시투토크 핫키 컨트롤러.
 *
 * Electron 의 globalShortcut 은 키를 뗀 시점을 주지 않으므로 "누르고 있는 동안"이
 * 아니라 토글이다. 한 번 눌러 말하고 다시 눌러 보낸다.
 *
 * 시작할 때 한 번 sync 하고, voice 설정이 바뀔 때마다 다시 sync 한다 — 등록 상태를
 * 설정에 맞춰 유지하는 책임은 PushToTalkHotkey 안에 있다.
 */
let pushToTalk: PushToTalkHotkey | null = null

/** 핫키가 눌렸을 때 녹음을 토글한다. 비동기 권한 요청 중 재입력도 최신 의도로 보존한다. */
function pushToTalkTrigger(): void {
  requestRecording(!recordingDesired)
}

function requestRecording(on: boolean): void {
  const win = avatarWindow
  if (!win || win.isDestroyed()) return
  recordingDesired = on
  win.webContents.send(IPC.avatarCommand, { type: 'record', on: recordingDesired })
}

/** 녹음된 음성을 받아쓰고 그대로 한 턴으로 보낸다. */
async function handleRecorded(wavBase64: string | null): Promise<void> {
  const voice = loadConfig().voice
  if (discardRecorded || !voice.enabled) {
    process.stdout.write('[voice] 음성 기능이 꺼져 중단된 녹음을 버렸다\n')
    return
  }
  if (!wavBase64) {
    process.stdout.write('[voice] 유효한 음성을 찾지 못했다 (너무 짧거나 조용함)\n')
    return
  }
  try {
    const text = await transcribe(wavBase64, voice.stt)
    if (!text) {
      process.stdout.write('[voice] 받아쓴 내용이 비었다\n')
      return
    }
    process.stdout.write(`[voice] 받아쓰기: ${text}\n`)
    waifu?.send(text)
  } catch (err) {
    process.stderr.write(`[voice] 받아쓰기 실패: ${String(err)}\n`)
  }
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

/** 재시작 없이 반영 가능한 설정값을 아바타에 흘려보낸다. */
function sendTuning(config: WaifuConfig): void {
  const win = avatarWindow
  if (!win || win.isDestroyed()) return
  win.webContents.send(IPC.avatarCommand, {
    type: 'tuning',
    hitAlpha: config.avatar.hitAlpha,
    swayStrength: config.avatar.swayStrength,
    ambientMotion: config.avatar.ambientMotion,
    showSubtitle: config.chat.showSubtitle,
    subtitleMinMs: config.chat.subtitleMinMs,
    scale: config.avatar.scale
  })
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

/**
 * 렌더러 콘솔의 경고·오류를 main 로그로 끌어온다.
 *
 * 이게 없으면 렌더러에서 난 실패가 DevTools 를 열어야만 보인다. 투명 창은 DevTools 를
 * 붙여서 열면 불투명해지므로 그마저도 번거롭다. 모션 로드 실패처럼 조용히 지나가는
 * 문제를 놓치게 된다.
 */
function forwardConsole(win: BrowserWindow, tag: string): void {
  // 이벤트 객체 형태가 현재 API 다. 뒤따라오는 (level, message, ...) 인자들은 deprecated 이고
  // 쓰면 Electron 이 매번 경고를 찍는다. level 도 숫자가 아니라 문자열이다.
  win.webContents.on('console-message', (details) => {
    if (details.level !== 'warning' && details.level !== 'error') return
    const where = details.sourceId ? ` (${details.sourceId}:${details.lineNumber})` : ''
    process.stderr.write(`[${tag}] ${details.message}${where}\n`)
  })
}

function createWindows(config: WaifuConfig): void {
  avatarWindow = createAvatarWindow()
  forwardConsole(avatarWindow, 'avatar:console')
  // 저장된 크기를 시작할 때부터 반영한다. 안 그러면 기본 크기로 떴다가 설정을 만져야 바뀐다.
  applyAvatarScale(avatarWindow, config.avatar.scale)
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
  applyContentSecurityPolicy()
  verifyChildEntries()
  registerIpc()

  // topology가 바뀌면 예전 display 좌표는 더 이상 안전한 목적지가 아니다.
  // 먼저 roam을 끊고 avatarWindow의 기존 listener가 새 작업 영역에 다시 배치하게 둔다.
  const cancelRoamingForDisplayChange = (): void => waifu?.cancelRoaming()
  screen.on('display-metrics-changed', cancelRoamingForDisplayChange)
  screen.on('display-added', cancelRoamingForDisplayChange)
  screen.on('display-removed', cancelRoamingForDisplayChange)

  const config = loadConfig()
  process.stdout.write(`[config] 퍼소나=${config.persona.name} 권한=${config.permission.mode}\n`)
  createWindows(config)
  gazeTimer = startGazeTracking()
  pushToTalk = new PushToTalkHotkey(
    {
      register: (accelerator, callback) => globalShortcut.register(accelerator, callback),
      unregister: (accelerator) => globalShortcut.unregister(accelerator)
    },
    pushToTalkTrigger,
    (message) => process.stdout.write(`${message}\n`)
  )
  pushToTalk.sync(config.voice)

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

    const pending = waifu.activeTasks()
    if (pending.length > 0) {
      process.stdout.write(`[task] 이어서 할 작업 ${pending.length}개\n`)
      // 패널이 아직 준비되지 않았을 수 있다. 로드가 끝난 뒤 알린다.
      panelWindow?.webContents.once('did-finish-load', () => waifu?.reportPendingTasks())
      if (panelWindow?.webContents.isLoading() === false) waifu.reportPendingTasks()
    }
  } catch (err) {
    process.stderr.write(`[waifu] 백엔드 시작 실패: ${String(err)}\n`)
  }

  registerPowerHandlers()
  startDiscord(config)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindows(loadConfig())
  })
})

app.on('before-quit', () => {
  if (gazeTimer) clearInterval(gazeTimer)
  // 핫키를 풀지 않으면 앱이 죽은 뒤에도 다른 앱이 그 조합을 못 쓰는 경우가 있다.
  pushToTalk?.release()
  globalShortcut.unregisterAll()
  stopActiveWhispers()
  discord?.stop()
  void waifu?.stop()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
