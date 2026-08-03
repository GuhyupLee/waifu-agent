import { BrowserWindow, screen } from 'electron'
import { loadRendererPage, PRELOAD_PATH } from '../pages'

/**
 * 채팅·설정·권한 승인 카드가 뜨는 일반 창.
 *
 * 아바타 창과 달리 평범한 창이다. 투명 창의 제약(리사이즈 불가, DevTools 붙이면 불투명 등)을
 * 여기까지 끌고 올 이유가 없다.
 */
export function createPanelWindow(personaName: string): BrowserWindow {
  const { workArea } = screen.getPrimaryDisplay()
  const width = 460
  const height = 720

  const win = new BrowserWindow({
    width,
    height,
    // 아바타(오른쪽 아래) 왼쪽에 붙여 둔다.
    x: Math.round(workArea.x + workArea.width - width - 480),
    y: Math.round(workArea.y + workArea.height - height - 24),
    minWidth: 360,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    title: personaName,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      sandbox: false
    }
  })

  win.once('ready-to-show', () => {
    win.show()
    // 어디에 떴는지 남긴다. "창이 안 뜬다" 의 원인은 대개 안 뜬 게 아니라
    // 보이지 않는 자리에 뜬 것이다 — 다중 모니터에서 좌표가 음수이거나,
    // 해상도가 바뀐 뒤 저장된 자리가 화면 밖일 때.
    const b = win.getBounds()
    process.stdout.write(`[panel] 창 ${b.width}x${b.height} @ ${b.x},${b.y}\n`)
  })

  // 로드가 실패하면 ready-to-show 가 오지 않아 창이 영원히 숨은 채로 남는다.
  // 조용히 사라지는 대신 이유를 남기고 빈 창이라도 띄운다.
  win.webContents.on('did-fail-load', (_e, code, description, url) => {
    process.stderr.write(`[panel] 로드 실패 (${code} ${description}) ${url}\n`)
    if (!win.isDestroyed() && !win.isVisible()) win.show()
  })

  loadRendererPage(win, 'panel')
  return win
}
