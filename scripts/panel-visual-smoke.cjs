const { existsSync, mkdirSync, mkdtempSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { app, BrowserWindow, contextBridge, session } = require('electron')

if (process.type === 'renderer') {
  const subscribers = new Set()
  const sentMessages = []
  const permissionResponses = []
  let interruptCount = 0
  let config = {
    backend: {
      active: 'claude-code',
      failover: true,
      claudeCode: { bin: 'claude' },
      codex: { bin: 'codex' }
    },
    permission: { mode: 'guarded', workspaces: [], autoApprove: [] },
    avatar: { modelPath: null },
    chat: { showActivity: true },
    persona: { name: '하루' }
  }
  let diagnostics = {
    backend: 'claude-code',
    sessionId: null,
    busy: false,
    motions: 55,
    activeTasks: 0,
    memories: 0,
    runtime: null,
    backendRestartRequired: false
  }

  const emit = (event) => {
    for (const subscriber of subscribers) subscriber(event)
  }

  contextBridge.exposeInMainWorld('waifu', {
    onAvatarCommand: () => () => {},
    sendAvatarEvent: () => {},
    onPanelEvent: (callback) => {
      subscribers.add(callback)
      return () => subscribers.delete(callback)
    },
    sendMessage: (text) => sentMessages.push(text),
    interrupt: () => { interruptCount += 1 },
    respondPermission: (id, decision) => permissionResponses.push({ id, decision }),
    listPendingPermissions: async () => [],
    getConfig: async () => config,
    setConfig: async (patch) => {
      config = { ...config, ...patch }
      emit({ type: 'config', config })
      return config
    },
    pickModel: async () => null,
    pickWorkspace: async () => null,
    restartApp: async () => ({ ok: true }),
    listChanges: async () => [],
    undoChange: async () => ({ ok: false, reason: 'smoke mock' }),
    listMemories: async () => [],
    forgetMemory: async () => false,
    listRoutines: async () => [],
    removeRoutine: async () => false,
    listReminders: async () => [],
    cancelReminder: async () => false,
    diagnostics: async () => diagnostics,
    pingVoice: async () => null
  })

  contextBridge.exposeInMainWorld('__waifuSmoke', {
    emit,
    configureReady: (busy = false) => {
      config = {
        ...config,
        permission: {
          ...config.permission,
          workspaces: [
            'E:\\waifu-agent',
            'E:\\reference-projects\\animation-library',
            'D:\\shared\\character-notes'
          ]
        }
      }
      diagnostics = {
        ...diagnostics,
        busy,
        sessionId: '00000000-0000-4000-8000-000000000001',
        runtime: {
          configuredBackend: 'claude-code',
          cwd: 'E:\\waifu-agent',
          permissionMode: 'guarded',
          workspaces: [...config.permission.workspaces]
        }
      }
      emit({ type: 'config', config })
    },
    setBusy: (busy) => {
      diagnostics = { ...diagnostics, busy }
      emit({ type: 'config', config })
    },
    sentMessages: () => [...sentMessages],
    permissionResponses: () => [...permissionResponses],
    interruptCount: () => interruptCount
  })
} else {
  const root = resolve(__dirname, '..')
  const panel = join(root, 'out', 'renderer', 'panel.html')
  if (!existsSync(panel)) throw new Error('out/renderer/panel.html 이 없다. 먼저 npm run build를 실행해라.')

  const output = process.env.WAIFU_PANEL_SMOKE_OUTPUT || mkdtempSync(join(tmpdir(), 'waifu-panel-smoke-'))
  mkdirSync(output, { recursive: true })
  app.commandLine.appendSwitch('force-device-scale-factor', '1')
  app.setPath('userData', join(output, 'user-data'))
  app.setPath('sessionData', join(output, 'session-data'))

  const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))

  async function snapshot(win, name) {
    await delay(80)
    const image = await win.webContents.capturePage()
    const path = join(output, `${name}.png`)
    writeFileSync(path, image.toPNG())
    return path
  }

  async function metrics(win) {
    return win.webContents.executeJavaScript(`(() => {
      const html = document.documentElement
      const root = document.getElementById('root')
      const rect = (selector) => {
        const el = document.querySelector(selector)
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }
      }
      return {
        innerWidth,
        innerHeight,
        scrollWidth: html.scrollWidth,
        scrollHeight: html.scrollHeight,
        clientWidth: html.clientWidth,
        clientHeight: html.clientHeight,
        root: root ? { width: root.getBoundingClientRect().width, height: root.getBoundingClientRect().height } : null,
        setupButton: rect('.setup-callout .button'),
        input: rect('[data-testid="composer-input"]'),
        send: rect('[data-testid="composer-send"]'),
        stop: rect('[data-testid="composer-stop"]'),
        permission: rect('[data-testid="permission-card"]'),
        sendDisabled: document.querySelector('[data-testid="composer-send"]')?.disabled ?? null,
        sendText: document.querySelector('[data-testid="composer-send"]')?.textContent?.trim() ?? null,
        headerStatus: document.querySelector('.identity-copy [role="status"]')?.textContent?.trim() ?? null,
        currentAction: document.querySelector('.current-action strong')?.textContent?.trim() ?? null,
        workspaceLabel: document.querySelector('[data-testid="workspace-label"]')?.textContent?.trim() ?? null,
        workspaceTitle: document.querySelector('[data-testid="workspace-label"]')?.getAttribute('title') ?? null,
        transcriptAriaLive: document.querySelector('.conversation')?.getAttribute('aria-live') ?? null,
        backgroundInert: document.querySelector('.home-content')?.inert ?? null,
        backgroundAriaHidden: document.querySelector('.home-content')?.getAttribute('aria-hidden') ?? null,
        activeText: document.activeElement?.textContent?.trim() ?? null,
        rawDetailsOpen: document.querySelector('.permission-details')?.open ?? null,
        rawDetailsLength: document.querySelector('.permission-details pre')?.textContent?.length ?? null,
        permissionButtons: [...document.querySelectorAll('.permission-decision')].map((el) => ({
          decision: el.dataset.decision,
          className: el.className,
          width: el.getBoundingClientRect().width
        })),
        activityTexts: [...document.querySelectorAll('[data-kind="activity"]')].map((el) => el.textContent?.trim()),
        noticeLevels: [...document.querySelectorAll('[data-level]')].map((el) => el.dataset.level),
        noticeLabels: [...document.querySelectorAll('.notice-label')].map((el) => el.textContent?.trim())
      }
    })()`)
  }

  app.whenReady().then(async () => {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
              "img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' blob: data:; " +
              "font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'"
          ]
        }
      })
    })
    const rendererProblems = []
    const win = new BrowserWindow({
      width: 460,
      height: 720,
      minWidth: 360,
      minHeight: 480,
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: __filename,
        contextIsolation: true,
        sandbox: false,
        backgroundThrottling: false
      }
    })

    win.webContents.on('console-message', (details) => {
      if (details.level === 'warning' || details.level === 'error') {
        rendererProblems.push(`${details.level}: ${details.message}`)
      }
    })
    await win.loadFile(panel)
    await win.webContents.executeJavaScript(
      `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`
    )

    const captures = {}
    captures.first = await snapshot(win, '01-first-460x720')
    const firstMetrics = await metrics(win)

    win.setSize(360, 480)
    captures.minimum = await snapshot(win, '02-first-360x480')
    const minimumMetrics = await metrics(win)

    win.setSize(460, 720)
    await win.webContents.executeJavaScript(`window.__waifuSmoke.configureReady(true)`)
    captures.resumedBusy = await snapshot(win, '03-resumed-busy')
    const resumedBusyMetrics = await metrics(win)

    await win.webContents.executeJavaScript(`window.__waifuSmoke.setBusy(false)`)
    await win.webContents.executeJavaScript(`window.__waifuSmoke.emit({
      type: 'backend',
      event: { type: 'session', sessionId: '00000000-0000-4000-8000-000000000001', backend: 'claude-code' }
    })`)
    await win.webContents.executeJavaScript(`window.__waifuSmoke.emit({
      type: 'backend',
      event: { type: 'activity', detail: '애니메이션 연결 규칙을 살펴보는 중' }
    })`)
    await win.webContents.executeJavaScript(`window.__waifuSmoke.emit({
      type: 'backend',
      event: { type: 'tool-start', id: 'tool-1', name: 'Read', input: { file_path: 'src/main.ts' } }
    })`)
    captures.working = await snapshot(win, '04-working')
    const workingMetrics = await metrics(win)

    await win.webContents.executeJavaScript(`
      window.__waifuSmoke.emit({
        type: 'permission-request',
        request: {
          id: 'permission-1',
          toolName: 'Write',
          reason: '설정 파일의 잘못된 값을 고치기 위해 필요하다.',
          input: { file_path: 'E:\\\\waifu-agent\\\\waifu.config.json', content: '가'.repeat(9000) }
        }
      });
      window.__waifuSmoke.emit({
        type: 'permission-request',
        request: {
          id: 'permission-2',
          toolName: 'Bash',
          reason: '빌드 결과를 확인하기 위해 필요하다.',
          input: { command: 'npm run build' }
        }
      });
    `)
    captures.permission = await snapshot(win, '05-permission')
    const permissionMetrics = await metrics(win)

    await win.webContents.executeJavaScript(`
      const allow = document.querySelector('[data-decision="allow"]');
      allow.focus();
      allow.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    `)
    const trappedFocusMetrics = await metrics(win)

    await win.webContents.executeJavaScript(`
      document.querySelector('.permission-details summary').click();
      new Promise((resolve) => setTimeout(resolve, 30));
    `)
    const openDetailsMetrics = await metrics(win)

    await win.webContents.executeJavaScript(`
      window.__waifuSmoke.emit({ type: 'permission-resolved', id: 'permission-1' });
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    `)
    const queuedPermissionMetrics = await metrics(win)

    await win.webContents.executeJavaScript(`
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    `)
    const escapedPermissionMetrics = await metrics(win)

    await win.webContents.executeJavaScript(`
      window.__waifuSmoke.emit({
        type: 'backend',
        event: { type: 'tool-end', id: 'tool-1', name: 'Read', isError: false }
      });
      window.__waifuSmoke.emit({
        type: 'backend',
        event: { type: 'result', text: '살펴본 내용을 정리했어.', isError: false }
      });
    `)
    await win.webContents.executeJavaScript(`
      window.__waifuSmoke.emit({ type: 'notice', level: 'info', message: '정보 알림' });
      window.__waifuSmoke.emit({ type: 'notice', level: 'warn', message: '주의 알림' });
      window.__waifuSmoke.emit({ type: 'notice', level: 'error', message: '오류 알림' });
    `)
    await win.webContents.executeJavaScript(`
      new Promise((resolve) => requestAnimationFrame(() => {
        const log = document.querySelector('.conversation');
        log.scrollTop = log.scrollHeight;
        requestAnimationFrame(resolve);
      }));
    `)
    captures.notices = await snapshot(win, '06-notice-levels')
    const noticeMetrics = await metrics(win)
    const permissionResponses = await win.webContents.executeJavaScript(`window.__waifuSmoke.permissionResponses()`)

    const report = {
      output,
      bounds: win.getBounds(),
      contentBounds: win.getContentBounds(),
      captures,
      firstMetrics,
      minimumMetrics,
      resumedBusyMetrics,
      workingMetrics,
      permissionMetrics,
      trappedFocusMetrics,
      openDetailsMetrics,
      queuedPermissionMetrics,
      escapedPermissionMetrics,
      noticeMetrics,
      rendererProblems,
      sentMessages: await win.webContents.executeJavaScript(`window.__waifuSmoke.sentMessages()`),
      permissionResponses
    }
    writeFileSync(join(output, 'metrics.json'), JSON.stringify(report, null, 2))

    const failures = []
    for (const [name, value] of Object.entries({
      firstMetrics,
      minimumMetrics,
      resumedBusyMetrics,
      workingMetrics,
      permissionMetrics,
      noticeMetrics
    })) {
      if (value.scrollWidth > value.clientWidth) failures.push(`${name}: horizontal overflow`)
    }
    if (firstMetrics.input || firstMetrics.send || minimumMetrics.input || minimumMetrics.send) {
      failures.push('onboarding: composer must not render before runtime is ready')
    }
    if (!minimumMetrics.setupButton || minimumMetrics.setupButton.bottom > minimumMetrics.innerHeight + 1) {
      failures.push('minimumMetrics: onboarding workspace CTA is clipped')
    }
    if (firstMetrics.transcriptAriaLive !== null) failures.push('conversation: transcript must not be aria-live')
    if (!resumedBusyMetrics.input || !resumedBusyMetrics.stop || !resumedBusyMetrics.send) {
      failures.push('resumedBusyMetrics: composer or separate stop button missing')
    }
    if (resumedBusyMetrics.sendText !== '부탁하기' || resumedBusyMetrics.sendDisabled !== true) {
      failures.push('resumedBusyMetrics: Send must stay 부탁하기 and be disabled while busy')
    }
    if (resumedBusyMetrics.headerStatus !== '작업 중' || resumedBusyMetrics.currentAction !== '작업을 계속하는 중') {
      failures.push('resumedBusyMetrics: reopened busy state is not represented')
    }
    if (!resumedBusyMetrics.workspaceLabel?.includes('+2') || !resumedBusyMetrics.workspaceTitle?.includes('character-notes')) {
      failures.push('resumedBusyMetrics: workspace scope does not show compact count and full paths')
    }
    if (!workingMetrics.activityTexts.includes('파일 읽기 · 시작')) {
      failures.push(`workingMetrics: translated tool activity missing (${workingMetrics.activityTexts.join(',')})`)
    }
    if (!permissionMetrics.permission) failures.push('permissionMetrics: permission card missing')
    if (permissionMetrics.rawDetailsOpen !== false) failures.push('permissionMetrics: raw details must start closed')
    if (permissionMetrics.backgroundInert !== true || permissionMetrics.backgroundAriaHidden !== 'true') {
      failures.push('permissionMetrics: background must be inert and aria-hidden')
    }
    if (permissionMetrics.activeText !== '하지 마') failures.push('permissionMetrics: safe initial focus missing')
    if (trappedFocusMetrics.activeText !== '정확한 입력 보기') {
      failures.push('permissionMetrics: Tab focus did not wrap inside the dialog')
    }
    if (
      permissionMetrics.permissionButtons.length !== 2 ||
      permissionMetrics.permissionButtons.some((button) => button.className.includes('button-primary')) ||
      Math.abs(permissionMetrics.permissionButtons[0].width - permissionMetrics.permissionButtons[1].width) > 1
    ) {
      failures.push('permissionMetrics: allow and deny actions must have neutral equal weight')
    }
    if (openDetailsMetrics.rawDetailsOpen !== true || openDetailsMetrics.rawDetailsLength > 6_100) {
      failures.push('permissionMetrics: details were not lazy-opened and truncated')
    }
    if (queuedPermissionMetrics.rawDetailsOpen !== false || queuedPermissionMetrics.activeText !== '하지 마') {
      failures.push('permissionMetrics: queued request did not reset local dialog state and focus')
    }
    if (escapedPermissionMetrics.permission !== null) failures.push('permissionMetrics: Escape did not close by denying')
    if (
      permissionResponses.length !== 1 ||
      permissionResponses[0].id !== 'permission-2' ||
      permissionResponses[0].decision?.behavior !== 'deny'
    ) {
      failures.push('permissionMetrics: Escape denial was not sent for the queued request')
    }
    if (noticeMetrics.noticeLevels.join(',') !== 'info,warn,error') {
      failures.push(`noticeMetrics: levels=${noticeMetrics.noticeLevels.join(',')}`)
    }
    if (noticeMetrics.noticeLabels.join(',') !== '정보,주의,오류') {
      failures.push(`noticeMetrics: labels=${noticeMetrics.noticeLabels.join(',')}`)
    }
    if (rendererProblems.length > 0) failures.push(`renderer console: ${rendererProblems.join(' | ')}`)

    process.stdout.write(`${JSON.stringify({ output, captures, failures }, null, 2)}\n`)
    win.destroy()
    app.quit()
    if (failures.length > 0) process.exitCode = 1
  }).catch((error) => {
    process.stderr.write(`${error.stack || error}\n`)
    app.exit(1)
  })
}
