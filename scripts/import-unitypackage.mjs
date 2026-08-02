#!/usr/bin/env node
// .unitypackage 를 Unity 에디터 없이 프로젝트에 풀어 넣는다.
//
// 왜 필요한가: Unity GUI 로 Import 하면 사람 손이 필요하고, 무엇이 어느 버전에서
// 들어왔는지 저장소에 남지 않는다. 이 스크립트가 곧 의존성 출처 기록이다.
//
// 사용법:
//   node scripts/import-unitypackage.mjs <패키지.unitypackage> [프로젝트 루트]
//
// .unitypackage 는 그냥 gzip 된 tar 다. 안에는 에셋마다 디렉터리가 하나씩 있고
// 그 안에 pathname(설치 경로), asset(내용), asset.meta(메타)가 들어 있다.
// 폴더 엔트리에는 asset 이 없고 meta 만 있다.

import { gunzipSync } from 'node:zlib'
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const BLOCK = 512

/** tar 아카이브에서 {name, data} 를 뽑아낸다. */
function readTar(buf) {
  const entries = []
  let offset = 0

  while (offset + BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK)
    // 이름이 비면 끝을 알리는 빈 블록이다.
    if (header[0] === 0) break

    const name = cstr(header.subarray(0, 100))
    const prefix = cstr(header.subarray(345, 500))
    const size = parseInt(cstr(header.subarray(124, 136)).trim() || '0', 8)
    const typeflag = String.fromCharCode(header[156])

    offset += BLOCK
    if (typeflag === '0' || typeflag === '\0') {
      entries.push({
        name: prefix ? `${prefix}/${name}` : name,
        data: buf.subarray(offset, offset + size)
      })
    }
    // 내용은 512 바이트 경계까지 패딩된다.
    offset += Math.ceil(size / BLOCK) * BLOCK
  }
  return entries
}

function cstr(buf) {
  const end = buf.indexOf(0)
  return buf.subarray(0, end === -1 ? buf.length : end).toString('utf8')
}

function main() {
  const [packagePath, projectRoot = '.'] = process.argv.slice(2)
  if (!packagePath) {
    console.error('사용법: node scripts/import-unitypackage.mjs <패키지.unitypackage> [프로젝트 루트]')
    process.exit(1)
  }
  if (!existsSync(packagePath)) {
    console.error(`패키지를 찾을 수 없다: ${packagePath}`)
    process.exit(1)
  }

  const entries = readTar(gunzipSync(readFileSync(packagePath)))

  // guid 디렉터리별로 모은다.
  //
  // 엔트리 이름 형식이 패키지마다 다르다 — `<guid>/asset` 인 것도 있고 `./<guid>/asset`
  // 인 것도 있다 (UniVRM 은 앞쪽, UniWindowController 는 뒤쪽). 앞에서 자르면 한쪽이
  // 통째로 누락되므로 **뒤에서** 센다. 마지막 조각이 종류, 그 앞이 guid 다.
  const byGuid = new Map()
  for (const entry of entries) {
    const parts = entry.name.split('/').filter((p) => p && p !== '.')
    if (parts.length < 2) continue
    const kind = parts[parts.length - 1]
    const guid = parts[parts.length - 2]
    if (!byGuid.has(guid)) byGuid.set(guid, {})
    byGuid.get(guid)[kind] = entry.data
  }

  const root = resolve(projectRoot)
  let files = 0
  let folders = 0

  for (const [guid, parts] of byGuid) {
    if (!parts.pathname) continue
    // pathname 에 개행이 붙어 오는 경우가 있다. 첫 줄만 쓴다.
    const relative = cstr(parts.pathname).split('\n')[0].trim()
    if (!relative) continue

    const target = join(root, relative)

    if (parts.asset) {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, parts.asset)
      files++
    } else {
      // asset 이 없으면 폴더 엔트리다. meta 만 남긴다.
      mkdirSync(target, { recursive: true })
      folders++
    }

    // .meta 가 없으면 Unity 가 새 guid 를 발급한다. 그러면 프리팹·씬의 참조가 끊긴다.
    if (parts['asset.meta']) {
      writeFileSync(`${target}.meta`, parts['asset.meta'])
    } else {
      console.warn(`  meta 없음: ${relative} (guid ${guid})`)
    }
  }

  console.log(`${packagePath} -> ${root}`)
  console.log(`  파일 ${files}개, 폴더 ${folders}개`)
}

main()
