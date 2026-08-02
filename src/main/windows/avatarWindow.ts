/**
 * 데스크탑에 상주하는 아바타 오버레이 창.
 *
 * 여기 있는 옵션들은 거의 전부 "이걸 빼먹으면 조용히 깨진다" 부류다.
 * 각 항목의 근거는 Electron 43 의 win32 소스와 electron.d.ts 에서 확인했다.
 */
import { app, BrowserWindow, screen } from 'electron'
import type { Rectangle } from 'electron'
import { loadRendererPage, PRELOAD_PATH } from '../pages'

/**
 * 앱 준비 **전에** 불러야 하는 Chromium 스위치들.
 *
 * 일부러 넣지 않은 것:
 *  - `app.disableHardwareAcceleration()` — SwiftShader 소프트웨어 렌더링으로 떨어져 VRM 프레임이 죽는다.
 *  - `--enable-transparent-visuals` / `--disable-gpu` — X11(Linux) 전용 처방이다.
 *    현재 Chromium 에는 스위치 자체가 없고, Windows 에 붙이면 WebGL 만 잃는다.
 *    투명 창 관련 블로그의 리눅스 스니펫을 그대로 복사하지 마라.
 */
export function applyOverlaySwitches(): void {
  if (process.platform !== 'win32') return

  // CalculateNativeWinOcclusion 은 Windows 전용이고 기본 활성이다. Chromium 이 이 창을
  // "가려졌다"고 판단하면 렌더링을 멈추고 JS 를 스로틀한다 — 전체화면 앱을 띄우면
  // 아바타가 얼어붙는 증상으로 나타난다.
  // 주의: appendSwitch 는 같은 스위치의 이전 값을 **덮어쓴다**. 기능을 더 끄려면 콤마로 이어 붙여라.
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
}

export interface AvatarWindowOptions {
  width: number
  height: number
  /** 작업 영역 오른쪽·아래 가장자리에서 띄울 간격 (DIP). */
  margin: number
}

export const DEFAULT_AVATAR_WINDOW: AvatarWindowOptions = { width: 420, height: 640, margin: 24 }

function bottomRightOfWorkArea(o: AvatarWindowOptions): Rectangle {
  // workAreaSize 는 { width, height } 뿐이라 원점을 (0,0) 으로 가정하게 된다.
  // 작업표시줄이 왼쪽/위에 붙어 있거나 주 디스플레이 원점이 음수면 창이 엉뚱한 곳에 뜬다.
  // x/y 가 있는 workArea(Rectangle) 를 써야 한다.
  const { workArea } = screen.getPrimaryDisplay()
  return {
    x: Math.round(workArea.x + workArea.width - o.width - o.margin),
    y: Math.round(workArea.y + workArea.height - o.height - o.margin),
    width: o.width,
    height: o.height
  }
}

export function createAvatarWindow(opts: AvatarWindowOptions = DEFAULT_AVATAR_WINDOW): BrowserWindow {
  const win = new BrowserWindow({
    ...bottomRightOfWorkArea(opts),

    // Windows 에서 transparent 는 frame:false 가 아니면 **조용히 무시된다** (불투명 회색 창이 뜬다).
    frame: false,
    transparent: true,
    // 알파 채널은 transparent 가 true 일 때만 반영된다.
    backgroundColor: '#00000000',
    hasShadow: false,

    // 투명 창에서 resizable:true 는 플랫폼에 따라 투명도를 깨뜨린다고 문서화되어 있다.
    // 크기 조절은 setBounds 로 프로그램에서 한다.
    resizable: false,
    maximizable: false,
    minimizable: false,

    // focusable:false 로도 작업표시줄에서 숨길 수 있지만 키보드 입력까지 막힌다.
    // 오버레이에 입력창을 올릴 여지를 남겨두고 skipTaskbar + toolbar 로 간다.
    skipTaskbar: true,
    type: 'toolbar', // win32 의 WS_EX_TOOLWINDOW — Alt-Tab 목록에서도 빠진다

    alwaysOnTop: true,
    show: false,

    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      sandbox: false,
      // 이게 없으면 창이 포커스를 잃는 순간 requestAnimationFrame 이 1Hz 로 떨어진다.
      // 다른 앱에서 타이핑하는 동안 아바타가 멈춰 보이는 원인이다.
      backgroundThrottling: false
    }
  })

  // 생성자의 alwaysOnTop:true 는 레벨을 'floating' 으로 잡는데, Electron 의 win32 코드는
  // {floating, torn-off-menu, modal-panel, main-menu, status} 를 **작업표시줄 뒤로** 보낸다.
  // 화면 아래쪽에 둔 아바타가 작업표시줄 밑으로 사라지는 이유가 이것이다.
  // 'pop-up-menu' 이상이어야 작업표시줄 위에 뜬다.
  const raise = (): void => win.setAlwaysOnTop(true, 'screen-saver')
  raise()

  win.once('ready-to-show', () => {
    // showInactive: 편집기에서 포커스를 빼앗지 않는다.
    win.showInactive()
    raise()
  })

  // 디스플레이 구성이 바뀌면 위치와 z-order 를 다시 잡는다.
  const reposition = (): void => {
    if (win.isDestroyed()) return
    win.setBounds(bottomRightOfWorkArea(opts))
    raise()
  }
  screen.on('display-metrics-changed', reposition)
  screen.on('display-added', reposition)
  screen.on('display-removed', reposition)
  win.on('closed', () => {
    screen.removeListener('display-metrics-changed', reposition)
    screen.removeListener('display-added', reposition)
    screen.removeListener('display-removed', reposition)
  })

  // 투명 영역은 그 자체로는 클릭이 통과되지 않는다 (문서화된 제약). 기본을 통과로 두고,
  // 커서가 아바타의 불투명 픽셀 위에 있을 때만 렌더러가 신호를 보내 끈다.
  // forward:true 는 WM_MOUSEMOVE 만 전달한다 — 클릭은 전달되지 않으므로,
  // 클릭이 닿으려면 그 전에 ignore 를 꺼야 한다.
  win.setIgnoreMouseEvents(true, { forward: true })

  void loadRendererPage(win, 'avatar')
  return win
}

/**
 * 렌더러의 히트 테스트 결과를 반영한다.
 *
 * forward:true 상태에서는 mousedown 이 오지 않으므로, 커서가 실루엣에 닿기 **전에**
 * 전환이 끝나 있어야 첫 클릭을 잃지 않는다. 렌더러 쪽에서 알파 임계값을 낮게 잡고
 * 판정 영역을 몇 픽셀 부풀리는 이유가 이것이다.
 */
export function setAvatarInteractive(win: BrowserWindow, interactive: boolean): void {
  if (win.isDestroyed()) return
  if (interactive) win.setIgnoreMouseEvents(false)
  else win.setIgnoreMouseEvents(true, { forward: true })
}

/** DevTools 를 붙여서 열면 창이 불투명해진다 (문서화된 제약). 반드시 분리 모드로 연다. */
export function openAvatarDevTools(win: BrowserWindow): void {
  win.webContents.openDevTools({ mode: 'detach' })
}
