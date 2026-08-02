import type { AvatarCommand, WaifuApi } from '@shared/protocol'
import { VrmScene } from './scene'

declare global {
  interface Window {
    waifu: WaifuApi
  }
}

const canvas = document.getElementById('avatar-canvas')
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('avatar-canvas 를 찾을 수 없다')

const scene = new VrmScene(canvas)
const waifu = window.waifu

window.addEventListener('resize', () => scene.resize())

// setIgnoreMouseEvents(true, { forward: true }) 상태에서도 WM_MOUSEMOVE 는 전달되므로
// mousemove 는 계속 들어온다. 반대로 mousedown/click 은 오지 않는다 —
// 그래서 클릭을 받으려면 이 핸들러가 먼저 ignore 를 꺼줘야 한다.
window.addEventListener('mousemove', (e) => scene.setPointer({ x: e.clientX, y: e.clientY }))
window.addEventListener('mouseleave', () => scene.setPointer(null))
window.addEventListener('click', () => waifu.sendAvatarEvent({ type: 'clicked' }))

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

    case 'express':
      scene.setEmotion(cmd.emotion, cmd.intensity ?? 1)
      break

    case 'motion':
      if (!scene.playMotion(cmd.name, cmd.loop ?? false)) {
        console.warn(`[avatar] 모션 ${cmd.name} 이 등록되어 있지 않다`)
      }
      break

    case 'stop-speaking':
      scene.setViseme('sil', 0)
      break

    default:
      // say / status / set-scale 은 Phase 3·4 에서 붙인다.
      break
  }
}

let lastHover = false
let frames = 0
let fpsWindowStart = performance.now()

function tick(): void {
  const { pointerOverAvatar } = scene.render()

  // 상태가 바뀔 때만 IPC 를 보낸다. 매 프레임 보내면 초당 60번 창 스타일을 건드리게 된다.
  if (pointerOverAvatar !== lastHover) {
    lastHover = pointerOverAvatar
    waifu.sendAvatarEvent({ type: 'hover', over: pointerOverAvatar })
  }

  frames += 1
  const now = performance.now()
  if (now - fpsWindowStart >= 1000) {
    waifu.sendAvatarEvent({ type: 'fps', value: (frames * 1000) / (now - fpsWindowStart) })
    frames = 0
    fpsWindowStart = now
  }

  requestAnimationFrame(tick)
}

requestAnimationFrame(tick)
