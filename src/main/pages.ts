import { join } from 'node:path'
import type { BrowserWindow } from 'electron'

export type RendererPage = 'avatar' | 'companion' | 'media' | 'panel'

/** preload 산출물은 out/preload/index.cjs, main 은 out/main/index.js 다. */
export const PRELOAD_PATH: string = join(__dirname, '../preload/index.cjs')

/**
 * ELECTRON_RENDERER_URL 은 **오리진뿐**이다 (`http://localhost:5173`). 경로가 없고 페이지별로
 * 달라지지도 않는다 — 모든 렌더러 페이지가 개발 서버 하나를 공유한다.
 * electron-vite 템플릿들이 쓰는 `loadURL(ELECTRON_RENDERER_URL)` 을 그대로 따라 하면
 * `/` 를 치는데, 이 프로젝트에는 index.html 이 없어서 404 가 난다. 페이지 경로를 직접 붙여야 한다.
 */
export function loadRendererPage(win: BrowserWindow, page: RendererPage): void {
  const devOrigin = process.env.ELECTRON_RENDERER_URL
  const loading = devOrigin
    ? win.loadURL(`${devOrigin}/${page}.html`)
    : win.loadFile(join(__dirname, '..', 'renderer', `${page}.html`))

  // BrowserWindow의 did-fail-load는 창별 복구 정책을 담당한다. 반환 Promise까지 버리면
  // 같은 실패가 main의 unhandled rejection으로 번져 그 복구 코드 자체가 실행되지 않는다.
  // 여기서는 rejection만 소유하고, 창을 다시 만드는 판단은 호출부의 이벤트에 남긴다.
  void loading.catch((error: unknown) => {
    process.stderr.write(`[${page}] 렌더러 페이지 로드 실패: ${String(error)}\n`)
  })
}
