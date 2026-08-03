#!/usr/bin/env node
/**
 * VRMA 를 실제 VRM 에 리타게팅해서 **관절이 어디로 갔는지 숫자로** 확인한다.
 *
 * `verify-vrma-library.mjs` 는 파싱과 트랙 수만 본다. 그건 파일이 깨지지 않았다는
 * 증거일 뿐 자세가 맞다는 증거가 아니다 — 허벅지를 90도 반대로 접어도 트랙 수는
 * 똑같이 53개다. 실제로 앱을 띄워 눈으로 보는 것이 최종 검증이지만, 그 전에
 * "정강이가 수직인가" 정도는 기계가 답할 수 있어야 한다.
 *
 * 각 관절의 방향을 각도로 찍고, 옆에서 본 뼈대를 문자 격자로 그린다.
 *
 * 사용:
 *   node scripts/inspect-vrma-pose.mjs sit-edge sit-legs-swing --phases 0,0.25,0.5
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { AnimationMixer, Vector3 } from 'three'
import { VRMLoaderPlugin } from '@pixiv/three-vrm'
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

const DEFAULT_TARGET = 'resources/models/AvatarSample_A.vrm'
const MOTION_DIR = 'resources/motions'

/** 옆에서 봤을 때 각도를 읽고 싶은 뼈 쌍. */
const SEGMENTS = [
  ['허벅지(좌)', 'leftUpperLeg', 'leftLowerLeg'],
  ['정강이(좌)', 'leftLowerLeg', 'leftFoot'],
  ['허벅지(우)', 'rightUpperLeg', 'rightLowerLeg'],
  ['정강이(우)', 'rightLowerLeg', 'rightFoot'],
  ['척추', 'hips', 'head'],
  ['윗팔(좌)', 'leftUpperArm', 'leftLowerArm'],
  ['아랫팔(좌)', 'leftLowerArm', 'leftHand'],
  ['윗팔(우)', 'rightUpperArm', 'rightLowerArm'],
  ['아랫팔(우)', 'rightLowerArm', 'rightHand'],
]

/** 문자 격자에 찍을 뼈대. */
const SKELETON = [
  ['head', 'neck'], ['neck', 'chest'], ['chest', 'spine'], ['spine', 'hips'],
  ['hips', 'leftUpperLeg'], ['leftUpperLeg', 'leftLowerLeg'], ['leftLowerLeg', 'leftFoot'],
  ['hips', 'rightUpperLeg'], ['rightUpperLeg', 'rightLowerLeg'], ['rightLowerLeg', 'rightFoot'],
  ['chest', 'leftUpperArm'], ['leftUpperArm', 'leftLowerArm'], ['leftLowerArm', 'leftHand'],
  ['chest', 'rightUpperArm'], ['rightUpperArm', 'rightLowerArm'], ['rightLowerArm', 'rightHand'],
]

function shimBrowserGlobals() {
  globalThis.self ??= globalThis
  globalThis.ProgressEvent ??= class ProgressEvent {
    constructor(type, init = {}) {
      this.type = type
      Object.assign(this, init)
    }
  }
  globalThis.createImageBitmap ??= async () => ({ width: 1, height: 1, close() {} })
}

const exactArrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)

async function loadVrm(path) {
  const loader = new GLTFLoader()
  loader.register((parser) => new VRMLoaderPlugin(parser))
  const gltf = await loader.parseAsync(exactArrayBuffer(await readFile(path)), '')
  if (gltf.userData.vrm == null) throw new Error(`${path}: VRM 으로 읽히지 않는다`)
  return gltf.userData.vrm
}

async function loadVrma(path) {
  const loader = new GLTFLoader()
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser))
  const gltf = await loader.parseAsync(exactArrayBuffer(await readFile(path)), '')
  const animation = gltf.userData.vrmAnimations?.[0]
  if (animation == null) throw new Error(`${path}: VRMA 애니메이션이 없다`)
  return animation
}

/**
 * 두 뼈를 잇는 선분이 아래(-Y)를 기준으로 얼마나 돌아갔나.
 *
 * 0° 는 곧게 아래로, +90° 는 앞(+Z), -90° 는 뒤(-Z), 180° 는 위다. 서 있는
 * 다리가 0° 근처, 걸터앉은 허벅지가 +90° 근처여야 한다.
 */
function pitchFromDown(from, to) {
  const dz = to.z - from.z
  const dy = to.y - from.y
  return (Math.atan2(dz, -dy) * 180) / Math.PI
}

function bonePositions(vrm) {
  const positions = new Map()
  for (const [, ...pair] of SEGMENTS) {
    for (const bone of pair) positions.set(bone, null)
  }
  for (const pair of SKELETON) {
    for (const bone of pair) positions.set(bone, null)
  }
  for (const bone of positions.keys()) {
    const node = vrm.humanoid.getNormalizedBoneNode(bone) ?? vrm.humanoid.getRawBoneNode(bone)
    if (node == null) continue
    const world = new Vector3()
    node.getWorldPosition(world)
    positions.set(bone, world)
  }
  return positions
}

/** 옆에서 본 뼈대를 문자로 찍는다. 가로는 +Z(앞), 세로는 Y(위). */
function sideView(positions, width = 46, height = 22) {
  const points = [...positions.values()].filter(Boolean)
  if (points.length === 0) return ''

  const zs = points.map((p) => p.z)
  const ys = points.map((p) => p.y)
  const zMin = Math.min(...zs)
  const zMax = Math.max(...zs)
  const yMin = Math.min(...ys)
  const yMax = Math.max(...ys)
  // 종횡비를 유지한다. 축마다 따로 늘리면 수직인 정강이가 기울어 보인다.
  const span = Math.max(zMax - zMin, yMax - yMin, 1e-4)
  const zCenter = (zMin + zMax) / 2
  const yCenter = (yMin + yMax) / 2

  const grid = Array.from({ length: height }, () => Array(width).fill(' '))
  // 문자 칸은 세로가 대략 2배 길어서, 그대로 찍으면 사람이 납작해진다.
  const toCol = (z) => Math.round((width - 1) * (0.5 + (z - zCenter) / (span * 1.2)))
  const toRow = (y) => Math.round((height - 1) * (0.5 - (y - yCenter) / (span * 1.1)))

  const plot = (col, row, char) => {
    if (col < 0 || col >= width || row < 0 || row >= height) return
    grid[row][col] = char
  }

  for (const [a, b] of SKELETON) {
    const pa = positions.get(a)
    const pb = positions.get(b)
    if (!pa || !pb) continue
    const steps = 24
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps
      plot(toCol(pa.z + (pb.z - pa.z) * t), toRow(pa.y + (pb.y - pa.y) * t), '·')
    }
  }
  for (const [name, position] of positions) {
    if (!position) continue
    plot(toCol(position.z), toRow(position.y), name === 'head' ? 'O' : '+')
  }

  return grid.map((row) => row.join('').replace(/\s+$/, '')).join('\n')
}

async function main() {
  shimBrowserGlobals()

  const args = process.argv.slice(2)
  const phaseFlag = args.indexOf('--phases')
  const targetFlag = args.indexOf('--target')
  const phases = phaseFlag >= 0 ? args[phaseFlag + 1].split(',').map(Number) : [0, 0.5]
  const targetPath = resolve(targetFlag >= 0 ? args[targetFlag + 1] : DEFAULT_TARGET)
  const names = args.filter((arg, index) => {
    if (arg.startsWith('--')) return false
    if (index > 0 && (args[index - 1] === '--phases' || args[index - 1] === '--target')) return false
    return true
  })
  if (names.length === 0) throw new Error('모션 이름을 하나 이상 달라 (예: sit-edge)')

  const vrm = await loadVrm(targetPath)

  for (const name of names) {
    const animation = await loadVrma(resolve(MOTION_DIR, `${name}.vrma`))
    const clip = createVRMAnimationClip(animation, vrm)
    const mixer = new AnimationMixer(vrm.scene)

    for (const phase of phases) {
      // 매 위상마다 믹서를 새로 만든다. 같은 믹서를 되감으면 이전 상태가 남는다.
      mixer.stopAllAction()
      const action = mixer.clipAction(clip)
      action.reset().play()
      mixer.setTime(clip.duration * phase)
      vrm.humanoid.update()
      vrm.scene.updateMatrixWorld(true)

      const positions = bonePositions(vrm)
      process.stdout.write(`\n=== ${name}  위상 ${phase.toFixed(2)} (${(clip.duration * phase).toFixed(2)}s / ${clip.duration.toFixed(2)}s)\n`)
      for (const [label, from, to] of SEGMENTS) {
        const a = positions.get(from)
        const b = positions.get(to)
        if (!a || !b) continue
        process.stdout.write(`  ${label.padEnd(12)} ${pitchFromDown(a, b).toFixed(1).padStart(7)}°\n`)
      }
      process.stdout.write(`${sideView(positions)}\n`)
    }
  }
}

await main()
