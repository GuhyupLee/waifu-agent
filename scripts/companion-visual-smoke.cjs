const { existsSync, mkdtempSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { app, BrowserWindow, contextBridge } = require('electron')

if (process.type === 'renderer') {
  const subscribers = new Set()
  const emit = (event) => subscribers.forEach((subscriber) => subscriber(event))
  const config = {
    backend: { active: 'claude-code', failover: true, claudeCode: { bin: 'claude' }, codex: { bin: 'codex' } },
    permission: { mode: 'guarded', workspaces: ['E:\\waifu-agent'], autoApprove: [] },
    avatar: { modelPath: null },
    chat: { showActivity: true },
    persona: { name: '하루' }
  }
  const diagnostics = {
    backend: 'claude-code',
    sessionId: '00000000-0000-4000-8000-000000000001',
    busy: false,
    motions: 58,
    activeTasks: 0,
    memories: 0,
    runtime: {
      configuredBackend: 'claude-code',
      cwd: 'E:\\waifu-agent',
      permissionMode: 'guarded',
      workspaces: ['E:\\waifu-agent']
    },
    backendRestartRequired: false
  }

  contextBridge.exposeInMainWorld('waifu', {
    onAvatarCommand: () => () => {},
    sendAvatarEvent: () => {},
    onPanelEvent: (callback) => {
      subscribers.add(callback)
      return () => subscribers.delete(callback)
    },
    sendMessage: () => {},
    interrupt: () => {},
    respondPermission: () => {},
    listPendingPermissions: async () => [],
    getConfig: async () => config,
    setConfig: async () => config,
    pickModel: async () => null,
    pickWorkspace: async () => null,
    restartApp: async () => ({ ok: true }),
    listChanges: async () => [],
    undoChange: async () => ({ ok: false }),
    listMemories: async () => [],
    forgetMemory: async () => false,
    listRoutines: async () => [],
    removeRoutine: async () => false,
    listReminders: async () => [],
    cancelReminder: async () => false,
    diagnostics: async () => diagnostics,
    pingVoice: async () => null
  })
  contextBridge.exposeInMainWorld('__companionSmoke', { emit })
} else {
  const root = resolve(__dirname, '..')
  const page = join(root, 'out', 'renderer', 'companion.html')
  if (!existsSync(page)) throw new Error('먼저 npm run build를 실행해라.')
  const output = mkdtempSync(join(tmpdir(), 'waifu-companion-smoke-'))

  const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
  async function capture(win, name) {
    win.webContents.invalidate()
    await delay(80)
    const image = await win.webContents.capturePage()
    const path = join(output, `${name}.png`)
    writeFileSync(path, image.toPNG())
    return path
  }

  app.whenReady().then(async () => {
    const problems = []
    const win = new BrowserWindow({
      width: 408,
      height: 204,
      show: false,
      frame: false,
      transparent: true,
      webPreferences: { preload: __filename, contextIsolation: true, sandbox: false }
    })
    win.webContents.on('console-message', (details) => {
      if (details.level === 'warning' || details.level === 'error') problems.push(details.message)
    })
    await win.loadFile(page)
    await win.webContents.executeJavaScript(
      `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`
    )

    const idle = await capture(win, '01-idle')
    await win.webContents.executeJavaScript(`
      window.__companionSmoke.emit({ type: 'notice', level: 'info', message: '나 · 오늘 할 일을 정리해줘' });
      window.__companionSmoke.emit({ type: 'backend', event: { type: 'text', text: '좋아. 먼저 가장 중요한 일부터 같이 골라보자.' } });
      window.__companionSmoke.emit({ type: 'backend', event: { type: 'result', text: '좋아. 먼저 가장 중요한 일부터 같이 골라보자.', isError: false } });
    `)
    const conversation = await capture(win, '02-conversation')
    await win.webContents.executeJavaScript(`
      window.__companionSmoke.emit({
        type: 'permission-request',
        request: { id: 'permission-1', toolName: 'Write', reason: '할 일 파일을 갱신하려고 해.', input: {} }
      });
    `)
    const permission = await capture(win, '03-permission')

    const metrics = await win.webContents.executeJavaScript(`(() => ({
      width: innerWidth,
      height: innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      hasInput: Boolean(document.querySelector('.composer input')),
      hasPermission: Boolean(document.querySelector('.permission-card')),
      permissionButtons: document.querySelectorAll('.permission-actions button').length
    }))()`)
    if (metrics.scrollWidth > metrics.width || metrics.scrollHeight > metrics.height) {
      throw new Error(`companion overflow: ${JSON.stringify(metrics)}`)
    }
    if (!metrics.hasInput || !metrics.hasPermission || metrics.permissionButtons !== 2) {
      throw new Error(`companion controls missing: ${JSON.stringify(metrics)}`)
    }
    if (problems.length > 0) throw new Error(`renderer problems: ${problems.join(' | ')}`)

    process.stdout.write(JSON.stringify({ output, captures: { idle, conversation, permission }, metrics }))
    win.destroy()
    app.quit()
  }).catch((error) => {
    process.stderr.write(`${error.stack || error}\n`)
    app.exit(1)
  })
}
