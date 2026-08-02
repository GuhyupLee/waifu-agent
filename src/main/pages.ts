import { join } from 'node:path'
import type { BrowserWindow } from 'electron'

export type RendererPage = 'avatar' | 'panel'

/** preload 산출물은 out/preload/index.cjs, main 은 out/main/index.js 다. */
export const PRELOAD_PATH: string = join(__dirname, '../preload/index.cjs')

/**
 * ELECTRON_RENDERER_URL 은 **오리진뿐**이다 (`http://localhost:5173`). 경로가 없고 페이지별로
 * 달라지지도 않는다 — 모든 렌더러 페이지가 개발 서버 하나를 공유한다.
 * electron-vite 템플릿들이 쓰는 `loadURL(ELECTRON_RENDERER_URL)` 을 그대로 따라 하면
 * `/` 를 치는데, 이 프로젝트에는 index.html 이 없어서 404 가 난다. 페이지 경로를 직접 붙여야 한다.
 */
export function loadRendererPage(win: BrowserWindow, page: RendererPage): Promise<void> {
  const devOrigin = process.env.ELECTRON_RENDERER_URL
  if (devOrigin) return win.loadURL(`${devOrigin}/${page}.html`)
  return win.loadFile(join(__dirname, '..', 'renderer', `${page}.html`))
}
