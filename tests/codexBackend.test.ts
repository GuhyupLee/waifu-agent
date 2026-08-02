import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { BackendEvent } from '../src/shared/protocol'
import { buildCodexArgs, CodexBackend } from '../src/main/backends/codex'
import type { SessionOpts } from '../src/main/backends/types'

function options(overrides: Partial<SessionOpts> = {}): SessionOpts {
  return {
    bin: 'codex',
    cwd: 'C:\\workspace',
    workspaces: ['C:\\workspace', 'D:\\shared'],
    permissionMode: 'guarded',
    ...overrides
  }
}

describe('buildCodexArgs — 설치된 CLI의 첫 턴/재개 계약', () => {
  it.each([
    ['readonly', 'read-only'],
    ['guarded', 'workspace-write'],
    ['auto', 'danger-full-access']
  ] as const)('%s 권한을 첫 턴 sandbox %s로 옮긴다', (permissionMode, sandbox) => {
    const args = buildCodexArgs(options({ permissionMode }), 'hello', null)
    expect(args.slice(0, 2)).toEqual(['exec', '--json'])
    expect(args).toContain('-C')
    expect(args[args.indexOf('-s') + 1]).toBe(sandbox)
    expect(args.filter((arg) => arg === '--add-dir')).toHaveLength(2)
    expect(args.at(-1)).toBe('hello')
  })

  it('resume에는 지원되지 않는 -s/-C/--add-dir를 절대 넣지 않는다', () => {
    const args = buildCodexArgs(options({ model: 'gpt-test' }), 'continue', 'thread-1')
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'thread-1'])
    expect(args).not.toContain('-s')
    expect(args).not.toContain('-C')
    expect(args).not.toContain('--add-dir')
    expect(args).toContain("sandbox_mode='workspace-write'")
    expect(args).toContain('-m')
    expect(args.at(-1)).toBe('continue')
  })

  it('앱의 system prompt를 developer_instructions로 첫 턴과 resume에 모두 넣는다', () => {
    for (const sessionId of [null, 'thread-1']) {
      const args = buildCodexArgs(options({ systemPrompt: 'WAIFU_SENTINEL_123' }), 'hello', sessionId)
      expect(args).toContain("developer_instructions='WAIFU_SENTINEL_123'")
    }
  })

  it('여러 줄 system prompt를 유효한 단일 TOML 인자로 이스케이프한다', () => {
    const args = buildCodexArgs(options({ systemPrompt: 'line 1\nline 2' }), 'hello', null)
    expect(args).toContain('developer_instructions="line 1\\nline 2"')
  })

  it('MCP는 --mcp-config가 아니라 -c 오버라이드와 TOML 리터럴로 넣는다', () => {
    const args = buildCodexArgs(
      options({
        codexMcp: {
          command: 'C:\\Program Files\\waifu\\server.exe',
          args: ['--root', 'D:\\models'],
          env: { WAIFU_CONTROL_TOKEN: 'token-shape' }
        }
      }),
      'hello',
      null
    )

    expect(args).not.toContain('--mcp-config')
    const overrides = args.filter((_, index) => args[index - 1] === '-c')
    expect(overrides).toEqual([
      "mcp_servers.waifu.command='C:\\Program Files\\waifu\\server.exe'",
      "mcp_servers.waifu.args=['--root','D:\\models']",
      "mcp_servers.waifu.env.WAIFU_CONTROL_TOKEN='token-shape'"
    ])
  })

  it('작은따옴표가 든 값은 TOML 기본 문자열로 안전하게 물러난다', () => {
    const args = buildCodexArgs(
      options({ codexMcp: { command: "C:\\it's\\server.exe", args: [], env: {} } }),
      'hello',
      null
    )
    const command = args.find((arg) => arg.startsWith('mcp_servers.waifu.command='))
    expect(command).toBe('mcp_servers.waifu.command="C:\\\\it\'s\\\\server.exe"')
  })
})

describe('CodexBackend lifecycle', () => {
  it('실행 파일을 찾지 못해도 실패 result와 exit를 내고 busy를 해제한다', async () => {
    const backend = new CodexBackend()
    const events: BackendEvent[] = []
    backend.onEvent((event) => events.push(event))
    await backend.start(options({
      bin: resolve(process.cwd(), '__waifu_missing_codex_binary__'),
      cwd: process.cwd(),
      workspaces: []
    }))

    const exited = new Promise<void>((resolveExit, reject) => {
      const timer = setTimeout(() => reject(new Error('exit event timeout')), 5_000)
      backend.onEvent((event) => {
        if (event.type !== 'exit') return
        clearTimeout(timer)
        resolveExit()
      })
    })

    await backend.send('must not run')
    await exited

    expect(events.filter((event) => event.type === 'error')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'result')).toEqual([
      { type: 'result', text: '', isError: true }
    ])
    expect(events.filter((event) => event.type === 'exit')).toHaveLength(1)
    expect(backend.busy).toBe(false)
  })

  it('중단 프로세스가 닫히기 전 새 send를 막고 중단을 실패 result로 만들지 않는다', async () => {
    const backend = new CodexBackend()
    const events: BackendEvent[] = []
    backend.onEvent((event) => events.push(event))
    await backend.start(options({
      bin: process.execPath,
      cwd: resolve(__dirname, 'fixtures', 'fake-codex'),
      workspaces: []
    }))

    await backend.send('first')
    const stopping = backend.stop()
    await expect(backend.send('must be blocked')).rejects.toThrow('이전 턴이 아직 끝나지 않았다')
    await stopping

    expect(events.filter((event) => event.type === 'error')).toHaveLength(0)
    expect(events.filter((event) => event.type === 'result')).toHaveLength(0)
    expect(events.filter((event) => event.type === 'exit')).toHaveLength(1)
    expect(backend.busy).toBe(false)
  })
})
