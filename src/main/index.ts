import { existsSync, readdirSync } from 'node:fs'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  Notification,
  powerMonitor,
  screen,
  Tray
} from 'electron'
import { IPC } from '@shared/protocol'
import type {
  AvatarCommand,
  AvatarEvent,
  PanelEvent,
  PermissionDecision,
  PermissionRequest,
  WaifuConfig
} from '@shared/protocol'
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
import { agentRuntimeFingerprint, validateAgentWorkspaces } from './config/agentRuntime'
import { monitorAt, placementFor, withPlacement, type MonitorInfo } from './avatar/monitorLayout'
import { Waifu } from './waifu'
import { stopActiveWhispers, transcribe } from './voice/stt'
import { PushToTalkHotkey } from './voice/hotkey'
import { pingEngine } from './voice/tts'
import { DiscordBot } from './discord/bot'
import { UnityAvatarShell } from './avatar/shell'
import { shouldQuitOnClose, startedHidden, syncLaunchAtLogin, trayMenu } from './system/integration'
import { stopOwnedService } from './lifecycle'
import { createMediaWindow } from './windows/mediaWindow'
import { createCompanionWindow, placeCompanionNearCursor } from './windows/companionWindow'

// 둘 다 app 준비 **전에** 걸어야 한다. 준비 후에 부르면 조용히 무시된다.
applyOverlaySwitches()
registerAssetScheme()

let avatarWindow: BrowserWindow | null = null
let companionWindow: BrowserWindow | null = null
let mediaWindow: BrowserWindow | null = null
let panelWindow: BrowserWindow | null = null
let lastFpsLog = 0
let lastAvatarStatus: Extract<AvatarCommand, { type: 'status' }>['state'] = 'idle'
let lastAvatarExpression: Extract<AvatarCommand, { type: 'express' }> | null = null
let unityCommandDropNotified = false
let mediaCommandDropNotified = false
let mediaRecoveryAttempts = 0
let avatarModelReady = false
let companionRecoveryAttempts = 0
let companionRecoveryTimer: NodeJS.Timeout | null = null
let companionStableTimer: NodeJS.Timeout | null = null
const trayOnlyStartup = startedHidden(process.argv)
let desktopAvatarActivated = false
let desktopActivationPromise: Promise<void> | null = null

interface PanelEventRecord {
  sequence: number
  event: PanelEvent
}

const panelEventHistory: PanelEventRecord[] = []
const MAX_PANEL_EVENTS = 600
let panelEventSequence = 0
const hydratedPanelRenderers = new Set<number>()
const panelHydrationTokens = new Map<number, number>()
let nextPanelHydrationToken = 1

function sendPanelEvent(win: BrowserWindow | null, event: PanelEvent): void {
  if (
    !win ||
    win.isDestroyed() ||
    win.webContents.isLoading() ||
    !hydratedPanelRenderers.has(win.webContents.id)
  ) return
  win.webContents.send(IPC.panelEvent, event)
}

function replayPanelEvents(win: BrowserWindow, cutoff: number): void {
  if (win.isDestroyed()) return
  for (const record of panelEventHistory) {
    if (record.sequence <= cutoff) win.webContents.send(IPC.panelEvent, record.event)
  }
}

function resetPanelHydration(id: number): void {
  hydratedPanelRenderers.delete(id)
  panelHydrationTokens.delete(id)
}

function schedulePanelHydration(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const id = win.webContents.id
  if (hydratedPanelRenderers.has(id) || panelHydrationTokens.has(id)) return

  const token = nextPanelHydrationToken
  nextPanelHydrationToken += 1
  panelHydrationTokens.set(id, token)
  // invoke 응답 뒤에 보내야 React의 effect 구독이 먼저 붙는다. 그동안 live 전송은
  // sendPanelEvent가 막고 history에만 쌓으므로 replay와 중복되거나 사이에서 빠지지 않는다.
  setImmediate(() => {
    if (
      win.isDestroyed() ||
      panelHydrationTokens.get(id) !== token
    ) return
    const cutoff = panelEventSequence
    replayPanelEvents(win, cutoff)
    hydratedPanelRenderers.add(id)
    panelHydrationTokens.delete(id)
  })
}

/** 대화 UI가 아직 없어도 이벤트를 잃지 않고, 열린 두 UI에는 동시에 전한다. */
function dispatchPanelEvent(event: PanelEvent, revealError = true): void {
  panelEventSequence += 1
  panelEventHistory.push({ sequence: panelEventSequence, event })
  if (panelEventHistory.length > MAX_PANEL_EVENTS) {
    panelEventHistory.splice(0, panelEventHistory.length - MAX_PANEL_EVENTS)
  }
  sendPanelEvent(companionWindow, event)
  sendPanelEvent(panelWindow, event)

  if (
    event.type === 'notice' &&
    event.level === 'error' &&
    !quitting &&
    !companionWindow?.isVisible() &&
    !panelWindow?.isVisible()
  ) {
    if (Notification.isSupported()) {
      const notification = new Notification({ title: 'waifu-agent', body: event.message })
      notification.on('click', () => showCompanion())
      notification.show()
    }
    // 로그인 자동 실행은 tray-only 계약이다. 사용자가 직접 열기 전에는 오류가 나도
    // 대화 창이나 아바타가 갑자기 튀어나오지 않는다.
    if (revealError && (!trayOnlyStartup || desktopAvatarActivated)) {
      setImmediate(() => showCompanion())
    }
  }
}

/** 드래그 중에는 커서가 실루엣을 벗어나도 클릭 통과로 되돌리면 안 된다. */
let dragging = false
let motionLogTimer: NodeJS.Timeout | null = null

function registerIpc(): void {
  ipcMain.on(IPC.avatarEvent, (ipcEvent, event: AvatarEvent) => {
    // Unity 모드의 숨은 음성 호스트는 녹음과 실제 오디오 종료만 올릴 수 있다.
    // 같은 preload를 쓰는 패널이 아바타 이벤트를 위조하지 못하게 sender를 창에 묶는다.
    if (mediaWindow && !mediaWindow.isDestroyed() && ipcEvent.sender === mediaWindow.webContents) {
      switch (event.type) {
        case 'recording':
          if (!event.on) recordingDesired = false
          else if (!recordingDesired) requestRecording(false)
          else discardRecorded = false
          break
        case 'recorded':
          void handleRecorded(event.wavBase64)
          break
        case 'speech-end':
          // Unity의 글자 수 기반 발화 타이머보다 실제 오디오가 먼저 끝났다면 같이 정리한다.
          unityShell?.send({ type: 'stop-speaking' })
          break
        default:
          break
      }
      return
    }

    const win = avatarWindow
    if (!win || win.isDestroyed() || ipcEvent.sender !== win.webContents) return

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
        // 놓은 자리를 그 모니터의 자리로 기억한다. 드래그 중에 매번 저장하면
        // 설정 파일을 초당 수십 번 쓰게 된다.
        rememberAvatarPlacement(win)
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
          // 숨은 시작 뒤 처음 만들어졌거나 renderer가 재로드된 경우에도 현재 상태를 복원한다.
          const expressionToRestore = lastAvatarExpression
          dispatchAvatarCommand({ type: 'status', state: lastAvatarStatus })
          if (expressionToRestore) dispatchAvatarCommand(expressionToRestore)
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
        showCompanion()
        break

      default:
        break
    }
  })

  ipcMain.handle(IPC.configGet, (ipcEvent) => {
    const win = BrowserWindow.fromWebContents(ipcEvent.sender)
    if (
      win &&
      (win === panelWindow || win === companionWindow)
    ) {
      schedulePanelHydration(win)
    }
    return loadConfig()
  })
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
    if (patch.persona?.name !== undefined) {
      panelWindow?.setTitle(next.persona.name)
      tray?.setToolTip(next.persona.name)
    }
    refreshTray(next)
    dispatchPanelEvent({ type: 'config', config: next })
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

  ipcMain.handle(IPC.diagnostics, () => {
    const current = waifu?.diagnostics()
    if (!current) return null
    const configured = loadConfig()
    return {
      ...current,
      backendRestartRequired:
        appliedAgentFingerprint !== agentRuntimeFingerprint(configured) ||
        (current.runtime === null && validateAgentWorkspaces(configured).ok)
    }
  })
  ipcMain.handle(IPC.pingVoice, (_e, url: string) => pingEngine(url))

  ipcMain.handle(IPC.pickModel, async () => {
    const res = await dialog.showOpenDialog({
      title: '아바타 모델 고르기',
      properties: ['openFile'],
      filters: [{ name: 'VRM / FBX', extensions: ['vrm', 'fbx'] }]
    })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })

  ipcMain.handle(IPC.pickWorkspace, async () => {
    const res = await dialog.showOpenDialog({
      title: '함께 작업할 폴더 고르기',
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })

  ipcMain.handle(IPC.appRestart, async () => restartApplication(loadConfig()))
  ipcMain.handle(IPC.permissionList, () =>
    (waifu?.pendingPermissions() ?? []) satisfies PermissionRequest[]
  )

  ipcMain.on(IPC.sendMessage, (_e, text: string) => {
    const message = text.trim()
    if (!message || !waifu) return
    // 공유 프로토콜을 늘리지 않고 지연 생성되는 두 UI의 대화 기록에 사용자 발화를 남긴다.
    dispatchPanelEvent({ type: 'notice', level: 'info', message: `나 · ${message}` })
    waifu.send(message)
  })
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
    onNotice: (level, message) => dispatchPanelEvent({ type: 'notice', level, message }),
    onRequest: (text, reply) => {
      if (!waifu) {
        reply('아직 준비되지 않았다. 잠시 후 다시 말해줘.')
        return
      }
      // origin 이 'discord' 면 권한이 상한까지 눌린다.
      dispatchPanelEvent({ type: 'notice', level: 'info', message: `나 · ${text}` })
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
    dispatchAvatarCommand({ type: 'wake' })
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
  const win = activeAvatarRenderer === 'unity' ? mediaWindow : avatarWindow
  if (!win || win.isDestroyed()) return
  recordingDesired = on
  if (win.webContents.isLoading()) {
    const intended = on
    win.webContents.once('did-finish-load', () => {
      if (!win.isDestroyed() && recordingDesired === intended) {
        win.webContents.send(IPC.avatarCommand, { type: 'record', on: intended })
      }
    })
    return
  }
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
    if (waifu) dispatchPanelEvent({ type: 'notice', level: 'info', message: `나 · ${text}` })
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
function forwardConsole(
  win: BrowserWindow,
  tag: string,
  onProblem?: (level: 'warning' | 'error', message: string) => void
): void {
  // 이벤트 객체 형태가 현재 API 다. 뒤따라오는 (level, message, ...) 인자들은 deprecated 이고
  // 쓰면 Electron 이 매번 경고를 찍는다. level 도 숫자가 아니라 문자열이다.
  win.webContents.on('console-message', (details) => {
    if (details.level !== 'warning' && details.level !== 'error') return
    const where = details.sourceId ? ` (${details.sourceId}:${details.lineNumber})` : ''
    process.stderr.write(`[${tag}] ${details.message}${where}\n`)
    onProblem?.(details.level, details.message)
  })
}

function recoverMediaWindow(media: BrowserWindow, reason: string): void {
  if (quitting || restartingApplication || mediaWindow !== media) return
  mediaWindow = null
  if (!media.isDestroyed()) media.destroy()

  if (mediaRecoveryAttempts >= 2) {
    dispatchPanelEvent({
      type: 'notice',
      level: 'error',
      message: `음성 장치가 반복해서 종료됐다 (${reason}). 관리·기록에서 앱을 다시 시작해줘.`
    })
    return
  }

  mediaRecoveryAttempts += 1
  dispatchPanelEvent({
    type: 'notice',
    level: 'warn',
    message: `음성 장치가 종료돼 다시 연결하고 있어 (${reason}).`
  })
  setTimeout(() => {
    if (!quitting && !restartingApplication && !mediaWindow) createWindows(loadConfig(), false)
  }, 250)
}

function resetCompanionRecovery(): void {
  companionRecoveryAttempts = 0
  if (companionRecoveryTimer) clearTimeout(companionRecoveryTimer)
  if (companionStableTimer) clearTimeout(companionStableTimer)
  companionRecoveryTimer = null
  companionStableTimer = null
}

/**
 * Electron이 종료될 때 숨은 media renderer까지 명시적으로 없앤다.
 *
 * Unity 모드에서는 mediaWindow가 보이지 않으므로 사용자 창을 모두 닫아도
 * `window-all-closed`가 오지 않는다. 앱 종료 게이트가 자식 프로세스를 정리한 뒤 이 창들을
 * 직접 파괴해야 마이크/AudioContext와 renderer 프로세스도 확실히 내려간다.
 */
function destroyOwnedRendererWindows(): void {
  resetCompanionRecovery()
  const windows = [companionWindow, panelWindow, avatarWindow, mediaWindow]
  companionWindow = null
  panelWindow = null
  avatarWindow = null
  mediaWindow = null
  for (const win of windows) {
    if (!win || win.isDestroyed()) continue
    try {
      win.destroy()
    } catch (error) {
      process.stderr.write(`[app] renderer 창 종료 실패: ${String(error)}\n`)
    }
  }
}

function recoverCompanionWindow(
  companion: BrowserWindow,
  rendererId: number,
  reason: string
): void {
  if (quitting || restartingApplication || companionWindow !== companion) return
  companionWindow = null
  resetPanelHydration(rendererId)
  if (companionStableTimer) {
    clearTimeout(companionStableTimer)
    companionStableTimer = null
  }
  try {
    if (!companion.isDestroyed()) companion.destroy()
  } catch (error) {
    process.stderr.write(`[companion] 죽은 창 정리 실패: ${String(error)}\n`)
  }

  if (companionRecoveryAttempts >= 2) {
    dispatchPanelEvent({
      type: 'notice',
      level: 'error',
      message: `대화 카드가 반복해서 종료됐다 (${reason}). 트레이에서 다시 열어줘.`
    }, false)
    return
  }

  companionRecoveryAttempts += 1
  const delayMs = 400 * 2 ** (companionRecoveryAttempts - 1)
  dispatchPanelEvent({
    type: 'notice',
    level: 'warn',
    message: `대화 카드가 종료돼 다시 열고 있어 (${reason}).`
  })
  if (companionRecoveryTimer) clearTimeout(companionRecoveryTimer)
  companionRecoveryTimer = setTimeout(() => {
    companionRecoveryTimer = null
    if (!quitting && !restartingApplication && !companionWindow) showCompanion()
  }, delayMs)
}

/**
 * 없는 창만 만든다.
 *
 * **각 창을 따로 보는 것이 핵심이다.** 예전에는 둘을 무조건 새로 만들었는데,
 * 패널만 닫은 상태에서 트레이로 되살리면 아바타가 하나 더 뜨고 원래 것은
 * 참조를 잃은 채 화면에 남았다. 투명하고 클릭이 통과하는 창이라 그 유령은
 * 닫을 방법도 없다.
 */
function createWindows(config: WaifuConfig, includePanel = true): void {
  if (activeAvatarRenderer === 'renderer' && (!avatarWindow || avatarWindow.isDestroyed())) {
    const avatar = createAvatarWindow()
    avatarWindow = avatar
    forwardConsole(avatar, 'avatar:console')
    // 저장된 크기를 시작할 때부터 반영한다. 안 그러면 기본 크기로 떴다가 설정을 만져야 바뀐다.
    applyAvatarScale(avatar, config.avatar.scale)

    // once 가 아니라 on 이어야 한다 — 개발 중 HMR 로 페이지가 다시 로드되면 씬이 새로
    // 만들어지므로, 한 번만 보내면 그 뒤로는 빈 아바타가 남는다.
    avatar.webContents.on('did-finish-load', () => sendModel(avatar, config))
    // 저장된 자리로 되돌린다. ready-to-show 뒤여야 창 크기가 확정된다.
    avatar.once('ready-to-show', () => restoreAvatarPlacement(avatar))
    avatar.on('closed', () => {
      if (avatarWindow === avatar) avatarWindow = null
    })
  }

  if (activeAvatarRenderer === 'unity' && (!mediaWindow || mediaWindow.isDestroyed())) {
    const media = createMediaWindow()
    mediaWindow = media
    forwardConsole(media, 'media:console', (level, message) => {
      dispatchPanelEvent({
        type: 'notice',
        level: level === 'error' ? 'error' : 'warn',
        message
      })
    })
    media.webContents.on('did-finish-load', () => {
      mediaCommandDropNotified = false
      if (recordingDesired) {
        media.webContents.send(IPC.avatarCommand, { type: 'record', on: true })
      }
      setTimeout(() => {
        if (mediaWindow === media && !media.isDestroyed()) mediaRecoveryAttempts = 0
      }, 30_000)
    })
    media.webContents.on('render-process-gone', (_event, details) => {
      recoverMediaWindow(media, details.reason)
    })
    media.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return
      recoverMediaWindow(media, `${description} (${url})`)
    })
    media.on('closed', () => {
      if (mediaWindow === media) mediaWindow = null
    })
  }

  if (includePanel && (!panelWindow || panelWindow.isDestroyed())) {
    const panel = createPanelWindow(config.persona.name)
    const panelRendererId = panel.webContents.id
    panelWindow = panel
    // 아바타만 콘솔을 넘겨받고 패널은 아니었다. 그래서 패널 렌더러가 통째로 죽어도
    // 로그에는 아무것도 남지 않고 "창이 비어 있다" 로만 보였다.
    forwardConsole(panel, 'panel:console')
    panel.webContents.on('did-start-loading', () => resetPanelHydration(panelRendererId))
    panel.on('closed', () => {
      resetPanelHydration(panelRendererId)
      if (panelWindow === panel) panelWindow = null
      // 아바타/숨은 media 창이 남아 있으면 Electron의 window-all-closed는 오지 않는다.
      // 트레이로 숨기지 않는 설정에서는 visible 창을 닫는 동작이 프로그램 종료여야 한다.
      if (
        !quitting &&
        !restartingApplication &&
        shouldQuitOnClose(loadConfig(), tray !== null)
      ) {
        app.quit()
      }
    })
  }
}

let gazeTimer: NodeJS.Timeout | null = null
let waifu: Waifu | null = null
/** 이 앱 프로세스를 띄울 때 실제 적용된 시작 스냅샷 설정. */
let appliedAgentFingerprint: string | null = null
let unityShell: UnityAvatarShell | null = null
let tray: Tray | null = null
/** 저장 설정이 바뀌어도 앱 재시작 전까지 렌더러 두 개를 섞지 않는다. */
let activeAvatarRenderer: WaifuConfig['avatar']['renderer'] = 'renderer'
/** 트레이의 '종료' 를 눌렀는가. 창 닫기와 진짜 종료를 구분한다. */
let quitting = false
/** 연타로 relaunch를 여러 개 예약하지 않는다. */
let restartingApplication = false
/** 초기 Unity/Agent Core/트레이 배선이 끝나기 전에 restart가 수명주기를 가로채지 않는다. */
let startupComplete = false
/** relaunch를 예약한 뒤의 app.quit만 before-quit 게이트를 통과시킨다. */
let relaunchCommitted = false
/** 종료 정리 중 사용자가 다시 실행하면 현재 종료 뒤 보이는 인스턴스를 한 번 다시 띄운다. */
let reopenAfterShutdown = false
/** Electron이 실제로 끝나도 되는 시점. 자식 프로세스와 localhost 서버 정리를 먼저 확인한다. */
let shutdownReady = false
let shutdownFailed = false
let shutdownPromise: Promise<void> | null = null
/**
 * 아바타가 자고 있는가. 셸이 올리는 `presence` 이벤트가 유일한 출처다.
 *
 * 셸은 유휴 시간이나 시간대를 보고 **스스로** 잠들기도 한다. 그래서 main 이
 * 마지막으로 보낸 명령만 기억하면 실제 상태와 어긋난다.
 */
let avatarAsleep = false

function createAgentCore(config: WaifuConfig): Waifu {
  const next = new Waifu(
    config,
    () => avatarWindow,
    () => companionWindow,
    (command) => dispatchAvatarCommand(command),
    () => showCompanion(),
    (event) => dispatchPanelEvent(event)
  )
  if (discord) next.onRemoteReport = (text) => void discord?.report(text)
  return next
}

/**
 * Agent Core의 상태·표정·발화를 현재 앱 시작 때 선택된 아바타 한 곳으로만 보낸다.
 * 저장 설정만 바뀐 상태에서 두 렌더러가 동시에 반응하지 않도록 startup 스냅샷을 본다.
 */
function dispatchAvatarCommand(command: AvatarCommand): void {
  if (command.type === 'status') {
    lastAvatarStatus = command.state
    // Unity의 non-speaking 상태는 자체 placeholder 표정을 덮어쓴다. 그보다 오래된
    // express를 재연결 뒤 다시 적용하면 live 상태와 달라지므로 순서대로 무효화한다.
    if (command.state !== 'speaking') lastAvatarExpression = null
  }
  if (command.type === 'express') lastAvatarExpression = command
  if (command.type === 'say' && command.emotion) {
    lastAvatarExpression = { type: 'express', emotion: command.emotion, intensity: 1 }
  }
  if (activeAvatarRenderer === 'unity') {
    // 실제 WAV는 Electron의 숨은 음성 호스트가 재생한다. Unity에는 화면/몸짓에 필요한
    // 필드만 보내 큰 base64 오디오를 로컬 WebSocket과 JsonUtility에 흘리지 않는다.
    const unityCommand: AvatarCommand =
      command.type === 'say'
        ? {
            type: 'say',
            id: command.id,
            text: command.text,
            ...(command.emotion ? { emotion: command.emotion } : {}),
            ...(command.motion ? { motion: command.motion } : {})
          }
        : command
    const sent = unityShell?.send(unityCommand) ?? false

    if (command.type === 'say' && command.audio && command.visemes) {
      const media = mediaWindow
      const canPlay = media && !media.isDestroyed() && !media.webContents.isLoading()
      if (canPlay) {
        media.webContents.send(IPC.avatarCommand, command)
        mediaCommandDropNotified = false
      } else if (startupComplete && !mediaCommandDropNotified) {
        mediaCommandDropNotified = true
        dispatchPanelEvent({
          type: 'notice',
          level: 'warn',
          message: '음성 장치가 준비되지 않아 이번 말은 자막과 몸짓만 재생했다.'
        })
      }
    } else if (command.type === 'stop-speaking') {
      const media = mediaWindow
      if (media && !media.isDestroyed() && !media.webContents.isLoading()) {
        media.webContents.send(IPC.avatarCommand, command)
      }
    }

    if (!sent && startupComplete && !unityCommandDropNotified) {
      unityCommandDropNotified = true
      dispatchPanelEvent({
        type: 'notice',
        level: 'warn',
        message: 'Unity 아바타 연결이 끊겨 몸짓 명령을 보내지 못했다. 다시 연결되면 현재 상태를 맞춘다.'
      })
    }
    return
  }
  const win = avatarWindow
  if (win && !win.isDestroyed()) win.webContents.send(IPC.avatarCommand, command)
}

function reportPendingTasks(agent: Waifu): void {
  const pending = agent.activeTasks()
  if (pending.length === 0) return
  process.stdout.write(`[task] 이어서 할 작업 ${pending.length}개\n`)
  // UI는 시작 때 존재하지 않는다. sink가 이벤트를 기록하므로 지금 보고해 두면 첫 개방 때 재생된다.
  agent.reportPendingTasks()
}

/**
 * 앱 시작 시 Agent Core 저장소는 열되, 안전한 작업 폴더가 없으면 백엔드는 띄우지 않는다.
 * 홈 폴더로 조용히 대체하면 UI에 보인 범위와 실제 cwd가 달라진다.
 */
async function initializeAgentCore(config: WaifuConfig): Promise<void> {
  const next = createAgentCore(config)
  waifu = next

  const workspace = validateAgentWorkspaces(config)
  if (!workspace.ok) {
    process.stdout.write(`[waifu] 백엔드 시작 보류: ${workspace.reason}\n`)
    return
  }

  await next.start(workspace.cwd)
  appliedAgentFingerprint = agentRuntimeFingerprint(config)
  process.stdout.write(`[waifu] 백엔드 시작 (cwd=${workspace.cwd})\n`)
  reportPendingTasks(next)
}

/** 로그인 자동 실행의 `--hidden`을 다음 명시적 재실행까지 끌고 가지 않는다. */
function relaunchVisible(): void {
  app.relaunch({ args: process.argv.slice(1).filter((arg) => arg !== '--hidden') })
}

/**
 * 시작 스냅샷 설정은 Agent Core뿐 아니라 Unity·트레이·로그인 실행까지 걸친다.
 * 일부만 뜯어 다시 만들면 서로 다른 시점의 설정이 섞이므로 앱 전체를 한 번만 재실행한다.
 */
async function restartApplication(
  config: WaifuConfig
): Promise<{ ok: boolean; reason?: string }> {
  if (restartingApplication || quitting) {
    return { ok: false, reason: '이미 앱을 다시 시작하고 있다.' }
  }
  if (!startupComplete) {
    return { ok: false, reason: '프로그램 시작이 끝난 뒤 다시 눌러줘.' }
  }
  if (waifu?.diagnostics().busy) {
    return { ok: false, reason: '현재 작업이 끝나거나 중단된 뒤 새 설정을 적용할 수 있다.' }
  }

  restartingApplication = true
  let cleanupStarted = false
  try {
    dispatchPanelEvent({
      type: 'notice',
      level: 'info',
      message: '저장된 설정을 적용하려고 앱을 다시 시작한다.'
    })

    const previous = waifu
    const currentUnity = unityShell
    cleanupStarted = true
    const shutdowns = await Promise.allSettled([
      previous ? stopOwnedService(() => previous.stop()) : Promise.resolve(),
      currentUnity ? stopOwnedService(() => currentUnity.stop()) : Promise.resolve()
    ])
    const failures = shutdowns.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        '기존 프로그램 프로세스를 완전히 닫지 못했다'
      )
    }
    waifu = null
    unityShell = null
    try {
      discord?.stop()
    } catch (err) {
      process.stderr.write(`[restart] Discord 종료 중 오류: ${String(err)}\n`)
    }
    discord = null
    pushToTalk?.release()
    stopActiveWhispers()

    destroyOwnedRendererWindows()
    relaunchVisible()
    relaunchCommitted = true
    quitting = true
    // invoke 응답이 렌더러에 돌아갈 한 틱은 남기고 현재 프로세스를 닫는다.
    setImmediate(() => app.quit())
    return { ok: true }
  } catch (err) {
    restartingApplication = false
    relaunchCommitted = false
    const reason = `앱을 다시 시작할 준비를 하지 못했다: ${String(err)}`
    dispatchPanelEvent({ type: 'notice', level: 'error', message: reason })
    process.stderr.write(`[waifu] ${reason}\n`)
    if (cleanupStarted) {
      // Waifu/Unity stop은 되돌릴 수 없다. 현재 앱을 ready처럼 남기면 입력만 받는 반쪽
      // 프로그램이 된다. 자동 relaunch가 실패한 경우 명시적으로 끝내고 수동 재실행을 유도한다.
      quitting = true
      setTimeout(() => app.quit(), 250)
    } else quitting = false
    return { ok: false, reason }
  }
}

/** 정상 종료도 자식 CLI·Unity·localhost 제어 서버가 닫힐 때까지 Electron을 붙잡는다. */
function prepareForExit(): Promise<void> {
  if (shutdownPromise) return shutdownPromise
  const operation = (async () => {
    quitting = true
    discardRecorded = true
    try {
      requestRecording(false)
    } catch (err) {
      process.stderr.write(`[voice] 종료 중 녹음 정리 실패: ${String(err)}\n`)
    }
    if (gazeTimer) {
      clearInterval(gazeTimer)
      gazeTimer = null
    }
    try {
      pushToTalk?.release()
      globalShortcut.unregisterAll()
      stopActiveWhispers()
    } catch (err) {
      process.stderr.write(`[app] 로컬 입력 정리 실패: ${String(err)}\n`)
    }
    try {
      discord?.stop()
    } catch (err) {
      process.stderr.write(`[discord] 종료 중 오류: ${String(err)}\n`)
    }

    const currentWaifu = waifu
    const currentUnity = unityShell
    const shutdowns = await Promise.allSettled([
      currentWaifu
        ? stopOwnedService(
            () => currentWaifu.stop(),
            2,
            (_attempt, error) =>
              process.stderr.write(`[app] Agent Core 종료 재시도: ${String(error)}\n`)
          )
        : Promise.resolve(),
      currentUnity
        ? stopOwnedService(
            () => currentUnity.stop(),
            2,
            (_attempt, error) => process.stderr.write(`[app] Unity 종료 재시도: ${String(error)}\n`)
          )
        : Promise.resolve()
    ])
    const failures = shutdowns.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    if (failures.length > 0) {
      for (const failure of failures) {
        process.stderr.write(`[app] 종료 정리 실패: ${String(failure.reason)}\n`)
      }
      // 두 번의 강제 종료 시도 뒤에는 일부 서비스만 멈춘 반쪽 앱으로 되돌아갈 수 없다.
      // renderer와 tray를 내리고 비정상 종료해 OS/감시자가 실패를 분명히 알게 한다.
      destroyOwnedRendererWindows()
      try {
        tray?.destroy()
      } catch (error) {
        process.stderr.write(`[tray] 실패 종료 중 오류: ${String(error)}\n`)
      }
      tray = null
      // 소유 child의 종료를 확인하지 못했으므로 새 인스턴스를 겹쳐 띄우지 않는다.
      reopenAfterShutdown = false
      shutdownFailed = true
      shutdownReady = true
      setImmediate(() => app.exit(1))
      return
    }

    if (waifu === currentWaifu) waifu = null
    if (unityShell === currentUnity) unityShell = null
    destroyOwnedRendererWindows()
    try {
      tray?.destroy()
    } catch (err) {
      process.stderr.write(`[tray] 종료 중 오류: ${String(err)}\n`)
    }
    tray = null
    if (reopenAfterShutdown && !relaunchCommitted) {
      try {
        relaunchVisible()
        relaunchCommitted = true
      } catch (error) {
        process.stderr.write(`[app] 종료 뒤 재실행 예약 실패: ${String(error)}\n`)
      }
    }
    shutdownFailed = false
    shutdownReady = true
    setImmediate(() => app.quit())
  })()
  shutdownPromise = operation
  void operation.then(() => {
    // 종료 예약 전 예외가 난 경우에만 다음 사용자 요청이 정리를 다시 시도한다.
    if (!shutdownReady && shutdownPromise === operation) shutdownPromise = null
  })
  return operation
}

/**
 * 시스템 트레이. 창을 닫아도 앱이 남는 설정에서는 **되살릴 유일한 입구**다.
 *
 * 아이콘 파일이 없으면 트레이를 만들지 않는다. Electron 은 빈 아이콘으로도 Tray 를
 * 만들어주는데, Windows 에서 그건 클릭할 수 없는 투명한 칸으로 보인다 —
 * 트레이로 숨은 앱을 되살릴 방법이 없어진다.
 */
function setUpTray(config: WaifuConfig): void {
  if (!config.system.trayIcon) return

  const iconPath = join(app.getAppPath(), 'resources', 'tray.png')
  if (!existsSync(iconPath)) {
    // 트레이가 없으면 '창을 닫아도 트레이에 남기' 도 같이 무력화된다
    // (shouldQuitOnClose 가 트레이의 실재를 본다). 그 사실까지 알려준다.
    process.stderr.write(
      `[tray] 아이콘이 없어 트레이를 만들지 않는다: ${iconPath}\n` +
        '[tray] 창을 닫으면 앱이 종료된다. `npm run tray:icon` 으로 아이콘을 만들 수 있다.\n'
    )
    return
  }

  tray = new Tray(iconPath)
  tray.setToolTip(config.persona.name)
  refreshTray(config)

  // 더블클릭으로 채팅을 연다. 메뉴를 거치지 않는 빠른 길이 있어야 한다.
  tray.on('double-click', () => showPanel())
}

function refreshTray(config: WaifuConfig): void {
  if (!tray) return

  const avatarReady =
    activeAvatarRenderer === 'renderer'
      ? Boolean(avatarWindow && !avatarWindow.isDestroyed())
      : avatarModelReady
  const template = trayMenu(config, avatarReady, avatarAsleep).map((item) => {
    if (item.type === 'separator') return { type: 'separator' as const }
    return {
      label: item.label,
      type: item.type === 'checkbox' ? ('checkbox' as const) : ('normal' as const),
      checked: item.checked,
      enabled: item.id !== 'status',
      click: () => onTrayClick(item.id ?? '')
    }
  })
  tray.setContextMenu(Menu.buildFromTemplate(template))
}

function onTrayClick(id: string): void {
  const config = loadConfig()
  switch (id) {
    case 'show-panel':
      showPanel()
      break

    case 'toggle-sleep': {
      // 실제 상태를 뒤집는다. 셸이 스스로 잠든 경우에도 이 값이 맞다.
      const next = !avatarAsleep
      if (unityShell?.send({ type: 'set-presence', asleep: next })) {
        // 낙관적으로 반영해 메뉴가 곧바로 바뀌게 한다. 어긋나면 셸이 올려주는
        // presence 이벤트가 곧 정정한다.
        avatarAsleep = next
        refreshTray(config)
      }
      break
    }

    case 'launch-at-login': {
      const next: WaifuConfig = {
        ...config,
        system: { ...config.system, launchAtLogin: !config.system.launchAtLogin }
      }
      saveConfig(next)
      syncLaunchAtLogin(app, next)
      refreshTray(next)
      break
    }

    case 'quit':
      if (restartingApplication && !relaunchCommitted) {
        dispatchPanelEvent({
          type: 'notice',
          level: 'info',
          message: '기존 프로세스를 정리하고 있어. 잠깐만 기다려줘.'
        })
        break
      }
      quitting = true
      app.quit()
      break
  }
}

/** Electron 의 Display 를 monitorLayout 이 아는 모양으로 옮긴다. */
function monitorInfos(): MonitorInfo[] {
  return screen.getAllDisplays().map((display) => ({
    bounds: { ...display.bounds },
    scaleFactor: display.scaleFactor
  }))
}

/**
 * 아바타를 놓은 자리를 그 모니터의 자리로 저장한다.
 *
 * `monitorLayout.ts` 는 처음부터 있었지만 아무도 부르지 않아서,
 * `rememberPerMonitor` 설정이 켜져 있어도 아무것도 기억하지 않았다.
 */
function rememberAvatarPlacement(win: BrowserWindow): void {
  const config = loadConfig()
  if (!config.avatar.rememberPerMonitor) return
  if (win.isDestroyed()) return

  const bounds = win.getBounds()
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
  const monitor = monitorAt(center, monitorInfos())
  // 어느 모니터에도 안 걸리면 저장하지 않는다. 모니터를 뽑는 순간의 좌표를
  // 기억해두면 다음에 그 자리로 되돌아가려다 화면 밖에 선다.
  if (!monitor) return

  const work = screen.getDisplayNearestPoint(center).workArea
  const anchor = {
    x: work.width > bounds.width ? (bounds.x - work.x) / (work.width - bounds.width) : 0,
    y: work.height > bounds.height ? 1 - (bounds.y - work.y) / (work.height - bounds.height) : 0
  }

  saveConfig({
    avatar: {
      ...config.avatar,
      perMonitor: withPlacement(config, monitor, { anchor, scale: config.avatar.scale })
    }
  })
}

/**
 * 지금 아바타가 있는 모니터에 저장된 배치를 되살린다.
 *
 * 모니터를 붙였다 뗐다 하면 해상도와 배치가 바뀐다. 하나만 기억하면 그때마다
 * 아바타가 엉뚱한 자리에 뜨거나 화면 밖으로 나간다 — 투명하고 클릭이 통과하는
 * 창이라 화면 밖으로 나가면 되찾을 방법이 없다.
 */
function restoreAvatarPlacement(win: BrowserWindow): void {
  const config = loadConfig()
  if (!config.avatar.rememberPerMonitor || win.isDestroyed()) return

  const bounds = win.getBounds()
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
  const monitor = monitorAt(center, monitorInfos())
  if (!monitor) return

  const placement = placementFor(config, monitor)
  const work = screen.getDisplayNearestPoint(center).workArea
  win.setBounds({
    ...bounds,
    x: Math.round(work.x + (work.width - bounds.width) * placement.anchor.x),
    y: Math.round(work.y + (work.height - bounds.height) * (1 - placement.anchor.y))
  })
  if (placement.scale !== config.avatar.scale) applyAvatarScale(win, placement.scale)
}

function showPanel(): BrowserWindow | null {
  if (quitting || restartingApplication) return null
  void activateDesktopAvatar()
  if (panelWindow && !panelWindow.isDestroyed()) {
    if (panelWindow.isMinimized()) panelWindow.restore()
    panelWindow.show()
    panelWindow.focus()
    return panelWindow
  }
  createWindows(loadConfig(), true)
  const panel = panelWindow
  if (!panel) return null
  if (panel.webContents.isLoading()) {
    panel.once('ready-to-show', () => {
      if (!panel.isDestroyed()) panel.focus()
    })
  } else {
    panel.show()
    panel.focus()
  }
  return panel
}

function showCompanion(): BrowserWindow | null {
  if (quitting || restartingApplication) return null
  if (!app.isReady()) {
    void app.whenReady().then(() => showCompanion())
    return null
  }
  void activateDesktopAvatar()
  if (companionWindow && !companionWindow.isDestroyed()) {
    placeCompanionNearCursor(companionWindow)
    if (companionWindow.isMinimized()) companionWindow.restore()
    companionWindow.show()
    companionWindow.focus()
    return companionWindow
  }

  const companion = createCompanionWindow()
  const companionRendererId = companion.webContents.id
  let rendererCrashed = false
  companionWindow = companion
  forwardConsole(companion, 'companion:console', (level, message) => {
    dispatchPanelEvent({
      type: 'notice',
      level: level === 'error' ? 'error' : 'warn',
      message
    })
  })
  companion.webContents.on('did-start-loading', () => resetPanelHydration(companionRendererId))
  companion.webContents.on('did-finish-load', () => {
    if (companionStableTimer) clearTimeout(companionStableTimer)
    companionStableTimer = setTimeout(() => {
      if (companionWindow === companion && !companion.isDestroyed()) {
        companionRecoveryAttempts = 0
        companionStableTimer = null
      }
    }, 30_000)
  })
  companion.webContents.on('render-process-gone', (_event, details) => {
    rendererCrashed = true
    recoverCompanionWindow(companion, companionRendererId, details.reason)
  })
  companion.webContents.on(
    'did-fail-load',
    (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3 || rendererCrashed) return
      rendererCrashed = true
      recoverCompanionWindow(companion, companionRendererId, `${description} (${url})`)
    }
  )
  companion.once('ready-to-show', () => {
    if (!companion.isDestroyed()) {
      companion.show()
      companion.focus()
    }
  })
  companion.on('closed', () => {
    resetPanelHydration(companionRendererId)
    if (companionWindow === companion) companionWindow = null
    if (!rendererCrashed) resetCompanionRecovery()
  })
  return companion
}

/**
 * Unity 셸이 올린 이벤트.
 *
 * **렌더러용 `IPC.avatarEvent` 핸들러를 재사용하지 않는다.** 저쪽은 Electron 아바타
 * 창을 직접 조작한다 (클릭 통과 토글, setBounds). Unity 는 자기 창을 스스로 관리하므로
 * 같은 코드를 태우면 존재하지도 않는 창을 만지려 든다.
 *
 * main -> Unity 명령은 `dispatchAvatarCommand`로 이어져 있다. 여기서는 반대 방향인
 * 셸 이벤트를 패널·트레이 상태로 번역한다.
 */
function handleUnityEvent(event: AvatarEvent): void {
  switch (event.type) {
    case 'model-loaded':
      avatarModelReady = event.ok
      refreshTray(loadConfig())
      if (event.ok) {
        process.stdout.write(
          `[unity] 모델 로드 성공 (표정 ${event.presets.length}종, 시선 ${event.hasLookAt ? '있음' : '없음'})\n`
        )
        // 연결 전에 흘러간 초기 상태가 있더라도 모델이 준비된 순간 마지막 상태·표정으로 맞춘다.
        unityCommandDropNotified = false
        unityShell?.send({ type: 'status', state: lastAvatarStatus })
        if (lastAvatarExpression) unityShell?.send(lastAvatarExpression)
      } else {
        process.stderr.write(`[unity] 모델 로드 실패: ${event.error}\n`)
        dispatchPanelEvent({
          type: 'notice',
          level: 'error',
          message: `아바타 모델을 불러오지 못했다: ${event.error}`
        })
      }
      break

    case 'clicked':
      process.stdout.write('[unity] 아바타 클릭\n')
      showCompanion()
      break

    /**
     * 셸이 스스로 잠들거나 깼다.
     *
     * **main 이 이걸 알아야 한다.** 모르면 자는 아바타에게 말을 걸어놓고 왜
     * 반응이 없는지 알 수 없고, 트레이의 '재우기' 체크 상태도 실제와 어긋난다.
     * 예전에는 이 이벤트를 통째로 무시해서 정확히 그 상태였다.
     */
    case 'presence':
      avatarAsleep = event.asleep
      process.stdout.write(`[unity] 아바타 ${event.asleep ? '잠듦' : '깨어남'}\n`)
      refreshTray(loadConfig())
      break

    case 'speech-end':
      process.stdout.write(`[unity] 발화 종료 ${event.id}\n`)
      break

    case 'motions':
      waifu?.setMotions(event.names)
      process.stdout.write(
        `[unity] 에이전트가 부를 수 있는 모션 ${event.names.length}개: ${event.names.join(', ') || '(없음)'}\n`
      )
      break

    // hover 와 fps 는 초당 여러 번 온다. 로그로 흘리면 다른 것이 안 보인다.
    case 'hover':
    case 'fps':
      break

    default:
      break
  }
}

/**
 * Unity Avatar Shell 을 띄운다. `avatar.renderer` 가 'unity' 일 때만 동작한다.
 *
 * 실패해도 앱을 멈추지 않는다 — 셸이 없어도 에이전트는 계속 일할 수 있어야 하고,
 * 채팅 패널은 그대로 쓸 수 있다. 다만 **조용히 넘어가지는 않는다.**
 */
async function startUnityShell(config: WaifuConfig): Promise<void> {
  if (unityShell) return
  unityShell = new UnityAvatarShell(config, {
    onEvent: (event) => handleUnityEvent(event),
    onConnectionChanged: (_connected) => {
      // 새 연결도 아직 모델이 준비된 상태는 아니다. model-loaded 성공이 유일한 ready 신호다.
      avatarModelReady = false
      refreshTray(loadConfig())
    },
    notify: (level, message) => {
      const stream = level === 'error' ? process.stderr : process.stdout
      stream.write(`[unity] ${message}\n`)
      refreshTray(loadConfig())
      if (level !== 'info') dispatchPanelEvent({ type: 'notice', level, message })
    }
  })
  try {
    await unityShell.start()
  } catch (err) {
    process.stderr.write(`[unity] 셸 시작 실패: ${String(err)}\n`)
  }
}

/**
 * 로그인 자동 실행은 tray만 만들고, 사용자가 앱을 명시적으로 열었을 때 여기서 아바타를 깨운다.
 * 여러 진입점(두 번째 실행, tray, macOS activate)이 겹쳐도 Unity는 한 번만 시작한다.
 */
function activateDesktopAvatar(config = loadConfig()): Promise<void> {
  desktopAvatarActivated = true
  activeAvatarRenderer = config.avatar.renderer
  createWindows(config, false)

  if (activeAvatarRenderer === 'renderer') {
    if (!gazeTimer) gazeTimer = startGazeTracking()
    refreshTray(config)
    return Promise.resolve()
  }
  if (unityShell) return Promise.resolve()
  if (desktopActivationPromise) return desktopActivationPromise

  const activation = startUnityShell(config)
  let tracked: Promise<void>
  tracked = activation.finally(() => {
    if (desktopActivationPromise === tracked) desktopActivationPromise = null
  })
  desktopActivationPromise = tracked
  return tracked
}

/**
 * 두 번째 인스턴스는 뜨지 않고 **이미 떠 있는 창을 앞으로 꺼낸다.**
 *
 * 이게 없으면 앱이 트레이에 숨어 있을 때 다시 실행해도 아무 일이 없는 것처럼
 * 보인다 — 새 인스턴스가 조용히 죽거나, 아바타가 두 개 뜬다. 실제로 겪은 쪽은
 * 전자였다: 창을 닫아 숨은 프로세스가 남아 있는 채로 다시 실행하니 개발 서버가
 * 포트를 뺏겨 아무 창도 뜨지 않았다.
 *
 * `whenReady` 앞이어야 한다. 락을 얻지 못했다면 초기화를 시작할 이유가 없다.
 */
const ownsSingleInstance = app.requestSingleInstanceLock()
if (!ownsSingleInstance) {
  process.stdout.write('[app] 이미 실행 중이다. 그쪽 창을 띄우고 이 인스턴스는 끝낸다.\n')
  app.quit()
}

if (ownsSingleInstance) {
app.on('second-instance', () => {
  if (quitting || restartingApplication) {
    reopenAfterShutdown = true
    // 정리 완료와 실제 프로세스 종료 사이의 짧은 틈에 들어온 실행 의도도 잃지 않는다.
    if (shutdownReady && !shutdownFailed && !relaunchCommitted) {
      try {
        relaunchVisible()
        relaunchCommitted = true
      } catch (error) {
        process.stderr.write(`[app] 종료 직전 재실행 예약 실패: ${String(error)}\n`)
      }
    }
    return
  }
  void activateDesktopAvatar()
  showCompanion()
})

void app.whenReady().then(async () => {
  handleAssetProtocol()
  applyContentSecurityPolicy()
  verifyChildEntries()
  registerIpc()

  // topology가 바뀌면 예전 display 좌표는 더 이상 안전한 목적지가 아니다.
  // 먼저 roam을 끊고 avatarWindow의 기존 listener가 새 작업 영역에 다시 배치하게 둔다.
  const onDisplayChange = (): void => {
    waifu?.cancelRoaming()
    // 모니터 구성이 바뀌면 그 모니터에 저장해 둔 자리로 다시 앉힌다.
    // 안 하면 해상도가 바뀐 뒤 아바타가 화면 밖에 남는다.
    if (avatarWindow && !avatarWindow.isDestroyed()) restoreAvatarPlacement(avatarWindow)
  }
  screen.on('display-metrics-changed', onDisplayChange)
  screen.on('display-added', onDisplayChange)
  screen.on('display-removed', onDisplayChange)

  const config = loadConfig()
  process.stdout.write(`[config] 퍼소나=${config.persona.name} 권한=${config.permission.mode}\n`)
  activeAvatarRenderer = config.avatar.renderer
  appliedAgentFingerprint = agentRuntimeFingerprint(config)
  // 평소의 주 UI는 데스크톱 아바타다. 캐릭터 클릭은 작은 대화 카드를 열고,
  // 큰 관리/기록 패널은 트레이에서만 명시적으로 연다.
  // Unity/백엔드 초기화가 오래 걸리거나 실패해도 종료·관리 진입점은 먼저 있어야 한다.
  setUpTray(config)
  if (trayOnlyStartup && tray) {
    process.stdout.write('[app] 로그인 자동 실행: 트레이에서 조용히 시작했다.\n')
  } else {
    if (trayOnlyStartup) {
      process.stderr.write('[app] 트레이를 만들지 못해 숨은 시작 대신 아바타를 표시한다.\n')
    }
    await activateDesktopAvatar(config)
    if (quitting) return
  }
  pushToTalk = new PushToTalkHotkey(
    {
      register: (accelerator, callback) => globalShortcut.register(accelerator, callback),
      unregister: (accelerator) => globalShortcut.unregister(accelerator)
    },
    pushToTalkTrigger,
    (message) => process.stdout.write(`${message}\n`)
  )
  pushToTalk.sync(config.voice)

  try {
    await initializeAgentCore(config)
  } catch (err) {
    process.stderr.write(`[waifu] 백엔드 시작 실패: ${String(err)}\n`)
  }
  if (quitting) return

  registerPowerHandlers()
  startDiscord(config)

  const login = syncLaunchAtLogin(app, config)
  if (login === 'unsupported' && config.system.launchAtLogin) {
    // 조용히 넘어가면 사용자는 등록된 줄 안다.
    process.stderr.write('[system] 이 플랫폼은 로그인 자동 실행을 지원하지 않는다\n')
  }
  startupComplete = true

  app.on('activate', () => {
    showCompanion()
  })
})

app.on('before-quit', (event) => {
  // relaunch 예약 전에 quit이 끼어들면 현재 앱만 꺼지고 새 앱은 뜨지 않는다.
  if (restartingApplication && !relaunchCommitted) {
    event.preventDefault()
    return
  }
  if (shutdownReady) {
    quitting = true
    return
  }
  event.preventDefault()
  void prepareForExit()
})

app.on('window-all-closed', () => {
  if (restartingApplication && !relaunchCommitted) return
  // 트레이로 숨는 설정이면 창이 다 닫혀도 살아 있는다. 되살릴 트레이가 실제로
  // 없으면 그때는 종료한다 — 설정이 아니라 tray 인스턴스를 넘기는 것이 핵심이다.
  if (!quitting && !shouldQuitOnClose(loadConfig(), tray !== null)) return
  if (process.platform !== 'darwin') app.quit()
})
}
