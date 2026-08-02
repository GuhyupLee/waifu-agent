export type MotionRole = 'ambient' | 'one-shot' | 'sustained' | 'interactive'

export const DEFAULT_AMBIENT_MOTION = 'idle-breathe'

/**
 * 아무 맥락 없이 재생해도 성격이 과해지지 않는 생활 idle만 자동 순환한다.
 * sleepy/thinking/shy 같은 상태성 모션은 LLM이 명시적으로 골랐을 때만 쓴다.
 */
const AMBIENT_POOL = [
  { name: DEFAULT_AMBIENT_MOTION, weight: 4 },
  { name: 'idle-soft-sway', weight: 2 },
  { name: 'idle-weight-left', weight: 1 },
  { name: 'idle-weight-right', weight: 1 },
  { name: 'idle-attentive', weight: 2 },
  { name: 'idle-curious', weight: 1 },
  { name: 'look-around', weight: 1 }
] as const

/** manifest에서 loop=true로 저작된 클립만 반복을 허용한다. */
const LOOPABLE_MOTIONS = new Set([
  'look-around',
  'relax',
  'sleepy',
  'thinking',
  'idle-breathe',
  'idle-soft-sway',
  'idle-weight-left',
  'idle-weight-right',
  'idle-attentive',
  'idle-shy',
  'idle-proud',
  'idle-impatient',
  'idle-curious',
  'explain-calm',
  'explain-energetic',
  'happy-bounce',
  'dance-sway',
  'dance-bounce',
  'mouse-tether-right',
  'mouse-tether-left',
  'mouse-tether-both',
  'mouse-tether-float-curl'
])

export function effectiveMotionLoop(name: string, requested: boolean): boolean {
  return requested && LOOPABLE_MOTIONS.has(name)
}

export function isInteractiveMotion(name: string): boolean {
  return name.startsWith('mouse-tether-')
}

export function motionRole(name: string, loop: boolean): MotionRole {
  if (isInteractiveMotion(name)) return 'interactive'
  if (loop && AMBIENT_POOL.some((entry) => entry.name === name)) return 'ambient'
  return loop ? 'sustained' : 'one-shot'
}

/**
 * 전환마다 같은 0.3초를 쓰면 작은 끄덕임은 굼뜨고 큰 idle 전환은 튄다.
 * 역할 간 간선마다 다른 시간을 줘 포즈 변화량에 맞는 관성을 만든다.
 */
export function transitionSeconds(from: MotionRole | null, to: MotionRole): number {
  if (to === 'interactive') return 0.14
  if (from === 'interactive') return 0.42
  // 첫 action의 원본 바인딩은 T-pose일 수 있으므로 그 상태와 섞지 않는다.
  if (from == null) return 0
  if (from === 'ambient' && to === 'ambient') return 0.72
  if (from === 'one-shot' && to === 'one-shot') return 0.2
  if (to === 'one-shot') return 0.26
  if (to === 'ambient') return 0.4
  return 0.34
}

/** 한 idle을 최소 두어 번 반복한 뒤 다음 미세 동작으로 넘어간다. */
export function ambientHoldSeconds(unitRandom: number): number {
  const unit = Math.max(0, Math.min(0.999999, unitRandom))
  return 12 + unit * 16
}

/** 가중치가 있는 자동 idle 선택. 현재 것 외에 선택지가 있으면 바로 반복하지 않는다. */
export function pickAmbientMotion(
  available: Pick<ReadonlySet<string>, 'has'>,
  current: string | null,
  unitRandom: number
): string | null {
  let candidates = AMBIENT_POOL.filter((entry) => available.has(entry.name))
  const alternatives = candidates.filter((entry) => entry.name !== current)
  if (alternatives.length > 0) candidates = alternatives
  if (candidates.length === 0) return null

  const total = candidates.reduce((sum, entry) => sum + entry.weight, 0)
  let cursor = Math.max(0, Math.min(0.999999, unitRandom)) * total
  for (const entry of candidates) {
    cursor -= entry.weight
    if (cursor < 0) return entry.name
  }
  return candidates[candidates.length - 1]?.name ?? null
}
