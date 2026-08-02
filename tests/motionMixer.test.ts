import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { VrmScene } from '../src/renderer/avatar/scene'
import type { MotionRole } from '../src/renderer/avatar/motionTransitions'

interface MotionHarness {
  mixer: THREE.AnimationMixer
  clips: Map<string, THREE.AnimationClip>
  currentAction: THREE.AnimationAction | null
  currentMotionName: string | null
  currentMotionLoop: boolean
  currentMotionRole: MotionRole | null
  resumeMotion: { name: string; loop: boolean; time: number } | null
  ambientRemaining: number
  lookAtResumeRemaining: number
  lastSwitchMixerTime: number
  pendingMotionRequest: { name: string; loop: boolean } | null
  retiringActions: Map<THREE.AnimationAction, number>
  dragGrip: THREE.Object3D | null
  vrm: null
  switchMotion(name: string, loop: boolean, reason: 'request' | 'ambient' | 'restore'): boolean
  updateMotionDirector(delta: number): void
  handleMotionFinished(action: THREE.AnimationAction): void
  playMotion(name: string, loop: boolean): boolean
  readonly motionNames: string[]
}

function constantClip(name: string, value: number, duration = 2): THREE.AnimationClip {
  return new THREE.AnimationClip(name, duration, [
    new THREE.VectorKeyframeTrack(
      '.position',
      [0, duration],
      [value, 0, 0, value, 0, 0]
    )
  ])
}

function createHarness(entries: Array<[string, THREE.AnimationClip]>): MotionHarness {
  const root = new THREE.Object3D()
  const mixer = new THREE.AnimationMixer(root)
  const scene = Object.create(VrmScene.prototype) as MotionHarness
  Object.assign(scene, {
    mixer,
    clips: new Map(entries),
    currentAction: null,
    currentMotionName: null,
    currentMotionLoop: false,
    currentMotionRole: null,
    resumeMotion: null,
    ambientRemaining: 0,
    lookAtResumeRemaining: 0,
    lastSwitchMixerTime: Number.NaN,
    pendingMotionRequest: null,
    retiringActions: new Map<THREE.AnimationAction, number>(),
    dragGrip: null,
    vrm: null
  })
  mixer.addEventListener('finished', ({ action }) => scene.handleMotionFinished(action))
  return scene
}

describe('VrmScene motion mixer integration', () => {
  it('coalesces A→B→C requests in one mixer tick and runs only latest C next tick', () => {
    const scene = createHarness([
      ['A', constantClip('A', 0)],
      ['B', constantClip('B', 1)],
      ['C', constantClip('C', 2)]
    ])

    expect(scene.switchMotion('A', false, 'request')).toBe(true)
    scene.mixer.update(0.1)
    expect(scene.switchMotion('B', false, 'request')).toBe(true)
    expect(scene.switchMotion('C', false, 'request')).toBe(true)

    expect(scene.currentMotionName).toBe('B')
    expect(scene.pendingMotionRequest).toEqual({ name: 'C', loop: false })

    scene.mixer.update(0.01)
    scene.updateMotionDirector(0.01)

    expect(scene.currentMotionName).toBe('C')
    expect(scene.pendingMotionRequest).toBeNull()
    const b = scene.mixer.clipAction(scene.clips.get('B')!)
    expect(b.getEffectiveWeight()).toBeLessThan(0.1)
  })

  it('returns a finished one-shot to the previous ambient loop and phase', () => {
    const scene = createHarness([
      ['idle-breathe', constantClip('idle-breathe', 0, 2)],
      ['wave-right', constantClip('wave-right', 1, 0.5)]
    ])

    expect(scene.switchMotion('idle-breathe', true, 'ambient')).toBe(true)
    scene.mixer.update(0.1)
    expect(scene.switchMotion('wave-right', false, 'request')).toBe(true)
    scene.mixer.update(0.6)

    expect(scene.currentMotionName).toBe('idle-breathe')
    expect(scene.currentMotionLoop).toBe(true)
    expect(scene.currentAction?.time).toBeCloseTo(0.1, 5)
  })

  it('ignores stale finished events and does not restart the same active one-shot', () => {
    const scene = createHarness([
      ['wave-right', constantClip('wave-right', 1)],
      ['nod', constantClip('nod', 2)]
    ])

    expect(scene.switchMotion('wave-right', false, 'request')).toBe(true)
    scene.mixer.update(0.1)
    const wave = scene.currentAction!
    const waveTime = wave.time
    expect(scene.switchMotion('wave-right', false, 'request')).toBe(true)
    expect(scene.currentAction).toBe(wave)
    expect(scene.currentAction?.time).toBe(waveTime)

    expect(scene.switchMotion('nod', false, 'request')).toBe(true)
    scene.handleMotionFinished(wave)
    expect(scene.currentMotionName).toBe('nod')
  })

  it('keeps pointer tether clips private to the drag path', () => {
    const scene = createHarness([
      ['idle-breathe', constantClip('idle-breathe', 0)],
      ['mouse-tether-right', constantClip('mouse-tether-right', 1)]
    ])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(scene.motionNames).toEqual(['idle-breathe'])
    expect(scene.playMotion('mouse-tether-right', true)).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})
