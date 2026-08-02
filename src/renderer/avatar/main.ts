import type { AvatarCommand, WaifuApi } from '@shared/protocol'
import { VrmScene } from './scene'
import { SpeechPlayer } from './speech'
import { Recorder } from './recorder'

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
const speech = new SpeechPlayer()
const recorder = new Recorder()
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

/** 화면을 가로질러 갈 때 재생할 모션. 앞에 있는 것부터 찾아 쓴다. */
const ROAM_MOTIONS = ['walk', 'happy-bounce', 'dance-bounce', 'jump']

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
let activePointerId: number | null = null
let dragDistance = 0
let suppressNextClick = false
let lastScreen = { x: 0, y: 0 }
/** 이번 프레임에 쌓인 이동량. render 에서 물리에 밀어 넣고 비운다. */
let dragDelta = { x: 0, y: 0 }

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  activePointerId = e.pointerId
  dragDistance = 0
  lastScreen = { x: e.screenX, y: e.screenY }
  canvas.setPointerCapture(e.pointerId)
})

window.addEventListener('pointermove', (e) => {
  scene.setPointer({ x: e.clientX, y: e.clientY })
  if (e.pointerId !== activePointerId) return
  const dx = e.screenX - lastScreen.x
  const dy = e.screenY - lastScreen.y
  lastScreen = { x: e.screenX, y: e.screenY }
  dragDistance += Math.abs(dx) + Math.abs(dy)

  // 단순 클릭에는 매달림 포즈를 켜지 않는다. 실제로 움직인 뒤부터 드래그다.
  if (!dragging && dragDistance >= 4) {
    dragging = true
    scene.hang.grab()
    scene.beginPointerDrag(e.clientX, e.clientY)
    waifu.sendAvatarEvent({ type: 'drag-start' })
  }
  if (!dragging) return
  scene.updatePointerDrag(e.clientX, e.clientY)
  dragDelta.x += dx
  dragDelta.y += dy
  waifu.sendAvatarEvent({ type: 'drag-move', dx, dy })
})

/** Pointer Capture + cancel/blur 를 한 곳에서 끝내 마우스를 창 밖에서 놓쳐도 고착되지 않게 한다. */
const finishDrag = (pointerId = activePointerId): void => {
  if (pointerId == null || pointerId !== activePointerId) return
  activePointerId = null
  if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId)
  const wasDragging = dragging
  dragging = false
  if (wasDragging) {
    scene.hang.release()
    scene.endPointerDrag()
    waifu.sendAvatarEvent({ type: 'drag-end' })
    suppressNextClick = true
    window.setTimeout(() => {
      suppressNextClick = false
    }, 0)
  }
}

window.addEventListener('pointerup', (e) => finishDrag(e.pointerId))
window.addEventListener('pointercancel', (e) => finishDrag(e.pointerId))
canvas.addEventListener('lostpointercapture', (e) => finishDrag(e.pointerId))
window.addEventListener('blur', () => finishDrag())

window.addEventListener('mouseleave', () => scene.setPointer(null))

canvas.addEventListener('click', () => {
  if (!suppressNextClick) waifu.sendAvatarEvent({ type: 'clicked' })
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
        if (!r) break
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
      // 성공하든 실패하든 현재 재생 가능한 목록을 알린다. 여러 개가 연달아 들어오므로
      // 마지막 것이 최종 목록이 된다.
      waifu.sendAvatarEvent({ type: 'motions', names: scene.motionNames })
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
      if (cmd.audio && cmd.visemes) {
        speech.play(cmd.audio, cmd.visemes, () => {
          scene.setViseme('sil', 0)
          waifu.sendAvatarEvent({ type: 'speech-end', id: cmd.id })
        })
      }
      break

    case 'status':
      showStatus(cmd.state)
      break

    case 'record':
      if (cmd.on) {
        try {
          await recorder.start()
          waifu.sendAvatarEvent({ type: 'recording', on: true })
          showSubtitle('🎤 듣는 중…')
        } catch (err) {
          // 마이크 권한이 없거나 장치가 없는 흔한 경우. 조용히 실패하면 왜 안 되는지 모른다.
          showSubtitle(`마이크를 쓸 수 없다: ${(err as Error).message}`)
          waifu.sendAvatarEvent({ type: 'recording', on: false })
        }
      } else if (recorder.recording) {
        const wavBase64 = await recorder.stop()
        waifu.sendAvatarEvent({ type: 'recording', on: false })
        waifu.sendAvatarEvent({ type: 'recorded', wavBase64 })
      }
      break

    case 'wake':
      scene.wake()
      break

    case 'roam':
      if (cmd.moving) {
        // 아직 walk 모션이 없다. 있으면 그걸 쓰고, 없으면 이동감이 있는 것으로 대체한다.
        // 라이브러리에 walk 가 추가되면 코드를 안 고쳐도 자동으로 그쪽을 쓴다.
        const motion = ROAM_MOTIONS.find((m) => scene.motionNames.includes(m))
        if (motion) scene.playMotion(motion, true)
      } else {
        scene.stopMotion()
      }
      break

    case 'stop-speaking':
      speech.stop()
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

  // 입모양은 오디오의 재생 위치에서 뽑는다. 벽시계로 하면 재생이 조금만 늦게
  // 시작해도 끝까지 어긋난 채로 간다.
  if (speech.speaking) {
    const { viseme, weight } = speech.sample()
    scene.setViseme(viseme, weight)
  }

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
