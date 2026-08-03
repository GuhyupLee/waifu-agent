import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PORT = 9338
const DEBUG_URL = `http://127.0.0.1:${PORT}`
const OUTPUT_DIR = join(tmpdir(), 'waifu-agent-vrma-preview')
const PROFILE_DIR = join(tmpdir(), 'waifu-agent-vrma-preview-profile')
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
  // 패키지 루트를 실행해야 resources 경로가 out/main 아래로 잘못 잡히지 않는다.
  // userData도 분리해 실제 앱의 세션·DB와 캡처 검증이 서로 건드리지 않게 한다.
  const child = spawn(
    electron,
    [`--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE_DIR}`, '.'],
    {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
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
      // URL 로만 찾는다. 예전에는 창 제목으로도 찾았는데, 제목은 설정의 퍼소나
      // 이름이라 사용자가 이름을 바꾸는 순간 맞지 않는다. avatar.html 은 안 바뀐다.
      target = targets.find((candidate) => /avatar\.html/i.test(candidate.url))
      if (target) break
      await delay(200)
    }
    if (!target) throw new Error('Avatar renderer target was not exposed by Electron')
    pageClient = connect(target.webSocketDebuggerUrl)
    await pageClient.send('Page.enable')
    await pageClient.send('Runtime.enable')
    // 55개 GLB를 모두 parse하고 마지막 motions 이벤트가 돌아올 시간을 준다.
    await delay(12_000)

    // 모델이 없는 빈 캔버스를 성공으로 캡처하지 않는다. 과거 out/main 을 앱 루트로
    // 실행했을 때 이 검사가 없어 검은 화면 세 장도 exit 0 이었던 적이 있다.
    const startupLog = output.join('')
    if (!startupLog.includes('[avatar] 모델 로드 완료')) {
      throw new Error('Avatar model did not finish loading before drag capture')
    }
    const motionCount = Number(startupLog.match(/\[avatar\] 모션 (\d+)개 등록/)?.[1] ?? 0)
    if (motionCount < 40) {
      throw new Error(`Expected at least 40 registered motions, got ${motionCount}`)
    }

    const idle = await capture(pageClient, 'idle.png')
    // BrowserWindow 크기는 CSS px이고 Page.captureScreenshot 결과는 DPR이 적용된 물리 px다.
    // 고정 물리 좌표를 쓰면 고해상도 화면에서 실루엣 밖을 누르게 되므로 viewport 비율로 잡는다.
    const viewport = await pageClient.send('Runtime.evaluate', {
      expression: '({ width: window.innerWidth, height: window.innerHeight })',
      returnByValue: true
    })
    const anchorX = Math.round(viewport.result.value.width * 0.5)
    const anchorY = Math.round(viewport.result.value.height * 0.48)
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
        window.addEventListener('pointermove', (event) => {
          marker.style.left = (event.clientX - 9) + 'px';
          marker.style.top = (event.clientY - 9) + 'px';
        }, true);
        const canvas = document.getElementById('avatar-canvas');
        canvas.setPointerCapture = () => {};
        canvas.releasePointerCapture = () => {};
        canvas.hasPointerCapture = () => false;
        window.__dispatchDragPreview = (type, init) => canvas.dispatchEvent(new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 77,
          pointerType: 'mouse',
          isPrimary: true,
          ...init
        }));
      })()`
    })
    const dispatchPointer = (type, init) => pageClient.send('Runtime.evaluate', {
      expression: `window.__dispatchDragPreview(${JSON.stringify(type)}, ${JSON.stringify(init)})`
    })
    await dispatchPointer('pointermove', {
      clientX: anchorX, clientY: anchorY, screenX: 1200, screenY: 500, buttons: 0
    })
    await dispatchPointer('pointerdown', {
      clientX: anchorX, clientY: anchorY, screenX: 1200, screenY: 500, button: 0, buttons: 1
    })
    const heldX = anchorX + 24
    const heldY = anchorY - 12
    // DevTools Input은 BrowserWindow가 이동할 때 pointer capture를 잃는다. DOM 이벤트를
    // 직접 보내면 런타임의 screen 좌표 경로는 그대로 검증하면서 캡처 자체는 안정적이다.
    await dispatchPointer('pointermove', {
      clientX: anchorX + 8, clientY: anchorY - 4,
      screenX: 1208, screenY: 496, button: 0, buttons: 1
    })
    await delay(40)
    await dispatchPointer('pointermove', {
      clientX: heldX, clientY: heldY, screenX: 1224, screenY: 488, button: 0, buttons: 1
    })
    await delay(900)
    const drag = await capture(pageClient, 'drag-held.png')
    const trace = await pageClient.send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__dragPreviewTrace)',
      returnByValue: true
    })
    await dispatchPointer('pointerup', {
      clientX: heldX, clientY: heldY, screenX: 1224, screenY: 488, button: 0, buttons: 0
    })
    await delay(900)
    const released = await capture(pageClient, 'released.png')
    process.stdout.write(`${idle}\n${drag}\n${released}\n`)
    process.stdout.write(`Drag trace: ${trace.result.value}\n`)
    process.stdout.write(
      output
        .join('')
        .split(/\r?\n/)
        .filter((line) => /모션|motion|avatar|voice/i.test(line))
        .join('\n') + '\n'
    )
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
