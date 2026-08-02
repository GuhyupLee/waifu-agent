import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PORT = 9338
const DEBUG_URL = `http://127.0.0.1:${PORT}`
const OUTPUT_DIR = join(tmpdir(), 'waifu-agent-vrma-preview')
const electron = resolve('node_modules/electron/dist/electron.exe')

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))

async function waitForJson(path, timeout = 20_000) {
  const started = Date.now()
  let lastError
  while (Date.now() - started < timeout) {
    try {
      const response = await fetch(`${DEBUG_URL}${path}`)
      if (response.ok) return await response.json()
    } catch (error) {
      lastError = error
    }
    await delay(200)
  }
  throw new Error(`Timed out waiting for Electron DevTools endpoint ${path}`, { cause: lastError })
}

function connect(url) {
  const socket = new WebSocket(url)
  let nextId = 1
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.id == null) return
    const handler = pending.get(message.id)
    if (!handler) return
    pending.delete(message.id)
    if (message.error) handler.reject(new Error(message.error.message))
    else handler.resolve(message.result)
  })
  const ready = new Promise((resolveReady, rejectReady) => {
    socket.addEventListener('open', resolveReady, { once: true })
    socket.addEventListener('error', rejectReady, { once: true })
  })
  return {
    socket,
    ready,
    async send(method, params = {}) {
      await ready
      const id = nextId++
      const result = new Promise((resolveResult, rejectResult) => {
        pending.set(id, { resolve: resolveResult, reject: rejectResult })
      })
      socket.send(JSON.stringify({ id, method, params }))
      return result
    },
    close() {
      socket.close()
    }
  }
}

async function capture(client, filename) {
  const result = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const path = join(OUTPUT_DIR, filename)
  await writeFile(path, Buffer.from(result.data, 'base64'))
  return path
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true })
  const output = []
  const child = spawn(electron, [`--remote-debugging-port=${PORT}`, 'out/main/index.js'], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', (chunk) => output.push(chunk.toString()))
  child.stderr.on('data', (chunk) => output.push(chunk.toString()))

  let browserClient
  let pageClient
  try {
    const version = await waitForJson('/json/version')
    browserClient = connect(version.webSocketDebuggerUrl)
    const started = Date.now()
    let target
    while (Date.now() - started < 20_000) {
      const targets = await waitForJson('/json/list')
      target = targets.find((candidate) => /avatar\.html/i.test(candidate.url) || candidate.title === '유로실라 유니아')
      if (target) break
      await delay(200)
    }
    if (!target) throw new Error('Avatar renderer target was not exposed by Electron')
    pageClient = connect(target.webSocketDebuggerUrl)
    await pageClient.send('Page.enable')
    await pageClient.send('Runtime.enable')
    // 54개 GLB를 모두 parse하고 마지막 motions 이벤트가 돌아올 시간을 준다.
    await delay(12_000)

    const idle = await capture(pageClient, 'idle.png')
    const anchorX = 210
    const anchorY = 270
    await pageClient.send('Runtime.evaluate', {
      expression: `(() => {
        window.__dragPreviewTrace = [];
        for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
          window.addEventListener(type, (event) => window.__dragPreviewTrace.push({
            type, pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY,
            screenX: event.screenX, screenY: event.screenY
          }), true);
        }
        const originalSend = window.waifu.sendAvatarEvent.bind(window.waifu);
        window.waifu.sendAvatarEvent = (event) => {
          if (/^drag/.test(event.type)) window.__dragPreviewTrace.push({ avatarEvent: event });
          return originalSend(event);
        };
        const marker = document.createElement('div');
        marker.id = '__drag_preview_marker';
        Object.assign(marker.style, {
          position: 'fixed', left: '${anchorX - 9}px', top: '${anchorY - 9}px',
          width: '18px', height: '18px', border: '2px solid #ff2d55',
          borderRadius: '50%', boxSizing: 'border-box', pointerEvents: 'none', zIndex: '2147483647'
        });
        document.body.appendChild(marker);
      })()`
    })
    await pageClient.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: anchorX, y: anchorY, screenX: 1200, screenY: 500
    })
    await pageClient.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: anchorX, y: anchorY, screenX: 1200, screenY: 500,
      button: 'left', buttons: 1, clickCount: 1
    })
    for (let step = 1; step <= 18; step += 1) {
      await pageClient.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: anchorX, y: anchorY,
        screenX: 1200 + step * 6, screenY: 500 - step * 3,
        button: 'left', buttons: 1
      })
      await delay(25)
    }
    await delay(900)
    const drag = await capture(pageClient, 'drag-held.png')
    const trace = await pageClient.send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__dragPreviewTrace)',
      returnByValue: true
    })
    await pageClient.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: anchorX, y: anchorY, screenX: 1308, screenY: 446,
      button: 'left', buttons: 0, clickCount: 1
    })
    await delay(900)
    const released = await capture(pageClient, 'released.png')
    process.stdout.write(`${idle}\n${drag}\n${released}\n`)
    process.stdout.write(`Drag trace: ${trace.result.value}\n`)
    process.stdout.write(output.join('').split(/\r?\n/).filter((line) => /모션|motion|avatar/i.test(line)).join('\n') + '\n')
  } finally {
    pageClient?.close()
    try {
      await Promise.race([browserClient?.send('Browser.close'), delay(1000)])
    } catch {
      // The browser may close its socket before acknowledging Browser.close.
    }
    browserClient?.close()
    await Promise.race([
      new Promise((resolveExit) => child.once('exit', resolveExit)),
      delay(3000).then(() => child.kill())
    ])
  }
}

await main()
