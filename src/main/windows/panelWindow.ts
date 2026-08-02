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

  win.once('ready-to-show', () => win.show())
  void loadRendererPage(win, 'panel')
  return win
}
