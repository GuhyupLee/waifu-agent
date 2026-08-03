import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Euler, Quaternion } from 'three'

const FPS = 30
const REST_HIPS_Y = 0.9
const TAU = Math.PI * 2
const GLB_JSON_CHUNK = 0x4e4f534a
const GLB_BIN_CHUNK = 0x004e4942
const REQUIRED_BONES = [
  'hips',
  'spine',
  'head',
  'leftUpperLeg',
  'leftLowerLeg',
  'leftFoot',
  'rightUpperLeg',
  'rightLowerLeg',
  'rightFoot',
  'leftUpperArm',
  'leftLowerArm',
  'leftHand',
  'rightUpperArm',
  'rightLowerArm',
  'rightHand'
]

/**
 * Generic VRM 1.0 T-pose hierarchy. The animation is retargeted by
 * @pixiv/three-vrm-animation, so the dimensions only establish a valid rest pose.
 */
const BONE_DEFS = [
  ['hips', null, [0, REST_HIPS_Y, 0]],
  ['leftUpperLeg', 'hips', [0.09, -0.05, 0]],
  ['leftLowerLeg', 'leftUpperLeg', [0, -0.42, 0]],
  ['leftFoot', 'leftLowerLeg', [0, -0.42, 0]],
  ['leftToes', 'leftFoot', [0, -0.055, 0.13]],
  ['rightUpperLeg', 'hips', [-0.09, -0.05, 0]],
  ['rightLowerLeg', 'rightUpperLeg', [0, -0.42, 0]],
  ['rightFoot', 'rightLowerLeg', [0, -0.42, 0]],
  ['rightToes', 'rightFoot', [0, -0.055, 0.13]],
  ['spine', 'hips', [0, 0.1, 0]],
  ['chest', 'spine', [0, 0.18, 0]],
  ['neck', 'chest', [0, 0.22, 0]],
  ['head', 'neck', [0, 0.09, 0]],
  ['leftShoulder', 'chest', [0.08, 0.16, 0]],
  ['leftUpperArm', 'leftShoulder', [0.1, 0, 0]],
  ['leftLowerArm', 'leftUpperArm', [0.25, 0, 0]],
  ['leftHand', 'leftLowerArm', [0.23, 0, 0]],
  ['leftThumbMetacarpal', 'leftHand', [0.025, -0.018, 0.025]],
  ['leftThumbProximal', 'leftThumbMetacarpal', [0.035, 0, 0]],
  ['leftThumbDistal', 'leftThumbProximal', [0.028, 0, 0]],
  ['leftIndexProximal', 'leftHand', [0.055, 0, 0.022]],
  ['leftIndexIntermediate', 'leftIndexProximal', [0.035, 0, 0]],
  ['leftIndexDistal', 'leftIndexIntermediate', [0.025, 0, 0]],
  ['leftMiddleProximal', 'leftHand', [0.058, 0, 0.007]],
  ['leftMiddleIntermediate', 'leftMiddleProximal', [0.038, 0, 0]],
  ['leftMiddleDistal', 'leftMiddleIntermediate', [0.027, 0, 0]],
  ['leftRingProximal', 'leftHand', [0.055, 0, -0.008]],
  ['leftRingIntermediate', 'leftRingProximal', [0.035, 0, 0]],
  ['leftRingDistal', 'leftRingIntermediate', [0.025, 0, 0]],
  ['leftLittleProximal', 'leftHand', [0.048, 0, -0.022]],
  ['leftLittleIntermediate', 'leftLittleProximal', [0.03, 0, 0]],
  ['leftLittleDistal', 'leftLittleIntermediate', [0.022, 0, 0]],
  ['rightShoulder', 'chest', [-0.08, 0.16, 0]],
  ['rightUpperArm', 'rightShoulder', [-0.1, 0, 0]],
  ['rightLowerArm', 'rightUpperArm', [-0.25, 0, 0]],
  ['rightHand', 'rightLowerArm', [-0.23, 0, 0]],
  ['rightThumbMetacarpal', 'rightHand', [-0.025, -0.018, 0.025]],
  ['rightThumbProximal', 'rightThumbMetacarpal', [-0.035, 0, 0]],
  ['rightThumbDistal', 'rightThumbProximal', [-0.028, 0, 0]],
  ['rightIndexProximal', 'rightHand', [-0.055, 0, 0.022]],
  ['rightIndexIntermediate', 'rightIndexProximal', [-0.035, 0, 0]],
  ['rightIndexDistal', 'rightIndexIntermediate', [-0.025, 0, 0]],
  ['rightMiddleProximal', 'rightHand', [-0.058, 0, 0.007]],
  ['rightMiddleIntermediate', 'rightMiddleProximal', [-0.038, 0, 0]],
  ['rightMiddleDistal', 'rightMiddleIntermediate', [-0.027, 0, 0]],
  ['rightRingProximal', 'rightHand', [-0.055, 0, -0.008]],
  ['rightRingIntermediate', 'rightRingProximal', [-0.035, 0, 0]],
  ['rightRingDistal', 'rightRingIntermediate', [-0.025, 0, 0]],
  ['rightLittleProximal', 'rightHand', [-0.048, 0, -0.022]],
  ['rightLittleIntermediate', 'rightLittleProximal', [-0.03, 0, 0]],
  ['rightLittleDistal', 'rightLittleIntermediate', [-0.022, 0, 0]]
]

const BONE_NAMES = BONE_DEFS.map(([name]) => name)
const BONE_INDEX = new Map(BONE_NAMES.map((name, index) => [name, index]))

const deg = (value) => (value * Math.PI) / 180
const clamp01 = (value) => Math.max(0, Math.min(1, value))
const smoothstep = (value) => {
  const t = clamp01(value)
  return t * t * (3 - 2 * t)
}
const bell = (u, start = 0, end = 1) => {
  if (u <= start || u >= end) return 0
  return Math.sin(Math.PI * ((u - start) / (end - start))) ** 2
}
const hold = (u, fadeIn = 0.14, fadeOut = 0.86) => {
  if (u < fadeIn) return smoothstep(u / fadeIn)
  if (u > fadeOut) return smoothstep((1 - u) / (1 - fadeOut))
  return 1
}
const beat = (u, count, phase = 0) => Math.sin(TAU * (count * u + phase))
const kick = (u, center, width) => {
  const x = Math.abs(u - center) / width
  return x >= 1 ? 0 : (1 + Math.cos(Math.PI * x)) / 2
}

function setBone(state, name, x, y, z) {
  state.pose[name] = [x, y, z]
}

function addBone(state, name, x = 0, y = 0, z = 0) {
  const current = state.pose[name] ?? [0, 0, 0]
  state.pose[name] = [current[0] + x, current[1] + y, current[2] + z]
}

function aimBone(state, name, target, amount) {
  const current = state.pose[name] ?? [0, 0, 0]
  state.pose[name] = current.map((value, index) => value + (target[index] - value) * amount)
}

function handShape(state, side, shape, amount = 1) {
  const prefix = side === 'left' ? 'left' : 'right'
  const sign = side === 'left' ? -1 : 1
  const fingers = ['Index', 'Middle', 'Ring', 'Little']
  const relaxed = { proximal: 8, intermediate: 7, distal: 4 }
  const fist = { proximal: 58, intermediate: 68, distal: 45 }
  const open = { proximal: -4, intermediate: 2, distal: 1 }
  const spread = { proximal: -8, intermediate: 0, distal: 0 }
  const values = shape === 'fist' || shape === 'point' ? fist : shape === 'open' ? open : shape === 'spread' ? spread : relaxed

  for (const finger of fingers) {
    const isPointing = shape === 'point' && finger === 'Index'
    const curl = isPointing ? open : values
    aimBone(state, `${prefix}${finger}Proximal`, [0, 0, sign * deg(curl.proximal)], amount)
    aimBone(state, `${prefix}${finger}Intermediate`, [0, 0, sign * deg(curl.intermediate)], amount)
    aimBone(state, `${prefix}${finger}Distal`, [0, 0, sign * deg(curl.distal)], amount)
  }

  const thumbCurl = shape === 'fist' ? 38 : shape === 'point' ? 28 : shape === 'open' || shape === 'spread' ? 2 : 10
  aimBone(state, `${prefix}ThumbMetacarpal`, [0, sign * deg(8), sign * deg(thumbCurl * 0.45)], amount)
  aimBone(state, `${prefix}ThumbProximal`, [0, 0, sign * deg(thumbCurl)], amount)
  aimBone(state, `${prefix}ThumbDistal`, [0, 0, sign * deg(thumbCurl * 0.8)], amount)
}

function arm(state, side, upper, lower, hand, amount) {
  const prefix = side === 'left' ? 'left' : 'right'
  aimBone(state, `${prefix}UpperArm`, upper, amount)
  aimBone(state, `${prefix}LowerArm`, lower, amount)
  aimBone(state, `${prefix}Hand`, hand, amount)
}

function legCurl(state, side, amount, depth = 1) {
  const prefix = side === 'left' ? 'left' : 'right'
  aimBone(state, `${prefix}UpperLeg`, [deg(-35 * depth), 0, side === 'left' ? deg(-4) : deg(4)], amount)
  aimBone(state, `${prefix}LowerLeg`, [deg(72 * depth), 0, 0], amount)
  aimBone(state, `${prefix}Foot`, [deg(-25 * depth), 0, 0], amount)
}

/**
 * 걸터앉은 하체. 고관절을 접어 허벅지를 수평에 두고, 무릎을 거의 같은 각도로
 * 반대로 접어 정강이를 수직으로 떨어뜨린다.
 *
 * `legCurl` 로는 이 자세가 나오지 않는다. 저건 웅크리기라 무릎 굽힘이 고관절
 * 굽힘의 두 배쯤 되고, 그러면 정강이가 뒤로 접혀 발이 엉덩이 쪽으로 온다.
 *
 * 좌우 각도를 2° 어긋나게 둔 것은 의도적이다. 완전 대칭인 다리는 마네킹으로
 * 보이고, 정강이가 정확히 겹치면 서로 파고든 것처럼 렌더링된다.
 */
function sitPose(state, amount = 1) {
  // -90/-88 인 이유: 골반이 뒤로 눕는 만큼 허벅지도 같이 뒤로 끌려간다.
  // 실측(scripts/inspect-vrma-pose.mjs)에서 -86 은 수평 대비 78° 로 나왔다.
  aimBone(state, 'leftUpperLeg', [deg(-90), deg(2), deg(-5)], amount)
  aimBone(state, 'leftLowerLeg', [deg(86), 0, 0], amount)
  aimBone(state, 'leftFoot', [deg(-14), 0, deg(-2)], amount)
  aimBone(state, 'rightUpperLeg', [deg(-88), deg(-2), deg(5)], amount)
  aimBone(state, 'rightLowerLeg', [deg(88), 0, 0], amount)
  aimBone(state, 'rightFoot', [deg(-12), 0, deg(2)], amount)

  // 골반은 조금만 내린다. 화면 위치는 WindowSitter 가 좌석 점을 실측해 창째로
  // 맞추므로 여기서 크게 내릴 이유가 없고, 많이 내리면 키 큰 모델의 정강이가
  // 투명 창 아래로 빠져나가 잘린다.
  state.hips[1] -= 0.08 * amount
}

function baseState(u, options = {}) {
  const phase = options.phase ?? 0
  const energy = options.energy ?? 1
  const breathe = Math.sin(TAU * u)
  const sway = Math.sin(TAU * u + phase)
  const micro = Math.sin(TAU * 2 * u + phase * 0.7)
  const pose = Object.fromEntries(BONE_NAMES.map((name) => [name, [0, 0, 0]]))
  const state = {
    pose,
    hips: [0.006 * sway * energy, REST_HIPS_Y + 0.004 * breathe * energy, 0.002 * micro * energy],
    look: [deg(0.7) * micro * energy, deg(2.2) * sway * energy, deg(0.3) * breathe * energy]
  }

  setBone(state, 'hips', deg(0.8) * breathe * energy, deg(0.7) * sway * energy, deg(1.1) * sway * energy)
  setBone(state, 'spine', deg(1.8) + deg(0.5) * breathe * energy, deg(0.5) * sway * energy, deg(-0.8) * sway * energy)
  setBone(state, 'chest', deg(-1.2) + deg(0.9) * breathe * energy, deg(-0.4) * sway * energy, deg(-0.4) * sway * energy)
  setBone(state, 'neck', deg(-0.3) * breathe * energy, deg(0.7) * sway * energy, deg(0.4) * sway * energy)
  setBone(state, 'head', deg(-1) + deg(0.5) * micro * energy, deg(1.2) * sway * energy, deg(-0.7) * sway * energy)
  setBone(state, 'leftShoulder', 0, 0, deg(-2) - deg(0.5) * breathe * energy)
  setBone(state, 'rightShoulder', 0, 0, deg(2) + deg(0.5) * breathe * energy)
  setBone(state, 'leftUpperArm', deg(3), deg(-2), deg(-74) - deg(0.7) * breathe * energy)
  setBone(state, 'rightUpperArm', deg(3), deg(2), deg(74) + deg(0.7) * breathe * energy)
  setBone(state, 'leftLowerArm', deg(-2), deg(-5), deg(-7))
  setBone(state, 'rightLowerArm', deg(-2), deg(5), deg(7))
  setBone(state, 'leftHand', 0, deg(-2), deg(-2))
  setBone(state, 'rightHand', 0, deg(2), deg(2))
  setBone(state, 'leftUpperLeg', deg(-1) - deg(0.6) * sway * energy, 0, deg(-1.5))
  setBone(state, 'rightUpperLeg', deg(-1) + deg(0.6) * sway * energy, 0, deg(1.5))
  setBone(state, 'leftLowerLeg', deg(2.5) + deg(0.5) * sway * energy, 0, 0)
  setBone(state, 'rightLowerLeg', deg(2.5) - deg(0.5) * sway * energy, 0, 0)
  setBone(state, 'leftFoot', deg(-2), 0, 0)
  setBone(state, 'rightFoot', deg(-2), 0, 0)
  handShape(state, 'left', 'relaxed')
  handShape(state, 'right', 'relaxed')
  return state
}

function withBase(modifier, options = {}) {
  return (u, time) => {
    const state = baseState(u, options)
    modifier(state, u, time)
    return state
  }
}

function define(name, title, category, duration, loop, expression, description, sample) {
  return { name, title, category, duration, loop, expression, description, sample }
}

const MOTIONS = [
  // Independently authored equivalents of the eleven reference-repository themes.
  define('angry', '화가 나서 발을 구름', 'emotion', 3.6, false, 'angry', '주먹을 쥐고 몸을 숙이며 두 번 발을 구른다.', withBase((s, u) => {
    const a = hold(u, 0.1, 0.92)
    addBone(s, 'spine', deg(13) * a, 0, deg(2) * beat(u, 2) * a)
    addBone(s, 'head', deg(-8) * a, deg(5) * beat(u, 2) * a, 0)
    arm(s, 'left', [deg(10), deg(-5), deg(-52)], [deg(-8), deg(-12), deg(-25)], [0, 0, deg(-8)], a)
    arm(s, 'right', [deg(10), deg(5), deg(52)], [deg(-8), deg(12), deg(25)], [0, 0, deg(8)], a)
    handShape(s, 'left', 'fist', a)
    handShape(s, 'right', 'fist', a)
    const stomp = kick(u, 0.38, 0.07) + kick(u, 0.7, 0.07)
    addBone(s, 'rightUpperLeg', deg(-15) * stomp, 0, 0)
    addBone(s, 'rightLowerLeg', deg(25) * stomp, 0, 0)
    s.hips[1] -= 0.025 * stomp
    s.look = [deg(-7) * a, 0, 0]
  }, { phase: 0.3, energy: 1.3 })),

  define('blush', '수줍게 얼굴을 가림', 'emotion', 4.4, false, 'happy', '고개를 비스듬히 숙이고 두 손을 얼굴 가까이 모은다.', withBase((s, u) => {
    const a = hold(u, 0.18, 0.86)
    addBone(s, 'spine', deg(5) * a, deg(-7) * a, deg(5) * a)
    addBone(s, 'head', deg(11) * a, deg(-13) * a, deg(8) * a)
    arm(s, 'left', [deg(-12), deg(-62), deg(-37)], [deg(-18), deg(-10), deg(-72)], [deg(-10), 0, deg(-15)], a)
    arm(s, 'right', [deg(-12), deg(62), deg(37)], [deg(-18), deg(10), deg(72)], [deg(-10), 0, deg(15)], a)
    handShape(s, 'left', 'open', a)
    handShape(s, 'right', 'open', a)
    s.hips[0] += 0.012 * Math.sin(TAU * 2 * u) * a
    s.look = [deg(7) * a, deg(-9) * a, 0]
  }, { phase: 1.1, energy: 0.65 })),

  define('clapping', '박수', 'gesture', 3.8, false, 'happy', '몸 앞에서 리듬을 달리해 네 번 박수친다.', withBase((s, u) => {
    const a = hold(u, 0.12, 0.9)
    const clap = (0.5 + 0.5 * Math.cos(TAU * 4 * u)) * a
    arm(s, 'left', [deg(-8), deg(-63), deg(-25)], [0, deg(-8), deg(-46 - 22 * clap)], [0, deg(-4), deg(-10)], a)
    arm(s, 'right', [deg(-8), deg(63), deg(25)], [0, deg(8), deg(46 + 22 * clap)], [0, deg(4), deg(10)], a)
    handShape(s, 'left', 'open', a)
    handShape(s, 'right', 'open', a)
    addBone(s, 'chest', deg(-3) * clap, 0, 0)
    s.hips[1] += 0.008 * Math.sin(TAU * 4 * u) * a
  }, { phase: 0.6, energy: 1.1 })),

  define('goodbye', '큰 작별 인사', 'greeting', 4.8, false, 'happy', '몸을 기울이며 오른손을 크게 세 번 흔든다.', withBase((s, u) => {
    const a = hold(u, 0.13, 0.9)
    const wave = Math.sin(TAU * 3 * u) * a
    arm(s, 'right', [deg(2), deg(8), deg(-118)], [deg(5), deg(8), deg(18 + 12 * wave)], [0, deg(18) * wave, deg(12) * wave], a)
    handShape(s, 'right', 'open', a)
    addBone(s, 'spine', 0, 0, deg(7) * a)
    addBone(s, 'head', 0, deg(-4) * a, deg(-8) * a)
    s.hips[0] -= 0.018 * a
    s.look = [deg(-2) * a, deg(-7) * a, 0]
  }, { phase: 0.4, energy: 1 })),

  define('jump', '신나는 점프', 'action', 3.2, false, 'happy', '살짝 웅크렸다 뛰어오르고 부드럽게 착지한다.', withBase((s, u) => {
    const crouch = kick(u, 0.2, 0.15)
    const air = bell(u, 0.23, 0.78)
    const land = kick(u, 0.82, 0.12)
    const bend = Math.max(crouch, land * 0.7)
    legCurl(s, 'left', bend, 0.55)
    legCurl(s, 'right', bend, 0.55)
    const arms = clamp01(crouch * 0.3 + air)
    arm(s, 'left', [0, 0, deg(55)], [0, 0, deg(-4)], [0, 0, 0], arms)
    arm(s, 'right', [0, 0, deg(-55)], [0, 0, deg(4)], [0, 0, 0], arms)
    handShape(s, 'left', 'spread', arms)
    handShape(s, 'right', 'spread', arms)
    s.hips[1] += 0.22 * air - 0.06 * bend
    addBone(s, 'spine', deg(-10) * air + deg(9) * bend, 0, 0)
  }, { phase: 0.2, energy: 1.2 })),

  define('look-around', '주변을 두리번', 'idle', 6.4, true, 'neutral', '고개와 시선이 서로 다른 속도로 주변을 살핀다.', withBase((s, u) => {
    const yaw = deg(24) * Math.sin(TAU * u)
    const pitch = deg(6) * Math.sin(TAU * 2 * u + 0.5)
    addBone(s, 'neck', pitch * 0.25, yaw * 0.35, 0)
    addBone(s, 'head', pitch * 0.75, yaw * 0.65, deg(3) * Math.sin(TAU * u + 1))
    s.look = [pitch * 0.8, yaw * 0.75, 0]
  }, { phase: 0.8, energy: 0.7 })),

  define('relax', '편안한 휴식', 'idle', 7.2, true, 'relaxed', '한쪽 다리에 체중을 두고 천천히 호흡한다.', withBase((s, u) => {
    const sway = Math.sin(TAU * u)
    addBone(s, 'hips', deg(-2), deg(2) * sway, deg(5))
    addBone(s, 'spine', deg(-2), 0, deg(-4))
    addBone(s, 'head', deg(2), deg(4) * sway, deg(3))
    addBone(s, 'leftUpperLeg', deg(-3), 0, deg(-4))
    addBone(s, 'rightLowerLeg', deg(7), 0, 0)
    s.hips[0] += 0.018
  }, { phase: 1.4, energy: 0.55 })),

  define('sad', '풀이 죽음', 'emotion', 5.4, false, 'sad', '어깨와 고개가 내려가고 몸이 작게 흔들린다.', withBase((s, u) => {
    const a = hold(u, 0.18, 0.88)
    addBone(s, 'spine', deg(16) * a, 0, deg(2) * Math.sin(TAU * u) * a)
    addBone(s, 'chest', deg(8) * a, 0, 0)
    addBone(s, 'head', deg(18) * a, deg(5) * Math.sin(TAU * u) * a, 0)
    addBone(s, 'leftShoulder', 0, 0, deg(8) * a)
    addBone(s, 'rightShoulder', 0, 0, deg(-8) * a)
    s.hips[1] -= 0.035 * a
    s.look = [deg(15) * a, 0, 0]
  }, { phase: 2, energy: 0.4 })),

  define('sleepy', '꾸벅꾸벅 졸기', 'idle', 6.8, true, 'relaxed', '호흡이 느려지고 고개가 두 번 부드럽게 떨어진다.', withBase((s, u) => {
    const nod = Math.max(0, Math.sin(TAU * 2 * u - 0.8)) ** 4
    addBone(s, 'spine', deg(5), 0, deg(2) * Math.sin(TAU * u))
    addBone(s, 'head', deg(22) * nod + deg(6), 0, deg(2) * Math.sin(TAU * u))
    s.hips[1] -= 0.012 * nod
    s.look = [deg(18) * nod, 0, 0]
  }, { phase: 2.4, energy: 0.35 })),

  define('surprised', '깜짝 놀람', 'emotion', 2.8, false, 'surprised', '상체를 뒤로 빼며 두 팔과 손가락을 활짝 편다.', withBase((s, u) => {
    const a = bell(u, 0.08, 0.92)
    addBone(s, 'hips', deg(-8) * a, 0, 0)
    addBone(s, 'spine', deg(-18) * a, 0, 0)
    addBone(s, 'head', deg(-12) * a, 0, 0)
    arm(s, 'left', [deg(-18), deg(-20), deg(-38)], [0, 0, deg(-5)], [deg(-8), 0, deg(-8)], a)
    arm(s, 'right', [deg(-18), deg(20), deg(38)], [0, 0, deg(5)], [deg(-8), 0, deg(8)], a)
    handShape(s, 'left', 'spread', a)
    handShape(s, 'right', 'spread', a)
    s.hips[2] -= 0.05 * a
    s.look = [deg(-8) * a, 0, 0]
  }, { phase: 0, energy: 1.25 })),

  define('thinking', '곰곰이 생각', 'idle', 7, true, 'neutral', '오른손을 턱에 대고 시선이 천천히 위로 흐른다.', withBase((s, u) => {
    const a = 0.95
    arm(s, 'right', [deg(-8), deg(45), deg(48)], [deg(-12), deg(12), deg(78)], [deg(-14), deg(5), deg(15)], a)
    handShape(s, 'right', 'point', 0.65)
    addBone(s, 'spine', deg(4), deg(-4), deg(3))
    addBone(s, 'head', deg(3), deg(-10) + deg(7) * Math.sin(TAU * u), deg(6))
    s.look = [deg(-10), deg(-13) + deg(9) * Math.sin(TAU * u), 0]
  }, { phase: 1.7, energy: 0.45 })),

  // Living idles.
  define('idle-breathe', '잔잔한 호흡', 'idle', 6, true, 'neutral', '가슴·어깨·골반에 미세한 호흡을 분산한다.', withBase(() => {}, { phase: 0.2, energy: 0.65 })),
  define('idle-soft-sway', '부드러운 좌우 흔들림', 'idle', 6.8, true, 'neutral', '체중과 시선이 천천히 좌우로 이동한다.', withBase((s, u) => {
    const a = Math.sin(TAU * u)
    s.hips[0] += 0.025 * a
    addBone(s, 'hips', 0, 0, deg(4) * a)
    addBone(s, 'spine', 0, 0, deg(-5) * a)
    addBone(s, 'head', 0, deg(4) * a, deg(2) * a)
  }, { phase: 0.8, energy: 0.65 })),
  define('idle-weight-left', '왼발에 체중 싣기', 'idle', 6.4, true, 'neutral', '왼발에 무게를 싣고 오른 무릎을 느슨하게 푼다.', withBase((s, u) => {
    const a = 0.85 + 0.15 * Math.sin(TAU * u)
    s.hips[0] += 0.022 * a
    addBone(s, 'hips', 0, 0, deg(5) * a)
    addBone(s, 'rightUpperLeg', deg(-4) * a, 0, deg(3) * a)
    addBone(s, 'rightLowerLeg', deg(9) * a, 0, 0)
  }, { phase: 1.2, energy: 0.55 })),
  define('idle-weight-right', '오른발에 체중 싣기', 'idle', 6.4, true, 'neutral', '오른발에 무게를 싣고 왼 무릎을 느슨하게 푼다.', withBase((s, u) => {
    const a = 0.85 + 0.15 * Math.sin(TAU * u)
    s.hips[0] -= 0.022 * a
    addBone(s, 'hips', 0, 0, deg(-5) * a)
    addBone(s, 'leftUpperLeg', deg(-4) * a, 0, deg(-3) * a)
    addBone(s, 'leftLowerLeg', deg(9) * a, 0, 0)
  }, { phase: 2.1, energy: 0.55 })),
  define('idle-attentive', '집중해서 듣기', 'idle', 5.6, true, 'neutral', '상체를 조금 앞으로 두고 작은 반응을 보인다.', withBase((s, u) => {
    addBone(s, 'spine', deg(-3), 0, 0)
    addBone(s, 'head', deg(-2) + deg(2) * Math.sin(TAU * u), deg(3) * Math.sin(TAU * u), 0)
    s.hips[2] += 0.012
    s.look = [deg(-2), deg(3) * Math.sin(TAU * u), 0]
  }, { phase: 0.5, energy: 0.8 })),
  define('idle-shy', '수줍은 대기', 'idle', 6.6, true, 'happy', '발끝을 모으고 손을 앞에 둔 채 시선을 살짝 피한다.', withBase((s, u) => {
    arm(s, 'left', [deg(4), deg(-16), deg(-62)], [deg(-5), deg(-14), deg(-26)], [0, 0, deg(-8)], 0.8)
    arm(s, 'right', [deg(4), deg(16), deg(62)], [deg(-5), deg(14), deg(26)], [0, 0, deg(8)], 0.8)
    addBone(s, 'leftUpperLeg', 0, deg(-3), deg(3))
    addBone(s, 'rightUpperLeg', 0, deg(3), deg(-3))
    addBone(s, 'head', deg(5), deg(-9) + deg(4) * Math.sin(TAU * u), deg(4))
    s.look = [deg(5), deg(-8) + deg(4) * Math.sin(TAU * u), 0]
  }, { phase: 1.8, energy: 0.45 })),
  define('idle-proud', '자신감 있는 대기', 'idle', 6.2, true, 'neutral', '가슴을 펴고 안정된 박자로 체중을 옮긴다.', withBase((s, u) => {
    addBone(s, 'spine', deg(-5), 0, 0)
    addBone(s, 'chest', deg(-6), 0, 0)
    addBone(s, 'head', deg(-3), deg(3) * Math.sin(TAU * u), 0)
    arm(s, 'left', [deg(3), deg(-3), deg(-66)], [0, deg(-10), deg(-22)], [0, 0, deg(-8)], 0.65)
    arm(s, 'right', [deg(3), deg(3), deg(66)], [0, deg(10), deg(22)], [0, 0, deg(8)], 0.65)
  }, { phase: 0.9, energy: 0.75 })),
  define('idle-impatient', '조금 초조한 대기', 'idle', 4.8, true, 'neutral', '발끝을 두드리고 팔과 어깨가 작은 박자를 탄다.', withBase((s, u) => {
    const tap = Math.max(0, Math.sin(TAU * 3 * u)) ** 4
    addBone(s, 'rightFoot', deg(-12) * tap, 0, 0)
    addBone(s, 'rightLowerLeg', deg(4) * tap, 0, 0)
    addBone(s, 'rightShoulder', 0, 0, deg(-2) * tap)
    s.hips[1] += 0.004 * tap
  }, { phase: 1.5, energy: 0.9 })),
  define('idle-curious', '호기심 어린 대기', 'idle', 6.5, true, 'neutral', '머리를 기울이고 가끔 반대편도 살펴본다.', withBase((s, u) => {
    const side = Math.sin(TAU * u)
    addBone(s, 'neck', deg(-2), deg(5) * side, deg(7) * side)
    addBone(s, 'head', deg(-2), deg(8) * side, deg(10) * side)
    s.look = [deg(-2), deg(12) * side, deg(2) * side]
  }, { phase: 0.1, energy: 0.65 })),

  // Greetings and conversational responses.
  define('wave-right', '오른손 인사', 'greeting', 3.6, false, 'happy', '오른손을 들어 손목 중심으로 가볍게 흔든다.', withBase((s, u) => {
    const a = hold(u)
    const w = Math.sin(TAU * 3.5 * u) * a
    arm(s, 'right', [0, deg(6), deg(-108)], [0, deg(4), deg(24)], [0, deg(25) * w, deg(8) * w], a)
    handShape(s, 'right', 'open', a)
    addBone(s, 'head', 0, deg(-5) * a, deg(-4) * a)
  }, { phase: 0.4, energy: 0.9 })),
  define('wave-left', '왼손 인사', 'greeting', 3.6, false, 'happy', '왼손을 들어 손목 중심으로 가볍게 흔든다.', withBase((s, u) => {
    const a = hold(u)
    const w = Math.sin(TAU * 3.5 * u) * a
    arm(s, 'left', [0, deg(-6), deg(108)], [0, deg(-4), deg(-24)], [0, deg(-25) * w, deg(-8) * w], a)
    handShape(s, 'left', 'open', a)
    addBone(s, 'head', 0, deg(5) * a, deg(4) * a)
  }, { phase: 1.4, energy: 0.9 })),
  define('bow-small', '가벼운 목례', 'greeting', 2.6, false, 'neutral', '상체와 고개를 함께 숙이는 짧은 인사다.', withBase((s, u) => {
    const a = bell(u, 0.08, 0.92)
    addBone(s, 'hips', deg(7) * a, 0, 0)
    addBone(s, 'spine', deg(13) * a, 0, 0)
    addBone(s, 'chest', deg(8) * a, 0, 0)
    addBone(s, 'head', deg(7) * a, 0, 0)
    s.hips[2] += 0.025 * a
    s.look = [deg(13) * a, 0, 0]
  }, { phase: 0.2, energy: 0.45 })),
  define('bow-deep', '정중한 큰절', 'greeting', 4, false, 'neutral', '손을 앞에 모으고 허리부터 깊게 숙인다.', withBase((s, u) => {
    const a = bell(u, 0.08, 0.94)
    addBone(s, 'hips', deg(18) * a, 0, 0)
    addBone(s, 'spine', deg(27) * a, 0, 0)
    addBone(s, 'chest', deg(12) * a, 0, 0)
    addBone(s, 'head', deg(9) * a, 0, 0)
    arm(s, 'left', [0, deg(-14), deg(-64)], [0, deg(-10), deg(-24)], [0, 0, deg(-6)], a)
    arm(s, 'right', [0, deg(14), deg(64)], [0, deg(10), deg(24)], [0, 0, deg(6)], a)
    s.hips[2] += 0.06 * a
  }, { phase: 0.6, energy: 0.35 })),
  define('nod', '끄덕임', 'response', 1.8, false, 'neutral', '한 번 또렷하게 고개를 끄덕인다.', withBase((s, u) => {
    const a = bell(u, 0.12, 0.88)
    addBone(s, 'neck', deg(5) * a, 0, 0)
    addBone(s, 'head', deg(18) * a, 0, 0)
    s.look = [deg(10) * a, 0, 0]
  }, { phase: 0.1, energy: 0.4 })),
  define('double-nod', '두 번 끄덕임', 'response', 2.6, false, 'happy', '조금 빠르게 두 번 동의한다.', withBase((s, u) => {
    const a = hold(u, 0.08, 0.92)
    const n = Math.max(0, Math.sin(TAU * 2 * u - 0.5)) ** 2 * a
    addBone(s, 'neck', deg(4) * n, 0, 0)
    addBone(s, 'head', deg(17) * n, 0, 0)
    s.hips[1] -= 0.006 * n
  }, { phase: 0.5, energy: 0.65 })),
  define('shake-no', '도리도리', 'response', 2.8, false, 'neutral', '고개와 시선을 좌우로 두 번 저어 거절한다.', withBase((s, u) => {
    const a = hold(u, 0.1, 0.9)
    const n = Math.sin(TAU * 2 * u) * a
    addBone(s, 'neck', 0, deg(9) * n, 0)
    addBone(s, 'head', 0, deg(22) * n, deg(-2) * n)
    s.look = [0, deg(18) * n, 0]
  }, { phase: 1, energy: 0.5 })),
  define('curious-head-tilt', '궁금한 고개 갸웃', 'response', 3.2, false, 'neutral', '한쪽으로 천천히 고개를 기울였다 돌아온다.', withBase((s, u) => {
    const a = bell(u, 0.08, 0.94)
    addBone(s, 'neck', deg(-2) * a, deg(-7) * a, deg(8) * a)
    addBone(s, 'head', deg(-3) * a, deg(-10) * a, deg(15) * a)
    s.look = [deg(-3) * a, deg(-12) * a, deg(4) * a]
  }, { phase: 1.7, energy: 0.5 })),
  define('agree', '온몸으로 동의', 'response', 3, false, 'happy', '상체를 앞으로 기울이며 손바닥을 보이고 끄덕인다.', withBase((s, u) => {
    const a = bell(u, 0.06, 0.95)
    const nod = Math.max(0, Math.sin(TAU * 2 * u)) * a
    addBone(s, 'spine', deg(-7) * a, 0, 0)
    addBone(s, 'head', deg(12) * nod, 0, 0)
    arm(s, 'right', [deg(-4), deg(42), deg(48)], [0, deg(8), deg(35)], [0, 0, deg(8)], a)
    handShape(s, 'right', 'open', a)
  }, { phase: 0.3, energy: 0.9 })),
  define('disagree', '난감한 부정', 'response', 3.4, false, 'neutral', '손을 내저으며 고개도 반대 박자로 흔든다.', withBase((s, u) => {
    const a = hold(u, 0.12, 0.9)
    const w = Math.sin(TAU * 2.5 * u) * a
    addBone(s, 'head', 0, deg(-15) * w, deg(2) * w)
    arm(s, 'right', [0, deg(50), deg(12)], [0, deg(8), deg(20 + 18 * w)], [0, deg(24) * w, deg(6)], a)
    handShape(s, 'right', 'open', a)
  }, { phase: 1.2, energy: 0.8 })),
  define('salute', '경쾌한 경례', 'greeting', 2.8, false, 'happy', '오른손을 이마에 붙였다 힘차게 내린다.', withBase((s, u) => {
    const a = bell(u, 0.1, 0.92)
    arm(s, 'right', [deg(-3), deg(36), deg(-52)], [deg(-8), deg(5), deg(86)], [deg(-5), deg(-4), deg(10)], a)
    handShape(s, 'right', 'open', a)
    addBone(s, 'head', deg(-3) * a, deg(-4) * a, 0)
  }, { phase: 0.7, energy: 0.8 })),
  define('welcome', '두 팔로 환영', 'greeting', 3.8, false, 'happy', '두 팔을 바깥으로 열며 반갑게 몸을 앞으로 내민다.', withBase((s, u) => {
    const a = bell(u, 0.08, 0.95)
    arm(s, 'left', [deg(-8), deg(-22), deg(-24)], [0, deg(-6), deg(-8)], [0, 0, deg(-5)], a)
    arm(s, 'right', [deg(-8), deg(22), deg(24)], [0, deg(6), deg(8)], [0, 0, deg(5)], a)
    handShape(s, 'left', 'spread', a)
    handShape(s, 'right', 'spread', a)
    addBone(s, 'spine', deg(-8) * a, 0, 0)
    s.hips[2] += 0.025 * a
  }, { phase: 0.2, energy: 1 })),
  define('listen-close', '가까이 귀 기울이기', 'response', 4.2, false, 'neutral', '한 손을 귀에 대고 상체를 가까이 기울인다.', withBase((s, u) => {
    const a = hold(u, 0.16, 0.86)
    arm(s, 'right', [deg(-4), deg(34), deg(-42)], [deg(-8), deg(4), deg(82)], [0, deg(12), deg(15)], a)
    handShape(s, 'right', 'open', a)
    addBone(s, 'spine', deg(-9) * a, deg(-7) * a, deg(-5) * a)
    addBone(s, 'head', deg(-4) * a, deg(-14) * a, deg(-12) * a)
    s.look = [deg(-3) * a, deg(-12) * a, 0]
  }, { phase: 1.9, energy: 0.45 })),
  define('shrug', '어깨 으쓱', 'response', 2.8, false, 'neutral', '양손을 펴고 어깨를 올리며 모르겠다는 몸짓을 한다.', withBase((s, u) => {
    const a = bell(u, 0.08, 0.94)
    addBone(s, 'leftShoulder', 0, 0, deg(11) * a)
    addBone(s, 'rightShoulder', 0, 0, deg(-11) * a)
    arm(s, 'left', [0, deg(-18), deg(-32)], [0, deg(-5), deg(-36)], [0, 0, deg(-12)], a)
    arm(s, 'right', [0, deg(18), deg(32)], [0, deg(5), deg(36)], [0, 0, deg(12)], a)
    handShape(s, 'left', 'open', a)
    handShape(s, 'right', 'open', a)
    addBone(s, 'head', 0, deg(5) * a, deg(5) * a)
  }, { phase: 0.8, energy: 0.7 })),

  // Gestures, routines, and dances.
  define('point-right', '오른손으로 가리키기', 'gesture', 3.3, false, 'neutral', '오른손 검지로 앞쪽을 분명히 가리킨다.', withBase((s, u) => {
    const a = hold(u, 0.16, 0.84)
    arm(s, 'right', [0, deg(82), deg(3)], [0, deg(8), deg(8)], [0, 0, deg(4)], a)
    handShape(s, 'right', 'point', a)
    addBone(s, 'spine', deg(-4) * a, deg(8) * a, 0)
    addBone(s, 'head', 0, deg(12) * a, 0)
    s.look = [0, deg(13) * a, 0]
  }, { phase: 0.5, energy: 0.7 })),
  define('point-left', '왼손으로 가리키기', 'gesture', 3.3, false, 'neutral', '왼손 검지로 앞쪽을 분명히 가리킨다.', withBase((s, u) => {
    const a = hold(u, 0.16, 0.84)
    arm(s, 'left', [0, deg(-82), deg(-3)], [0, deg(-8), deg(-8)], [0, 0, deg(-4)], a)
    handShape(s, 'left', 'point', a)
    addBone(s, 'spine', deg(-4) * a, deg(-8) * a, 0)
    addBone(s, 'head', 0, deg(-12) * a, 0)
    s.look = [0, deg(-13) * a, 0]
  }, { phase: 1.5, energy: 0.7 })),
  define('beckon-right', '이쪽으로 손짓', 'gesture', 3.4, false, 'happy', '오른팔을 내밀고 손목과 손가락으로 세 번 부른다.', withBase((s, u) => {
    const a = hold(u, 0.12, 0.9)
    const w = (0.5 + 0.5 * Math.sin(TAU * 3 * u)) * a
    arm(s, 'right', [0, deg(70), deg(18)], [0, deg(7), deg(26)], [deg(-25) * w, 0, deg(9)], a)
    handShape(s, 'right', w > 0.5 ? 'relaxed' : 'open', a)
    addBone(s, 'spine', deg(-5) * a, deg(7) * a, 0)
  }, { phase: 0.2, energy: 0.85 })),
  define('present-right', '오른쪽 소개', 'gesture', 3.6, false, 'happy', '오른손바닥으로 오른쪽 대상을 소개한다.', withBase((s, u) => {
    const a = hold(u, 0.15, 0.86)
    arm(s, 'right', [0, deg(28), deg(18)], [0, deg(5), deg(28)], [0, deg(-10), deg(14)], a)
    handShape(s, 'right', 'open', a)
    addBone(s, 'spine', 0, deg(9) * a, deg(-3) * a)
    addBone(s, 'head', 0, deg(13) * a, deg(-3) * a)
    s.look = [0, deg(16) * a, 0]
  }, { phase: 0.9, energy: 0.65 })),
  define('present-left', '왼쪽 소개', 'gesture', 3.6, false, 'happy', '왼손바닥으로 왼쪽 대상을 소개한다.', withBase((s, u) => {
    const a = hold(u, 0.15, 0.86)
    arm(s, 'left', [0, deg(-28), deg(-18)], [0, deg(-5), deg(-28)], [0, deg(10), deg(-14)], a)
    handShape(s, 'left', 'open', a)
    addBone(s, 'spine', 0, deg(-9) * a, deg(3) * a)
    addBone(s, 'head', 0, deg(-13) * a, deg(3) * a)
    s.look = [0, deg(-16) * a, 0]
  }, { phase: 1.9, energy: 0.65 })),
  define('explain-calm', '차분한 설명', 'gesture', 6, true, 'neutral', '양손을 번갈아 펴며 천천히 설명한다.', withBase((s, u) => {
    const left = 0.55 + 0.25 * Math.sin(TAU * u)
    const right = 0.55 - 0.25 * Math.sin(TAU * u)
    arm(s, 'left', [0, deg(-32), deg(-43)], [0, deg(-7), deg(-35)], [0, deg(4), deg(-10)], left)
    arm(s, 'right', [0, deg(32), deg(43)], [0, deg(7), deg(35)], [0, deg(-4), deg(10)], right)
    handShape(s, 'left', 'open', left)
    handShape(s, 'right', 'open', right)
    addBone(s, 'head', 0, deg(4) * Math.sin(TAU * u), 0)
  }, { phase: 0.3, energy: 0.8 })),
  define('explain-energetic', '활기찬 설명', 'gesture', 5.2, true, 'happy', '손과 상체가 빠른 교대 박자로 움직인다.', withBase((s, u) => {
    const w = Math.sin(TAU * 2 * u)
    arm(s, 'left', [deg(-5), deg(-46 - 15 * w), deg(-37)], [0, deg(-8), deg(-38 - 10 * w)], [0, deg(8), deg(-10)], 0.9)
    arm(s, 'right', [deg(-5), deg(46 - 15 * w), deg(37)], [0, deg(8), deg(38 - 10 * w)], [0, deg(-8), deg(10)], 0.9)
    handShape(s, 'left', 'open', 0.9)
    handShape(s, 'right', 'open', 0.9)
    addBone(s, 'spine', deg(-4) * Math.abs(w), deg(6) * w, deg(3) * w)
    s.hips[1] += 0.01 * Math.abs(w)
  }, { phase: 1, energy: 1.2 })),
  define('cheer', '만세', 'emotion', 3.2, false, 'happy', '양팔을 높이 들고 몸 전체로 기뻐한다.', withBase((s, u) => {
    const a = bell(u, 0.06, 0.96)
    const bounce = Math.abs(Math.sin(TAU * 2 * u)) * a
    arm(s, 'left', [0, 0, deg(63)], [0, 0, deg(-8)], [0, 0, deg(-4)], a)
    arm(s, 'right', [0, 0, deg(-63)], [0, 0, deg(8)], [0, 0, deg(4)], a)
    handShape(s, 'left', 'fist', a)
    handShape(s, 'right', 'fist', a)
    s.hips[1] += 0.035 * bounce
    addBone(s, 'spine', deg(-8) * a, 0, 0)
    addBone(s, 'head', deg(-8) * a, 0, 0)
  }, { phase: 0.6, energy: 1.3 })),
  // 창 윗변·작업표시줄에 걸터앉기 (Phase 4). 셸이 `sit` 접두사로 골라 쓴다.
  //
  // 걸터앉기의 관건은 **엉덩이 높이가 아니라 무릎 각도**다. WindowSitter 가 좌석
  // 점을 실측해 창을 맞추므로 hips 의 절대 높이는 어차피 상쇄된다. 반대로 무릎이
  // 덜 접히면 창을 뚫고 서 있는 것처럼 보인다. 그래서 고관절 -86°, 무릎 +84° 로
  // 허벅지를 수평에 두고 정강이를 수직으로 떨어뜨린다.
  //
  // 다리를 살짝 벌리고(Z) 좌우 각도를 1~2° 어긋나게 둔 것은 의도적이다 — 완전
  // 대칭인 다리는 마네킹으로 보이고, 정강이가 서로 파고들기도 한다.
  define('sit-edge', '걸터앉아 다리 늘어뜨리기', 'sit', 6.8, true, 'relaxed', '창 가장자리에 앉아 정강이를 수직으로 늘어뜨리고 손으로 모서리를 짚는다.', withBase((s, u) => {
    const sway = Math.sin(TAU * u)
    sitPose(s, 1)
    // 앉으면 골반이 뒤로 눕고 허리가 살짝 말린다. 선 자세의 척추 곡선을 그대로
    // 두면 "공중에 앉은 사람" 이 된다.
    addBone(s, 'hips', deg(6), deg(1.5) * sway, deg(1.2) * sway)
    addBone(s, 'spine', deg(-3), deg(1) * sway, 0)
    addBone(s, 'head', deg(1.5), deg(3) * sway, deg(1.5) * sway)
    // 손으로 모서리를 짚는다. 팔을 몸 뒤쪽으로 조금 보내야 짚은 것처럼 보인다.
    // upperArm 의 X 는 **양수가 뒤쪽**이다 — 부호를 반대로 잡으면 팔이 앞으로
    // 나가 "짚는" 게 아니라 "허공에 손을 뻗은" 자세가 된다. 실측으로 확인했다.
    arm(s, 'left', [deg(12), deg(-8), deg(-80)], [deg(6), deg(-4), deg(-5)], [deg(-16), 0, deg(-4)], 1)
    arm(s, 'right', [deg(12), deg(8), deg(80)], [deg(6), deg(4), deg(5)], [deg(-16), 0, deg(4)], 1)
    handShape(s, 'left', 'open', 0.75)
    handShape(s, 'right', 'open', 0.75)
    s.look = [deg(-3), deg(4) * sway, 0]
  }, { phase: 0.9, energy: 0.5 })),

  define('sit-legs-swing', '걸터앉아 다리 흔들기', 'sit', 5.2, true, 'happy', '앉은 채 두 다리를 반대 위상으로 흔들고 상체가 작게 따라 튄다.', withBase((s, u) => {
    const swing = Math.sin(TAU * u)
    sitPose(s, 1)
    // 좌우 역위상. 같은 위상으로 흔들면 두 다리가 한 덩어리로 보인다.
    addBone(s, 'leftUpperLeg', deg(9) * swing, 0, 0)
    addBone(s, 'leftLowerLeg', deg(-14) * swing, 0, 0)
    addBone(s, 'rightUpperLeg', deg(-9) * swing, 0, 0)
    addBone(s, 'rightLowerLeg', deg(14) * swing, 0, 0)
    // 다리가 앞으로 갈 때 상체가 아주 살짝 뒤로 간다. 반작용이 없으면 다리만
    // 따로 노는 인형처럼 보인다.
    addBone(s, 'hips', deg(5) - deg(1.6) * swing, 0, deg(2) * swing)
    addBone(s, 'spine', deg(-2), 0, deg(-2.5) * swing)
    addBone(s, 'head', deg(1), deg(4) * swing, deg(2) * swing)
    arm(s, 'left', [deg(10), deg(-7), deg(-78)], [deg(5), deg(-4), deg(-6)], [deg(-14), 0, deg(-4)], 1)
    arm(s, 'right', [deg(10), deg(7), deg(78)], [deg(5), deg(4), deg(6)], [deg(-14), 0, deg(4)], 1)
    handShape(s, 'left', 'open', 0.7)
    handShape(s, 'right', 'open', 0.7)
    s.hips[1] += 0.006 * Math.sin(TAU * 2 * u)
    s.look = [deg(-2), deg(5) * swing, 0]
  }, { phase: 0.3, energy: 0.8 })),

  define('sit-lean-back', '걸터앉아 뒤로 기대기', 'sit', 7.4, true, 'relaxed', '뒤로 짚은 두 팔에 체중을 싣고 고개를 살짝 젖힌 채 느리게 호흡한다.', withBase((s, u) => {
    const breath = Math.sin(TAU * u)
    sitPose(s, 1)
    // 뒤로 기대면 골반이 더 눕고 가슴이 열린다.
    addBone(s, 'hips', deg(13), deg(1) * breath, 0)
    addBone(s, 'spine', deg(-7), 0, deg(1.5) * breath)
    addBone(s, 'chest', deg(-5), 0, 0)
    addBone(s, 'head', deg(-6) + deg(1.5) * breath, deg(2.5) * breath, 0)
    // 골반이 뒤로 누운 만큼 허벅지가 같이 끌려 내려간다. 걸터앉은 다리는 모서리에
    // 얹혀 있으므로 상체가 기울어도 수평을 유지해야 한다 — 그만큼 되접어 준다.
    addBone(s, 'leftUpperLeg', deg(-13), 0, 0)
    addBone(s, 'rightUpperLeg', deg(-13), 0, 0)
    // 팔은 몸 **뒤에서** 곧게 뻗어 모서리를 짚는다. 팔꿈치를 거의 펴야 체중이 실린다.
    arm(s, 'left', [deg(36), deg(-12), deg(-84)], [deg(3), deg(-2), deg(-2)], [deg(-24), 0, deg(-3)], 1)
    arm(s, 'right', [deg(36), deg(12), deg(84)], [deg(3), deg(2), deg(2)], [deg(-24), 0, deg(3)], 1)
    handShape(s, 'left', 'spread', 0.85)
    handShape(s, 'right', 'spread', 0.85)
    s.look = [deg(-7), deg(3) * breath, 0]
  }, { phase: 2.4, energy: 0.4 })),

  define('walk', '자연스러운 제자리 걷기', 'locomotion', 1.2, true, 'neutral', '창 이동이 전진을 맡고, 두 발의 접지와 팔·골반의 역위상이 0.6초마다 맞물린다.', withBase((s, u) => {
    const phase = TAU * u
    const sin = Math.sin(phase)
    const cos = Math.cos(phase)
    const leftSwing = Math.max(0, -sin) ** 2
    const rightSwing = Math.max(0, sin) ** 2
    const leftStance = Math.max(0, sin) ** 2
    const rightStance = Math.max(0, -sin) ** 2

    // 전진 translation은 BrowserWindow가 담당한다. hips에는 보행의 상하·좌우 무게 이동만 둔다.
    s.hips = [0.018 * sin, REST_HIPS_Y + 0.014 * sin * sin, 0.004 * cos]
    setBone(s, 'hips', deg(2), deg(-4) * cos, deg(3) * sin)
    setBone(s, 'spine', deg(4), deg(5) * cos, deg(-2) * sin)
    setBone(s, 'chest', deg(-1), deg(-3) * cos, deg(-1) * sin)
    setBone(s, 'neck', deg(-1), deg(-1.5) * cos, deg(0.8) * sin)
    setBone(s, 'head', deg(-1), deg(-1.5) * cos, deg(-1) * sin)

    setBone(s, 'leftUpperLeg', deg(-1) - deg(22) * cos, 0, deg(-1.5))
    setBone(s, 'rightUpperLeg', deg(-1) + deg(22) * cos, 0, deg(1.5))
    setBone(s, 'leftLowerLeg', deg(2.5) + deg(42) * leftSwing + deg(5) * leftStance, 0, 0)
    setBone(s, 'rightLowerLeg', deg(2.5) + deg(42) * rightSwing + deg(5) * rightStance, 0, 0)
    setBone(s, 'leftFoot', deg(-2) - deg(9) * cos - deg(14) * leftSwing, 0, 0)
    setBone(s, 'rightFoot', deg(-2) + deg(9) * cos - deg(14) * rightSwing, 0, 0)
    setBone(s, 'leftToes', -deg(11) * Math.max(0, -cos) ** 2, 0, 0)
    setBone(s, 'rightToes', -deg(11) * Math.max(0, cos) ** 2, 0, 0)

    setBone(s, 'leftShoulder', 0, 0, deg(-2))
    setBone(s, 'rightShoulder', 0, 0, deg(2))
    setBone(s, 'leftUpperArm', deg(3), deg(14) * cos, deg(-72))
    setBone(s, 'rightUpperArm', deg(3), deg(14) * cos, deg(72))
    setBone(s, 'leftLowerArm', deg(-2), deg(-7), deg(-8))
    setBone(s, 'rightLowerArm', deg(-2), deg(7), deg(8))
    handShape(s, 'left', 'relaxed')
    handShape(s, 'right', 'relaxed')
    s.look = [0, 0, 0]
  }, { phase: 0, energy: 0 })),
  define('happy-bounce', '통통 튀는 기쁨', 'emotion', 4.2, true, 'happy', '발뒤꿈치와 어깨가 번갈아 통통 튄다.', withBase((s, u) => {
    const b = Math.max(0, Math.sin(TAU * 2 * u)) ** 2
    s.hips[1] += 0.025 * b
    addBone(s, 'leftLowerLeg', deg(7) * b, 0, 0)
    addBone(s, 'rightLowerLeg', deg(7) * b, 0, 0)
    addBone(s, 'leftShoulder', 0, 0, deg(-4) * b)
    addBone(s, 'rightShoulder', 0, 0, deg(4) * b)
    addBone(s, 'head', deg(-3) * b, 0, 0)
  }, { phase: 0.1, energy: 1.15 })),
  define('laugh', '크게 웃기', 'emotion', 4.4, false, 'happy', '상체를 뒤로 젖혔다 앞으로 오며 어깨가 웃음 박자를 탄다.', withBase((s, u) => {
    const a = hold(u, 0.12, 0.9)
    const pulse = Math.max(0, Math.sin(TAU * 3 * u)) ** 2 * a
    addBone(s, 'spine', deg(-9) * a + deg(7) * pulse, 0, 0)
    addBone(s, 'chest', deg(-8) * a + deg(6) * pulse, 0, 0)
    addBone(s, 'head', deg(-12) * a + deg(8) * pulse, 0, deg(3) * Math.sin(TAU * u) * a)
    s.hips[1] -= 0.012 * pulse
  }, { phase: 1.3, energy: 1.1 })),
  define('giggle', '작게 키득거리기', 'emotion', 3.8, false, 'happy', '한 손을 입가에 두고 어깨가 작게 들썩인다.', withBase((s, u) => {
    const a = hold(u, 0.14, 0.88)
    const p = Math.max(0, Math.sin(TAU * 3 * u)) ** 2 * a
    arm(s, 'right', [deg(-5), deg(42), deg(48)], [deg(-10), deg(7), deg(77)], [deg(-12), 0, deg(12)], a)
    handShape(s, 'right', 'open', a)
    addBone(s, 'head', deg(5) * a + deg(3) * p, deg(-8) * a, deg(6) * a)
    addBone(s, 'rightShoulder', 0, 0, deg(-5) * p)
    s.hips[1] -= 0.006 * p
  }, { phase: 1.9, energy: 0.7 })),
  define('yawn', '하품', 'routine', 5.2, false, 'relaxed', '한 손으로 입을 가리고 몸을 길게 늘인다.', withBase((s, u) => {
    const a = bell(u, 0.08, 0.95)
    arm(s, 'right', [deg(-6), deg(45), deg(50)], [deg(-10), deg(8), deg(78)], [deg(-12), 0, deg(10)], a)
    handShape(s, 'right', 'open', a)
    addBone(s, 'spine', deg(-8) * a, 0, 0)
    addBone(s, 'head', deg(-14) * a, 0, deg(3) * Math.sin(TAU * u) * a)
    addBone(s, 'leftShoulder', 0, 0, deg(-6) * a)
    s.hips[1] += 0.012 * a
  }, { phase: 2.1, energy: 0.35 })),
  define('stretch', '기지개', 'routine', 5, false, 'relaxed', '깍지 낀 듯 두 팔을 위로 뻗고 허리를 편다.', withBase((s, u) => {
    const a = bell(u, 0.06, 0.96)
    arm(s, 'left', [deg(-4), 0, deg(70)], [0, 0, deg(-8)], [0, 0, deg(-5)], a)
    arm(s, 'right', [deg(-4), 0, deg(-70)], [0, 0, deg(8)], [0, 0, deg(5)], a)
    handShape(s, 'left', 'open', a)
    handShape(s, 'right', 'open', a)
    addBone(s, 'spine', deg(-10) * a, 0, 0)
    addBone(s, 'chest', deg(-8) * a, 0, 0)
    addBone(s, 'head', deg(-10) * a, 0, 0)
    s.hips[1] += 0.035 * a
  }, { phase: 0.4, energy: 0.5 })),
  define('wake-up', '잠에서 깨기', 'routine', 6, false, 'relaxed', '꾸벅인 자세에서 기지개를 켜고 정신을 차린다.', withBase((s, u) => {
    const sleepy = bell(u, 0, 0.45)
    const stretch = bell(u, 0.28, 0.9)
    addBone(s, 'spine', deg(13) * sleepy - deg(8) * stretch, 0, 0)
    addBone(s, 'head', deg(20) * sleepy - deg(10) * stretch, 0, deg(3) * sleepy)
    arm(s, 'left', [0, 0, deg(62)], [0, 0, deg(-7)], [0, 0, 0], stretch)
    arm(s, 'right', [0, 0, deg(-62)], [0, 0, deg(7)], [0, 0, 0], stretch)
    handShape(s, 'left', 'fist', stretch * 0.7)
    handShape(s, 'right', 'fist', stretch * 0.7)
    s.hips[1] -= 0.025 * sleepy
  }, { phase: 2.5, energy: 0.4 })),
  define('dance-sway', '리듬 타는 스웨이', 'dance', 6.4, true, 'happy', '골반·가슴·팔이 반대 위상으로 부드럽게 춤춘다.', withBase((s, u) => {
    const w = Math.sin(TAU * 2 * u)
    s.hips[0] += 0.035 * w
    addBone(s, 'hips', 0, deg(7) * w, deg(8) * w)
    addBone(s, 'spine', 0, deg(-6) * w, deg(-10) * w)
    addBone(s, 'head', 0, deg(5) * w, deg(6) * w)
    addBone(s, 'leftUpperArm', deg(-6) * w, 0, deg(13) * w)
    addBone(s, 'rightUpperArm', deg(6) * w, 0, deg(13) * w)
  }, { phase: 0.5, energy: 1.2 })),
  define('dance-bounce', '바운스 댄스', 'dance', 5.6, true, 'happy', '무릎 바운스와 교차 팔 동작이 반복된다.', withBase((s, u) => {
    const b = Math.max(0, Math.sin(TAU * 2 * u)) ** 2
    const w = Math.sin(TAU * u)
    s.hips[1] -= 0.045 * b
    addBone(s, 'leftUpperLeg', deg(-12) * b, 0, 0)
    addBone(s, 'rightUpperLeg', deg(-12) * b, 0, 0)
    addBone(s, 'leftLowerLeg', deg(24) * b, 0, 0)
    addBone(s, 'rightLowerLeg', deg(24) * b, 0, 0)
    addBone(s, 'leftUpperArm', 0, deg(-18) * w, deg(18) * w)
    addBone(s, 'rightUpperArm', 0, deg(-18) * w, deg(18) * w)
  }, { phase: 1, energy: 1.25 })),

  // Interactive drag poses. Runtime pins the named grip bone to the cursor.
  define('mouse-tether-right', '마우스 매달림·오른손', 'interactive', 4.8, true, 'neutral', '오른손으로 커서를 붙잡고 몸과 다리가 관성에 따라 떠다닌다.', withBase((s, u) => {
    const float = Math.sin(TAU * u)
    arm(s, 'right', [deg(2), deg(1), deg(-88)], [deg(3), 0, deg(-2)], [0, 0, deg(2)], 1)
    handShape(s, 'right', 'fist', 1)
    arm(s, 'left', [deg(9), deg(-10), deg(-58)], [deg(-5), deg(-8), deg(-18)], [0, 0, deg(-6)], 0.9)
    legCurl(s, 'left', 0.72 + 0.08 * float, 0.85)
    legCurl(s, 'right', 0.88 - 0.08 * float, 1)
    addBone(s, 'hips', deg(-10), deg(-3) * float, deg(-7))
    addBone(s, 'spine', deg(7), deg(3) * float, deg(10))
    addBone(s, 'head', deg(3), deg(-8), deg(-9))
    s.hips[1] -= 0.12 + 0.008 * float
    s.hips[0] += 0.018
    s.look = [deg(-8), deg(-12), 0]
  }, { phase: 0.4, energy: 0.25 })),
  define('mouse-tether-left', '마우스 매달림·왼손', 'interactive', 4.8, true, 'neutral', '왼손으로 커서를 붙잡고 몸과 다리가 관성에 따라 떠다닌다.', withBase((s, u) => {
    const float = Math.sin(TAU * u)
    arm(s, 'left', [deg(2), deg(-1), deg(88)], [deg(3), 0, deg(2)], [0, 0, deg(-2)], 1)
    handShape(s, 'left', 'fist', 1)
    arm(s, 'right', [deg(9), deg(10), deg(58)], [deg(-5), deg(8), deg(18)], [0, 0, deg(6)], 0.9)
    legCurl(s, 'left', 0.88 - 0.08 * float, 1)
    legCurl(s, 'right', 0.72 + 0.08 * float, 0.85)
    addBone(s, 'hips', deg(-10), deg(3) * float, deg(7))
    addBone(s, 'spine', deg(7), deg(-3) * float, deg(-10))
    addBone(s, 'head', deg(3), deg(8), deg(9))
    s.hips[1] -= 0.12 + 0.008 * float
    s.hips[0] -= 0.018
    s.look = [deg(-8), deg(12), 0]
  }, { phase: 1.4, energy: 0.25 })),
  define('mouse-tether-both', '마우스 매달림·양손', 'interactive', 5.2, true, 'neutral', '두 손으로 커서를 붙잡고 무릎을 접은 채 아래에서 흔들린다.', withBase((s, u) => {
    const float = Math.sin(TAU * u)
    arm(s, 'left', [deg(2), deg(-2), deg(82)], [deg(2), 0, deg(-8)], [0, 0, deg(-2)], 1)
    arm(s, 'right', [deg(2), deg(2), deg(-82)], [deg(2), 0, deg(8)], [0, 0, deg(2)], 1)
    handShape(s, 'left', 'fist', 1)
    handShape(s, 'right', 'fist', 1)
    legCurl(s, 'left', 0.88 + 0.06 * float, 1)
    legCurl(s, 'right', 0.88 - 0.06 * float, 1)
    addBone(s, 'hips', deg(-12), 0, deg(3) * float)
    addBone(s, 'spine', deg(9), 0, deg(-4) * float)
    addBone(s, 'head', deg(4), deg(4) * float, deg(3) * float)
    s.hips[1] -= 0.14 + 0.01 * Math.cos(TAU * u)
    s.look = [deg(-9), deg(5) * float, 0]
  }, { phase: 0.9, energy: 0.2 })),
  define('mouse-tether-float-curl', '마우스 매달림·웅크린 부유', 'interactive', 5.6, true, 'relaxed', '한 손에 매달려 몸을 작게 웅크리고 공중에서 천천히 돈다.', withBase((s, u) => {
    const float = Math.sin(TAU * u)
    arm(s, 'right', [deg(2), deg(2), deg(-90)], [deg(3), 0, deg(-3)], [0, 0, deg(2)], 1)
    handShape(s, 'right', 'fist', 1)
    arm(s, 'left', [deg(-10), deg(-48), deg(-38)], [deg(-18), deg(-12), deg(-68)], [deg(-8), 0, deg(-12)], 0.95)
    handShape(s, 'left', 'relaxed', 1)
    legCurl(s, 'left', 0.98, 1.15)
    legCurl(s, 'right', 0.98, 1.08)
    addBone(s, 'hips', deg(-18), deg(8) * float, deg(-8))
    addBone(s, 'spine', deg(15), deg(-7) * float, deg(11))
    addBone(s, 'head', deg(8), deg(-10) + deg(6) * float, deg(-10))
    s.hips[1] -= 0.17 + 0.012 * Math.sin(TAU * u)
    s.hips[2] -= 0.025
    s.look = [deg(2), deg(-10) + deg(6) * float, 0]
  }, { phase: 1.8, energy: 0.18 }))
]

function createNodes() {
  const nodes = BONE_DEFS.map(([name, _parent, translation]) => ({ name: `VRMA_${name}`, translation }))
  for (let index = 0; index < BONE_DEFS.length; index += 1) {
    const parentName = BONE_DEFS[index][1]
    if (parentName == null) continue
    const parentIndex = BONE_INDEX.get(parentName)
    nodes[parentIndex].children ??= []
    nodes[parentIndex].children.push(index)
  }

  const lookAtIndex = nodes.length
  nodes.push({ name: 'VRMA_LookAt' })
  nodes[BONE_INDEX.get('hips')].children ??= []
  nodes[BONE_INDEX.get('hips')].children.push(lookAtIndex)
  return { nodes, lookAtIndex }
}

function appendFloatAccessor(gltf, binaryParts, floatArray, type, includeRange = false) {
  const buffer = Buffer.from(floatArray.buffer, floatArray.byteOffset, floatArray.byteLength)
  const byteOffset = binaryParts.reduce((sum, part) => sum + part.length, 0)
  const bufferView = gltf.bufferViews.length
  gltf.bufferViews.push({ buffer: 0, byteOffset, byteLength: buffer.length })
  binaryParts.push(buffer)

  const accessor = gltf.accessors.length
  const itemSize = type === 'SCALAR' ? 1 : type === 'VEC3' ? 3 : 4
  const definition = {
    bufferView,
    componentType: 5126,
    count: floatArray.length / itemSize,
    type
  }
  if (includeRange) {
    definition.min = [floatArray[0]]
    definition.max = [floatArray[floatArray.length - 1]]
  }
  gltf.accessors.push(definition)
  return accessor
}

function quaternionValues(samples, boneName) {
  const values = new Float32Array(samples.length * 4)
  const euler = new Euler(0, 0, 0, 'XYZ')
  const quaternion = new Quaternion()
  const previous = new Quaternion()
  let hasPrevious = false
  for (let i = 0; i < samples.length; i += 1) {
    const angles = samples[i].pose[boneName] ?? [0, 0, 0]
    euler.set(angles[0], angles[1], angles[2], 'XYZ')
    quaternion.setFromEuler(euler).normalize()
    if (hasPrevious && quaternion.dot(previous) < 0) {
      quaternion.set(-quaternion.x, -quaternion.y, -quaternion.z, -quaternion.w)
    }
    values.set([quaternion.x, quaternion.y, quaternion.z, quaternion.w], i * 4)
    previous.copy(quaternion)
    hasPrevious = true
  }
  return values
}

function lookAtValues(samples) {
  const values = new Float32Array(samples.length * 4)
  const euler = new Euler(0, 0, 0, 'YXZ')
  const quaternion = new Quaternion()
  const previous = new Quaternion()
  let hasPrevious = false
  for (let i = 0; i < samples.length; i += 1) {
    const [pitch, yaw, roll] = samples[i].look
    euler.set(pitch, yaw, roll, 'YXZ')
    quaternion.setFromEuler(euler).normalize()
    if (hasPrevious && quaternion.dot(previous) < 0) {
      quaternion.set(-quaternion.x, -quaternion.y, -quaternion.z, -quaternion.w)
    }
    values.set([quaternion.x, quaternion.y, quaternion.z, quaternion.w], i * 4)
    previous.copy(quaternion)
    hasPrevious = true
  }
  return values
}

function makeGlb(motion) {
  const frameIntervals = Math.round(motion.duration * FPS)
  const duration = frameIntervals / FPS
  const frameCount = frameIntervals + 1
  const times = new Float32Array(frameCount)
  const samples = []
  for (let frame = 0; frame < frameCount; frame += 1) {
    const time = frame / FPS
    const u = frame / frameIntervals
    times[frame] = time
    samples.push(motion.sample(u, time))
  }

  const { nodes, lookAtIndex } = createNodes()
  const humanBones = Object.fromEntries(BONE_NAMES.map((name) => [name, { node: BONE_INDEX.get(name) }]))
  const gltf = {
    asset: { version: '2.0', generator: 'waifu-agent-vrma-generator/1.0.0' },
    scene: 0,
    scenes: [{ nodes: [BONE_INDEX.get('hips')] }],
    nodes,
    buffers: [{ byteLength: 0 }],
    bufferViews: [],
    accessors: [],
    animations: [{ name: motion.name, samplers: [], channels: [] }],
    extensionsUsed: ['VRMC_vrm_animation'],
    extensions: {
      VRMC_vrm_animation: {
        specVersion: '1.0',
        humanoid: { humanBones },
        lookAt: { node: lookAtIndex }
      }
    },
    extras: {
      waifuAgent: {
        loop: motion.loop,
        category: motion.category,
        recommendedExpression: motion.expression
      }
    }
  }
  const binaryParts = []
  const timeAccessor = appendFloatAccessor(gltf, binaryParts, times, 'SCALAR', true)
  const animation = gltf.animations[0]

  const hipsValues = new Float32Array(frameCount * 3)
  for (let i = 0; i < frameCount; i += 1) hipsValues.set(samples[i].hips, i * 3)
  const hipsAccessor = appendFloatAccessor(gltf, binaryParts, hipsValues, 'VEC3')
  animation.samplers.push({ input: timeAccessor, output: hipsAccessor, interpolation: 'LINEAR' })
  animation.channels.push({ sampler: animation.samplers.length - 1, target: { node: BONE_INDEX.get('hips'), path: 'translation' } })

  for (const boneName of BONE_NAMES) {
    const output = appendFloatAccessor(gltf, binaryParts, quaternionValues(samples, boneName), 'VEC4')
    animation.samplers.push({ input: timeAccessor, output, interpolation: 'LINEAR' })
    animation.channels.push({ sampler: animation.samplers.length - 1, target: { node: BONE_INDEX.get(boneName), path: 'rotation' } })
  }

  const lookAccessor = appendFloatAccessor(gltf, binaryParts, lookAtValues(samples), 'VEC4')
  animation.samplers.push({ input: timeAccessor, output: lookAccessor, interpolation: 'LINEAR' })
  animation.channels.push({ sampler: animation.samplers.length - 1, target: { node: lookAtIndex, path: 'rotation' } })

  const binary = Buffer.concat(binaryParts)
  gltf.buffers[0].byteLength = binary.length
  const json = Buffer.from(JSON.stringify(gltf), 'utf8')
  const jsonPadding = (4 - (json.length % 4)) % 4
  const binPadding = (4 - (binary.length % 4)) % 4
  const paddedJson = Buffer.concat([json, Buffer.alloc(jsonPadding, 0x20)])
  const paddedBinary = Buffer.concat([binary, Buffer.alloc(binPadding)])
  const totalLength = 12 + 8 + paddedJson.length + 8 + paddedBinary.length
  const glb = Buffer.alloc(totalLength)
  glb.write('glTF', 0, 4, 'ascii')
  glb.writeUInt32LE(2, 4)
  glb.writeUInt32LE(totalLength, 8)
  glb.writeUInt32LE(paddedJson.length, 12)
  glb.writeUInt32LE(GLB_JSON_CHUNK, 16)
  paddedJson.copy(glb, 20)
  const binHeader = 20 + paddedJson.length
  glb.writeUInt32LE(paddedBinary.length, binHeader)
  glb.writeUInt32LE(GLB_BIN_CHUNK, binHeader + 4)
  paddedBinary.copy(glb, binHeader + 8)
  return { glb, duration, frameCount }
}

async function main() {
  const outputFlag = process.argv.indexOf('--output')
  const outputDir = resolve(outputFlag >= 0 ? process.argv[outputFlag + 1] : 'resources/motions')
  if (new Set(MOTIONS.map((motion) => motion.name)).size !== MOTIONS.length) {
    throw new Error('Motion names must be unique')
  }
  if (MOTIONS.length < 40) throw new Error(`Expected at least 40 motions, got ${MOTIONS.length}`)
  for (const required of REQUIRED_BONES) {
    if (!BONE_INDEX.has(required)) throw new Error(`Missing required humanoid bone: ${required}`)
  }

  await mkdir(outputDir, { recursive: true })
  const files = []
  for (const motion of MOTIONS) {
    const { glb, duration, frameCount } = makeGlb(motion)
    const filename = `${motion.name}.vrma`
    await writeFile(resolve(outputDir, filename), glb)
    files.push({
      name: motion.name,
      title: motion.title,
      filename,
      category: motion.category,
      duration,
      frameCount,
      fps: FPS,
      loop: motion.loop,
      recommendedExpression: motion.expression,
      description: motion.description,
      ...(motion.category === 'interactive'
        ? { interactive: { cursorAnchorBone: motion.name === 'mouse-tether-left' ? 'leftMiddleDistal' : 'rightMiddleDistal' } }
        : {}),
      bytes: glb.length,
      sha256: createHash('sha256').update(glb).digest('hex')
    })
  }

  const manifest = {
    schemaVersion: 1,
    format: 'VRMC_vrm_animation 1.0 in GLB 2.0',
    generator: 'scripts/generate-vrma-library.mjs',
    count: files.length,
    fps: FPS,
    humanoidBoneCount: BONE_NAMES.length,
    provenance: {
      authored: 'Original procedural keyframes generated for waifu-agent.',
      referenceThemes: 'Angry, Blush, Clapping, Goodbye, Jump, LookAround, Relax, Sad, Sleepy, Surprised, Thinking.',
      referenceRepository: 'https://github.com/tk256ailab/vrm-viewer/tree/main/VRMA',
      copiedReferenceBytes: false
    },
    files
  }
  await writeFile(resolve(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  process.stdout.write(`Generated ${files.length} VRMA files in ${outputDir}\n`)
  process.stdout.write(`Interactive drag motions: ${files.filter((file) => file.category === 'interactive').map((file) => file.name).join(', ')}\n`)
}

await main()
