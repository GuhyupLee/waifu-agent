import { BrowserWindow, screen } from 'electron'
import { loadRendererPage, PRELOAD_PATH } from '../pages'

const WIDTH = 408
const HEIGHT = 204
const CURSOR_GAP = 30

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * 아바타를 눌렀을 때 옆에 붙는 짧은 대화 카드.
 *
 * 일반 앱 창처럼 제목 표시줄과 작업 표시줄을 차지하지 않는다. 큰 패널은 설정·기록용이고,
 * 평소 입력과 승인만 이 창에서 처리한다.
 */
export function createCompanionWindow(): BrowserWindow {
  const cursor = screen.getCursorScreenPoint()
  const { workArea } = screen.getDisplayNearestPoint(cursor)
  const left = cursor.x - WIDTH - CURSOR_GAP
  const right = cursor.x + CURSOR_GAP
  const x = left >= workArea.x + 8 ? left : right
  const y = cursor.y - Math.round(HEIGHT * 0.45)

  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    x: clamp(x, workArea.x + 8, workArea.x + workArea.width - WIDTH - 8),
    y: clamp(y, workArea.y + 8, workArea.y + workArea.height - HEIGHT - 8),
    minWidth: WIDTH,
    minHeight: HEIGHT,
    maxWidth: WIDTH,
    maxHeight: HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      sandbox: false
    }
  })

  win.setAlwaysOnTop(true, 'floating')
  loadRendererPage(win, 'companion')
  return win
}

/** 기존 카드를 다시 열 때도 현재 아바타 클릭 위치 옆으로 옮긴다. */
export function placeCompanionNearCursor(win: BrowserWindow): void {
  const cursor = screen.getCursorScreenPoint()
  const { workArea } = screen.getDisplayNearestPoint(cursor)
  const bounds = win.getBounds()
  const left = cursor.x - bounds.width - CURSOR_GAP
  const right = cursor.x + CURSOR_GAP
  const x = left >= workArea.x + 8 ? left : right
  const y = cursor.y - Math.round(bounds.height * 0.45)
  win.setPosition(
    clamp(x, workArea.x + 8, workArea.x + workArea.width - bounds.width - 8),
    clamp(y, workArea.y + 8, workArea.y + workArea.height - bounds.height - 8)
  )
}
