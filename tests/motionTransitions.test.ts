import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AMBIENT_MOTION,
  ambientHoldSeconds,
  effectiveMotionLoop,
  motionRole,
  pickAmbientMotion,
  transitionSeconds
} from '../src/renderer/avatar/motionTransitions'

describe('motion transition graph', () => {
  it('classifies ambient, one-shot, sustained, and pointer-interactive motions', () => {
    expect(motionRole(DEFAULT_AMBIENT_MOTION, true)).toBe('ambient')
    expect(motionRole('wave-right', false)).toBe('one-shot')
    expect(motionRole('dance-sway', true)).toBe('sustained')
    expect(motionRole('mouse-tether-right', true)).toBe('interactive')
  })

  it('never loops a clip whose authored boundary is not seamless', () => {
    expect(effectiveMotionLoop('wave-right', true)).toBe(false)
    expect(effectiveMotionLoop('dance-sway', true)).toBe(true)
    expect(motionRole('idle-breathe', false)).toBe('one-shot')
  })

  it('keeps the runtime loop catalog equal to the generated manifest', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../resources/motions/manifest.json', import.meta.url), 'utf8')
    ) as { files: Array<{ name: string; loop: boolean }> }
    for (const motion of manifest.files) {
      expect(effectiveMotionLoop(motion.name, true), motion.name).toBe(motion.loop)
    }
  })

  it('enters pointer tether quickly and leaves it with a longer settle', () => {
    expect(transitionSeconds('ambient', 'interactive')).toBeLessThan(
      transitionSeconds('interactive', 'ambient')
    )
  })

  it('uses a slow blend between living idles and a quick conversational handoff', () => {
    expect(transitionSeconds('ambient', 'ambient')).toBeGreaterThan(
      transitionSeconds('one-shot', 'one-shot')
    )
  })

  it('does not blend the first VRMA from a possible T-pose binding', () => {
    expect(transitionSeconds(null, 'ambient')).toBe(0)
  })

  it('does not immediately repeat an ambient motion when an alternative exists', () => {
    const available = new Set([DEFAULT_AMBIENT_MOTION, 'idle-soft-sway'])
    expect(pickAmbientMotion(available, DEFAULT_AMBIENT_MOTION, 0)).toBe('idle-soft-sway')
    expect(pickAmbientMotion(available, 'idle-soft-sway', 0.99)).toBe(DEFAULT_AMBIENT_MOTION)
  })

  it('keeps ambient dwell time within the intended range', () => {
    expect(ambientHoldSeconds(-1)).toBe(12)
    expect(ambientHoldSeconds(1)).toBeLessThan(28)
    expect(ambientHoldSeconds(0.5)).toBe(20)
  })
})
