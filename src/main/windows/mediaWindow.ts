import { BrowserWindow } from 'electron'
import { loadRendererPage, PRELOAD_PATH } from '../pages'

/**
 * Unity 렌더러가 쓸 데스크톱 음성 장치 호스트.
 *
 * 화면을 그리는 웹 페이지가 아니다. Electron 프로그램 안에서 Chromium의 검증된
 * Web Audio/getUserMedia 경계만 쓰는 숨은 작업 창이다. Three.js 아바타는 로드하지 않는다.
 */
export function createMediaWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    frame: false,
    focusable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      sandbox: false,
      // 숨은 창이어도 TTS 재생과 AudioWorklet 녹음이 느려지면 안 된다.
      backgroundThrottling: false
    }
  })

  loadRendererPage(win, 'media')
  return win
}
