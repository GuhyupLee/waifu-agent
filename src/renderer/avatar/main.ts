import type { AvatarCommand, WaifuApi } from '@shared/protocol'
import { VrmScene } from './scene'

declare global {
  interface Window {
    waifu: WaifuApi
  }
}

const canvas = document.getElementById('avatar-canvas')
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('avatar-canvas 를 찾을 수 없다')

const subtitleEl = document.getElementById('subtitle')
const statusEl = document.getElementById('status')

const scene = new VrmScene(canvas)
const waifu = window.waifu

/** 자막을 띄운다. 글자 수에 비례해 머무는 시간을 늘린다 — 긴 말이 순식간에 사라지면 못 읽는다. */
let subtitleTimer: number | undefined
function showSubtitle(text: string): void {
  if (!subtitleEl) return
  subtitleEl.textContent = text
  subtitleEl.classList.add('on')
  window.clearTimeout(subtitleTimer)
  subtitleTimer = window.setTimeout(
    () => subtitleEl.classList.remove('on'),
    Math.max(2500, text.length * 110)
  )
}

const STATUS_COLOR: Record<string, string> = {
  idle: '',
  thinking: '#f0c674',
  working: '#7aa2f7',
  speaking: '#9ece6a',
  error: '#f7768e'
}

function showStatus(state: string): void {
  if (!statusEl) return
  const color = STATUS_COLOR[state] ?? ''
  if (!color) {
    statusEl.classList.remove('on')
    return
  }
  statusEl.style.background = color
  statusEl.classList.add('on')
}

window.addEventListener('resize', () => scene.resize())

// ─────────────────────── 드래그: 크레인에 매달린 것처럼 ───────────────────────
//
// 창을 실제로 옮기는 주체는 main 이다. 여기서는 화면 좌표 이동량만 넘기고,
// 같은 값으로 매달림 물리를 밀어준다.
//
// screenX/screenY 를 쓰는 이유: 창이 커서를 따라 움직이므로 clientX 는 거의 변하지 않는다.

let dragging = false
let lastScreen = { x: 0, y: 0 }
/** 이번 프레임에 쌓인 이동량. render 에서 물리에 밀어 넣고 비운다. */
let dragDelta = { x: 0, y: 0 }

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  dragging = true
  lastScreen = { x: e.screenX, y: e.screenY }
  scene.hang.grab()
  waifu.sendAvatarEvent({ type: 'drag-start' })
})

window.addEventListener('mousemove', (e) => {
  scene.setPointer({ x: e.clientX, y: e.clientY })
  if (!dragging) return
  const dx = e.screenX - lastScreen.x
  const dy = e.screenY - lastScreen.y
  lastScreen = { x: e.screenX, y: e.screenY }
  dragDelta.x += dx
  dragDelta.y += dy
  waifu.sendAvatarEvent({ type: 'drag-move', dx, dy })
})

// mouseup 은 창 밖에서 떼도 받아야 한다. window 에 걸어둔다.
window.addEventListener('mouseup', () => {
  if (!dragging) return
  dragging = false
  scene.hang.release()
  waifu.sendAvatarEvent({ type: 'drag-end' })
})

window.addEventListener('mouseleave', () => scene.setPointer(null))

canvas.addEventListener('click', () => {
  // 끌어서 옮긴 것과 그냥 클릭한 것을 구분한다. 드래그 끝에 패널이 뜨면 성가시다.
  if (Math.abs(dragDelta.x) + Math.abs(dragDelta.y) < 4) {
    waifu.sendAvatarEvent({ type: 'clicked' })
  }
})

// ─────────────────────── main 명령 처리 ───────────────────────

waifu.onAvatarCommand((cmd: AvatarCommand) => {
  void handleCommand(cmd)
})

async function handleCommand(cmd: AvatarCommand): Promise<void> {
  switch (cmd.type) {
    case 'load-model':
      try {
        const r = await scene.loadVRM(cmd.url)
        waifu.sendAvatarEvent({
          type: 'model-loaded',
          ok: true,
          hasExpressions: r.hasExpressions,
          hasLookAt: r.hasLookAt,
          presets: r.presets
        })
      } catch (err) {
        waifu.sendAvatarEvent({ type: 'model-loaded', ok: false, error: (err as Error).message })
      }
      break

    case 'load-motion':
      try {
        await scene.loadMotion(cmd.name, cmd.url)
      } catch (err) {
        console.warn(`[avatar] 모션 ${cmd.name} 로드 실패:`, err)
      }
      break

    case 'gaze':
      scene.setGaze(cmd.x, cmd.y)
      break

    case 'express':
      scene.setEmotion(cmd.emotion, cmd.intensity ?? 1)
      break

    case 'motion':
      if (!scene.playMotion(cmd.name, cmd.loop ?? false)) {
        console.warn(
          `[avatar] 모션 '${cmd.name}' 이 없다. 등록된 것: ${scene.motionNames.join(', ') || '(없음)'}`
        )
      }
      break

    case 'say':
      showSubtitle(cmd.text)
      if (cmd.emotion) scene.setEmotion(cmd.emotion)
      if (cmd.motion) scene.playMotion(cmd.motion, false)
      // TTS 는 Phase 4. 지금은 자막만 뜨고 입은 움직이지 않는다.
      break

    case 'status':
      showStatus(cmd.state)
      break

    case 'stop-speaking':
      scene.setViseme('sil', 0)
      break

    default:
      // say / status / set-scale 은 Phase 3·4 에서 붙인다.
      break
  }
}

// ─────────────────────── 렌더 루프 ───────────────────────

let lastHover = false
let frames = 0
let fpsWindowStart = performance.now()
let lastFrameAt = performance.now()

function tick(): void {
  const now = performance.now()
  const delta = (now - lastFrameAt) / 1000
  lastFrameAt = now

  // 드래그 이동량을 물리에 밀어 넣는다. 등속으로 끌면 흔들리지 않고, 방향을 꺾을 때 흔들린다.
  scene.hang.push(dragDelta.x, dragDelta.y, delta)
  dragDelta = { x: 0, y: 0 }

  const { pointerOverAvatar } = scene.render()

  // 상태가 바뀔 때만 IPC 를 보낸다. 매 프레임 보내면 초당 60번 창 스타일을 건드리게 된다.
  if (!dragging && pointerOverAvatar !== lastHover) {
    lastHover = pointerOverAvatar
    waifu.sendAvatarEvent({ type: 'hover', over: pointerOverAvatar })
  }

  frames += 1
  if (now - fpsWindowStart >= 1000) {
    waifu.sendAvatarEvent({ type: 'fps', value: (frames * 1000) / (now - fpsWindowStart) })
    frames = 0
    fpsWindowStart = now
  }

  requestAnimationFrame(tick)
}

requestAnimationFrame(tick)
