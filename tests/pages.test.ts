import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { loadRendererPage } from '../src/main/pages'

describe('renderer page loading', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('로드 Promise rejection을 main의 unhandled rejection으로 흘리지 않는다', async () => {
    const failure = new Error('renderer missing')
    const loadFile = vi.fn().mockRejectedValue(failure)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const previousOrigin = process.env.ELECTRON_RENDERER_URL
    delete process.env.ELECTRON_RENDERER_URL

    try {
      loadRendererPage({ loadFile } as unknown as BrowserWindow, 'media')
      await vi.waitFor(() => {
        expect(stderr).toHaveBeenCalledWith(
          expect.stringContaining('[media] 렌더러 페이지 로드 실패: Error: renderer missing')
        )
      })
    } finally {
      if (previousOrigin === undefined) delete process.env.ELECTRON_RENDERER_URL
      else process.env.ELECTRON_RENDERER_URL = previousOrigin
    }
  })
})
