import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { BackendEvent } from '../src/shared/protocol'
import type { SessionOpts } from '../src/main/backends/types'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => process.cwd()) } }))

import { ClaudeCodeBackend } from '../src/main/backends/claudeCode'

function options(): SessionOpts {
  return {
    // 실제 Claude 대신 존재하지 않는 경로로 Node의 spawn error/close 순서만 검증한다.
    bin: resolve(process.cwd(), '__waifu_missing_claude_binary__.exe'),
    cwd: process.cwd(),
    workspaces: [],
    permissionMode: 'guarded'
  }
}

describe('ClaudeCodeBackend real spawn boundary', () => {
  it('존재하지 않는 실행 파일은 start를 reject하고 error/exit를 각각 한 번 남긴다', async () => {
    const backend = new ClaudeCodeBackend()
    const events: BackendEvent[] = []
    backend.onEvent((event) => events.push(event))
    const exited = new Promise<void>((resolveExit, reject) => {
      const timer = setTimeout(() => reject(new Error('exit event timeout')), 5_000)
      backend.onEvent((event) => {
        if (event.type !== 'exit') return
        clearTimeout(timer)
        resolveExit()
      })
    })

    await expect(backend.start(options())).rejects.toThrow('실행 실패')
    await exited

    expect(events.filter((event) => event.type === 'error')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'exit')).toHaveLength(1)
    expect(backend.busy).toBe(false)
    await expect(backend.send('must not run')).rejects.toThrow('백엔드가 시작되지 않았다')
  })
})
