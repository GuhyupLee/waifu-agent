import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { describe, expect, it, vi } from 'vitest'
import { VrmScene } from '../src/renderer/avatar/scene'
import type { MotionRole } from '../src/renderer/avatar/motionTransitions'

interface MotionHarness {
  root: THREE.Object3D
  modelLoadGeneration: number
  mixer: THREE.AnimationMixer
  clips: Map<string, THREE.AnimationClip>
  currentAction: THREE.AnimationAction | null
  currentMotionName: string | null
  currentMotionLoop: boolean
  currentMotionRole: MotionRole | null
  resumeMotion: { name: string; loop: boolean; time: number } | null
  ambientRemaining: number
  cursorLookWeight: number
  cursorLookFrom: number
  cursorLookTo: number
  cursorLookElapsed: number
  cursorLookDuration: number
  lastSwitchMixerTime: number
  pendingMotionRequest: { name: string; loop: boolean } | null
  actionWeights: Map<THREE.AnimationAction, number>
  motionBlend: unknown
  dragGrip: THREE.Object3D | null
  dragReleaseRemaining: number
  roaming: boolean
  roamMotionActive: boolean
  roamRestoreMotion: { name: string; loop: boolean; time: number } | null
  roamPendingMotion: { name: string; loop: boolean } | null
  roamLeanTarget: number
  vrm: null
  switchMotion(name: string, loop: boolean, reason: 'request' | 'ambient' | 'restore' | 'roam'): boolean
  advanceMotionBlend(delta: number): void
  updateMotionDirector(delta: number): void
  handleMotionFinished(action: THREE.AnimationAction): void
  playMotion(name: string, loop: boolean): boolean
  beginRoamMotion(name: string | null, direction: -1 | 0 | 1): boolean
  endRoamMotion(): void
  readonly motionNames: string[]
  loadVRM(url: string): Promise<unknown | null>
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
    root,
    modelLoadGeneration: 0,
    mixer,
    clips: new Map(entries),
    currentAction: null,
    currentMotionName: null,
    currentMotionLoop: false,
    currentMotionRole: null,
    resumeMotion: null,
    ambientRemaining: 0,
    cursorLookWeight: 1,
    cursorLookFrom: 1,
    cursorLookTo: 1,
    cursorLookElapsed: 0,
    cursorLookDuration: 0,
    lastSwitchMixerTime: Number.NaN,
    pendingMotionRequest: null,
    actionWeights: new Map<THREE.AnimationAction, number>(),
    motionBlend: null,
    dragGrip: null,
    dragReleaseRemaining: 0,
    roaming: false,
    roamMotionActive: false,
    roamRestoreMotion: null,
    roamPendingMotion: null,
    roamLeanTarget: 0,
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

    scene.advanceMotionBlend(0.01)
    scene.mixer.update(0.01)
    const beforeC = scene.root.position.x
    scene.updateMotionDirector(0.01)

    expect(scene.currentMotionName).toBe('C')
    expect(scene.pendingMotionRequest).toBeNull()
    const b = scene.mixer.clipAction(scene.clips.get('B')!)
    expect(b.getEffectiveWeight()).toBeLessThan(0.1)
    expect([...scene.actionWeights.values()].reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 8)

    scene.advanceMotionBlend(0.01)
    scene.mixer.update(0.01)
    expect(Math.abs(scene.root.position.x - beforeC)).toBeLessThan(0.1)
    expect([...scene.actionWeights.values()].reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 8)
  })

  it('returns a finished one-shot to the previous ambient loop and phase', () => {
    const scene = createHarness([
      ['idle-breathe', constantClip('idle-breathe', 0, 2)],
      ['wave-right', constantClip('wave-right', 1, 0.5)]
    ])

    expect(scene.switchMotion('idle-breathe', true, 'ambient')).toBe(true)
    scene.mixer.update(0.1)
    // ambient 는 루프 티가 나지 않도록 재생 속도를 흔든다. 떠난 위상을 실제로
    // 읽어야 하고, 0.1 초를 재생했으니 0.1 이라고 가정하면 안 된다.
    const leftAt = scene.currentAction!.time
    expect(scene.switchMotion('wave-right', false, 'request')).toBe(true)
    scene.advanceMotionBlend(0.6)
    scene.mixer.update(0.6)

    expect(scene.currentMotionName).toBe('idle-breathe')
    expect(scene.currentMotionLoop).toBe(true)
    expect(scene.currentAction?.time).toBeCloseTo(leftAt, 5)
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

  it('treats walk as a transient and restores the prior loop phase on arrival', () => {
    const scene = createHarness([
      ['idle-breathe', constantClip('idle-breathe', 0, 2)],
      ['walk', constantClip('walk', 1, 1.2)]
    ])

    expect(scene.switchMotion('idle-breathe', true, 'ambient')).toBe(true)
    scene.mixer.update(0.25)
    const leftAt = scene.currentAction!.time
    expect(scene.beginRoamMotion('walk', 1)).toBe(true)
    expect(scene.currentMotionName).toBe('walk')
    expect(scene.roamLeanTarget).toBeLessThan(0)

    scene.advanceMotionBlend(0.5)
    scene.mixer.update(0.5)
    scene.endRoamMotion()

    expect(scene.currentMotionName).toBe('idle-breathe')
    expect(scene.currentMotionLoop).toBe(true)
    expect(scene.currentAction?.time).toBeCloseTo(leftAt, 5)
    expect(scene.roamLeanTarget).toBe(0)
    expect([...scene.actionWeights.values()].reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 8)
  })

  it('holds a conversational motion until walking ends, then resumes the pre-walk idle', () => {
    const scene = createHarness([
      ['idle-breathe', constantClip('idle-breathe', 0, 2)],
      ['walk', constantClip('walk', 1, 1.2)],
      ['wave-right', constantClip('wave-right', 2, 0.5)]
    ])

    expect(scene.switchMotion('idle-breathe', true, 'ambient')).toBe(true)
    scene.mixer.update(0.1)
    expect(scene.beginRoamMotion('walk', -1)).toBe(true)
    expect(scene.playMotion('wave-right', false)).toBe(true)
    expect(scene.currentMotionName).toBe('walk')

    scene.endRoamMotion()
    expect(scene.currentMotionName).toBe('wave-right')
    expect(scene.resumeMotion?.name).toBe('idle-breathe')

    scene.advanceMotionBlend(0.6)
    scene.mixer.update(0.6)
    expect(scene.currentMotionName).toBe('idle-breathe')
  })

  it('drops a stale model-load rejection instead of reporting failure for the latest model', async () => {
    const scene = createHarness([])
    let rejectLoad!: (error: Error) => void
    const pending = new Promise<never>((_resolve, reject) => {
      rejectLoad = reject
    })
    const load = vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockReturnValue(pending)

    const stale = scene.loadVRM('stale.vrm')
    scene.modelLoadGeneration += 1
    rejectLoad(new Error('late network failure'))

    await expect(stale).resolves.toBeNull()
    load.mockRestore()
  })
})
