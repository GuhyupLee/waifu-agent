import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { VRMLoaderPlugin } from '@pixiv/three-vrm'
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

const GLB_JSON_CHUNK = 0x4e4f534a
const GLB_BIN_CHUNK = 0x004e4942
const REQUIRED_BONES = [
  'hips', 'spine', 'head',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
  'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightUpperArm', 'rightLowerArm', 'rightHand'
]

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function exactArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

function parseGlb(bytes, filename) {
  assert(bytes.length >= 20, `${filename}: too small for GLB`)
  assert(bytes.toString('ascii', 0, 4) === 'glTF', `${filename}: invalid GLB magic`)
  assert(bytes.readUInt32LE(4) === 2, `${filename}: GLB version is not 2`)
  assert(bytes.readUInt32LE(8) === bytes.length, `${filename}: declared GLB length differs from file length`)

  let offset = 12
  let json = null
  let binary = null
  while (offset < bytes.length) {
    assert(offset + 8 <= bytes.length, `${filename}: truncated chunk header`)
    const length = bytes.readUInt32LE(offset)
    const type = bytes.readUInt32LE(offset + 4)
    offset += 8
    assert(offset + length <= bytes.length, `${filename}: chunk exceeds file bounds`)
    const chunk = bytes.subarray(offset, offset + length)
    if (type === GLB_JSON_CHUNK) json = JSON.parse(chunk.toString('utf8').trim())
    if (type === GLB_BIN_CHUNK) binary = chunk
    offset += length
  }
  assert(json != null, `${filename}: JSON chunk missing`)
  assert(binary != null, `${filename}: BIN chunk missing`)
  return { json, binary }
}

function readAccessor(gltf, binary, accessorIndex, filename) {
  const accessor = gltf.accessors?.[accessorIndex]
  assert(accessor != null, `${filename}: accessor ${accessorIndex} missing`)
  assert(accessor.componentType === 5126, `${filename}: accessor ${accessorIndex} is not Float32`)
  assert(accessor.sparse == null, `${filename}: sparse accessors are not expected`)
  const itemSize = { SCALAR: 1, VEC3: 3, VEC4: 4 }[accessor.type]
  assert(itemSize != null, `${filename}: unsupported accessor type ${accessor.type}`)
  const view = gltf.bufferViews?.[accessor.bufferView]
  assert(view != null, `${filename}: accessor ${accessorIndex} bufferView missing`)
  const byteOffset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
  const byteLength = accessor.count * itemSize * 4
  assert(byteOffset % 4 === 0, `${filename}: accessor ${accessorIndex} is not four-byte aligned`)
  assert(byteOffset + byteLength <= binary.length, `${filename}: accessor ${accessorIndex} exceeds BIN bounds`)
  return new Float32Array(binary.buffer, binary.byteOffset + byteOffset, accessor.count * itemSize)
}

function maxDifference(first, last) {
  let max = 0
  for (let index = 0; index < first.length; index += 1) max = Math.max(max, Math.abs(first[index] - last[index]))
  return max
}

function verifyStructure(filename, bytes, manifestEntry) {
  const { json, binary } = parseGlb(bytes, filename)
  const extension = json.extensions?.VRMC_vrm_animation
  assert(json.asset?.version === '2.0', `${filename}: asset.version must be 2.0`)
  assert(json.extensionsUsed?.includes('VRMC_vrm_animation'), `${filename}: extensionsUsed is missing VRMC_vrm_animation`)
  assert(extension?.specVersion === '1.0', `${filename}: VRMA specVersion must be 1.0`)
  assert(json.scenes?.[json.scene ?? 0] != null, `${filename}: default scene missing`)
  assert(json.buffers?.length === 1, `${filename}: expected one buffer`)
  assert(json.buffers[0].byteLength <= binary.length, `${filename}: declared BIN buffer exceeds chunk`)

  const humanBones = extension.humanoid?.humanBones
  assert(humanBones != null, `${filename}: humanoid humanBones missing`)
  for (const bone of REQUIRED_BONES) assert(humanBones[bone]?.node != null, `${filename}: required bone ${bone} missing`)
  assert(humanBones.leftEye == null && humanBones.rightEye == null, `${filename}: eye bones must use lookAt, not humanoid tracks`)
  assert(extension.lookAt?.node != null, `${filename}: lookAt node missing`)

  assert(json.animations?.length === 1, `${filename}: expected exactly one glTF animation`)
  const animation = json.animations[0]
  assert(animation.channels.length === animation.samplers.length, `${filename}: channel/sampler count mismatch`)
  assert(animation.channels.length >= 53, `${filename}: expected hips + 51 rotations + lookAt`)

  let hipsTranslations = 0
  let lookAtRotations = 0
  let duration = 0
  const nodeToBone = new Map(Object.entries(humanBones).map(([name, value]) => [value.node, name]))
  for (let channelIndex = 0; channelIndex < animation.channels.length; channelIndex += 1) {
    const channel = animation.channels[channelIndex]
    const sampler = animation.samplers[channel.sampler]
    assert(sampler != null, `${filename}: sampler ${channel.sampler} missing`)
    assert(sampler.interpolation === 'LINEAR', `${filename}: only LINEAR interpolation expected`)
    const times = readAccessor(json, binary, sampler.input, filename)
    const values = readAccessor(json, binary, sampler.output, filename)
    const outputAccessor = json.accessors[sampler.output]
    assert(times.length === outputAccessor.count, `${filename}: input/output key count mismatch`)
    assert(times.length >= 2, `${filename}: animation needs at least two keys`)
    assert(Math.abs(times[0]) < 1e-7, `${filename}: timeline must start at zero`)
    for (let index = 1; index < times.length; index += 1) {
      assert(Number.isFinite(times[index]) && times[index] > times[index - 1], `${filename}: times are not strictly increasing`)
    }
    assert(json.accessors[sampler.input].min?.[0] === 0, `${filename}: time accessor min missing or wrong`)
    assert(Math.abs(json.accessors[sampler.input].max?.[0] - times[times.length - 1]) < 1e-5, `${filename}: time accessor max missing or wrong`)
    duration = Math.max(duration, times[times.length - 1])

    const { node, path } = channel.target
    const boneName = nodeToBone.get(node)
    if (path === 'translation') {
      assert(boneName === 'hips', `${filename}: non-hips translation track on ${boneName ?? node}`)
      assert(outputAccessor.type === 'VEC3', `${filename}: hips translation is not VEC3`)
      hipsTranslations += 1
      let minY = Infinity
      for (let index = 1; index < values.length; index += 3) minY = Math.min(minY, values[index])
      assert(minY > 0.45, `${filename}: hips absolute Y is too low (${minY})`)
    } else if (path === 'rotation') {
      assert(outputAccessor.type === 'VEC4', `${filename}: rotation output is not VEC4`)
      assert(boneName != null || node === extension.lookAt.node, `${filename}: rotation targets an unmapped node`)
      if (node === extension.lookAt.node) lookAtRotations += 1
      for (let index = 0; index < values.length; index += 4) {
        const length = Math.hypot(values[index], values[index + 1], values[index + 2], values[index + 3])
        assert(Number.isFinite(length) && Math.abs(length - 1) < 2e-5, `${filename}: non-unit quaternion at key ${index / 4}`)
        if (index > 0) {
          const dot = values[index] * values[index - 4]
            + values[index + 1] * values[index - 3]
            + values[index + 2] * values[index - 2]
            + values[index + 3] * values[index - 1]
          assert(dot >= -1e-6, `${filename}: discontinuous quaternion sign at key ${index / 4}`)
        }
      }
    } else {
      throw new Error(`${filename}: forbidden animation path ${path}`)
    }

    if (manifestEntry.loop) {
      const itemSize = outputAccessor.type === 'VEC3' ? 3 : 4
      const first = values.subarray(0, itemSize)
      const last = values.subarray(values.length - itemSize)
      assert(maxDifference(first, last) < 2e-5, `${filename}: loop seam differs on channel ${channelIndex}`)
    }
  }
  assert(hipsTranslations === 1, `${filename}: expected exactly one hips translation track`)
  assert(lookAtRotations === 1, `${filename}: expected exactly one lookAt rotation track`)
  assert(Math.abs(duration - manifestEntry.duration) < 1e-5, `${filename}: manifest duration mismatch`)
  return { json, duration }
}

async function parseVrmaWithThree(bytes, filename) {
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.map(String).join(' '))
  try {
    const loader = new GLTFLoader()
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser))
    const gltf = await loader.parseAsync(exactArrayBuffer(bytes), '')
    const animations = gltf.userData.vrmAnimations
    assert(Array.isArray(animations) && animations.length === 1, `${filename}: Three-VRM did not create one VRMAnimation`)
    assert(animations[0].humanoidTracks.translation.has('hips'), `${filename}: Three-VRM lost hips translation`)
    assert(animations[0].humanoidTracks.rotation.size === 51, `${filename}: Three-VRM rotation map has ${animations[0].humanoidTracks.rotation.size}, expected 51`)
    assert(animations[0].lookAtTrack != null, `${filename}: Three-VRM lookAt track missing`)
    const vrmaWarnings = warnings.filter((warning) => /VRMAnimation|VRMC_vrm_animation|T-pose|not permitted/i.test(warning))
    assert(vrmaWarnings.length === 0, `${filename}: Three-VRM warnings: ${vrmaWarnings.join(' | ')}`)
    return animations[0]
  } finally {
    console.warn = originalWarn
  }
}

async function parseTargetVrm(path) {
  globalThis.self ??= globalThis
  globalThis.ProgressEvent ??= class ProgressEvent {
    constructor(type, init = {}) {
      this.type = type
      Object.assign(this, init)
    }
  }
  globalThis.createImageBitmap ??= async () => ({ width: 1, height: 1, close() {} })

  const bytes = await readFile(path)
  const loader = new GLTFLoader()
  loader.register((parser) => new VRMLoaderPlugin(parser))
  const gltf = await loader.parseAsync(exactArrayBuffer(bytes), '')
  const vrm = gltf.userData.vrm
  assert(vrm != null, `Target ${path}: Three-VRM could not load a VRM`)
  return vrm
}

async function main() {
  const dirFlag = process.argv.indexOf('--dir')
  const targetFlag = process.argv.indexOf('--target')
  const motionDir = resolve(dirFlag >= 0 ? process.argv[dirFlag + 1] : 'resources/motions')
  const targetPath = targetFlag >= 0 ? resolve(process.argv[targetFlag + 1]) : null
  const manifest = JSON.parse(await readFile(resolve(motionDir, 'manifest.json'), 'utf8'))
  const filenames = (await readdir(motionDir)).filter((name) => name.toLowerCase().endsWith('.vrma')).sort()
  assert(filenames.length >= 40, `Expected at least 40 VRMA files, found ${filenames.length}`)
  assert(manifest.count === filenames.length, `Manifest says ${manifest.count}, directory has ${filenames.length}`)
  const manifestByFilename = new Map(manifest.files.map((entry) => [entry.filename, entry]))
  const hashes = new Set()
  const parsedAnimations = new Map()
  let totalBytes = 0

  for (const filename of filenames) {
    const entry = manifestByFilename.get(filename)
    assert(entry != null, `${filename}: missing from manifest`)
    const bytes = await readFile(resolve(motionDir, filename))
    const hash = createHash('sha256').update(bytes).digest('hex')
    assert(hash === entry.sha256, `${filename}: SHA-256 differs from manifest`)
    assert(!hashes.has(hash), `${filename}: duplicate binary hash`)
    hashes.add(hash)
    assert(bytes.length === entry.bytes, `${filename}: byte length differs from manifest`)
    verifyStructure(filename, bytes, entry)
    parsedAnimations.set(filename, await parseVrmaWithThree(bytes, filename))
    totalBytes += bytes.length
  }

  let targetSummary = 'not requested'
  if (targetPath != null) {
    const target = await parseTargetVrm(targetPath)
    const missing = [...new Set(manifest.files.flatMap(() => REQUIRED_BONES))]
      .filter((bone) => target.humanoid.getNormalizedBoneNode(bone) == null)
    assert(missing.length === 0, `Target VRM missing required bones: ${missing.join(', ')}`)
    let minTracks = Infinity
    let maxTracks = 0
    for (const [filename, animation] of parsedAnimations) {
      const clip = createVRMAnimationClip(animation, target)
      assert(clip.validate(), `${filename}: generated AnimationClip failed Three.js validation`)
      assert(clip.tracks.length >= 52, `${filename}: target clip has only ${clip.tracks.length} tracks`)
      minTracks = Math.min(minTracks, clip.tracks.length)
      maxTracks = Math.max(maxTracks, clip.tracks.length)
    }
    targetSummary = `${basename(targetPath)} metaVersion=${target.meta.metaVersion}, clips=${parsedAnimations.size}, tracks=${minTracks}-${maxTracks}`
  }

  const categories = Object.entries(Object.groupBy(manifest.files, (entry) => entry.category))
    .map(([category, entries]) => `${category}:${entries.length}`)
    .join(', ')
  process.stdout.write(`PASS: ${filenames.length} unique VRMA files (${totalBytes} bytes)\n`)
  process.stdout.write(`Three-VRM parse: ${parsedAnimations.size}/${filenames.length}\n`)
  process.stdout.write(`Categories: ${categories}\n`)
  process.stdout.write(`Target retarget: ${targetSummary}\n`)
}

await main()
