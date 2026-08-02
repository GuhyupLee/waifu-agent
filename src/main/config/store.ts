import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { app } from 'electron'
import { DEFAULT_CONFIG } from '@shared/protocol'
import type { WaifuConfig } from '@shared/protocol'

/**
 * 설정 파일 위치.
 *
 * 개발 중에는 저장소 루트의 waifu.config.json 을 쓴다(직접 열어 고치기 쉽다).
 * 패키징 후에는 userData 로 간다 — 설치 폴더는 쓰기 권한이 없을 수 있다.
 */
const FILE = 'waifu.config.json'

/**
 * 개발 중에는 app.getAppPath() 가 항상 저장소 루트를 가리킨다고 믿을 수 없다
 * (electron-vite 가 out/main 을 엔트리로 띄우기 때문에 실행 방식에 따라 달라진다).
 * 후보를 순서대로 보고 실제로 있는 것을 쓴다.
 */
function configCandidates(): string[] {
  if (app.isPackaged) return [resolve(app.getPath('userData'), FILE)]
  return [
    resolve(app.getAppPath(), FILE),
    resolve(process.cwd(), FILE),
    // out/main/index.js 기준으로 두 단계 위가 저장소 루트다.
    resolve(app.getAppPath(), '..', FILE)
  ]
}

function configPath(): string {
  const candidates = configCandidates()
  const found = candidates.find((p) => existsSync(p))
  if (!found) {
    process.stderr.write(`[config] ${FILE} 을 찾지 못했다. 확인한 경로:\n`)
    for (const c of candidates) process.stderr.write(`  - ${c}\n`)
  }
  return found ?? candidates[0]!
}

/** 섹션 단위 병합. 사용자가 일부만 적어둔 파일도 기본값으로 채워 읽는다. */
function merge(base: WaifuConfig, patch: Partial<WaifuConfig>): WaifuConfig {
  return {
    backend: { ...base.backend, ...patch.backend },
    permission: { ...base.permission, ...patch.permission },
    avatar: { ...base.avatar, ...patch.avatar },
    voice: { ...base.voice, ...patch.voice },
    persona: { ...base.persona, ...patch.persona }
  }
}

let cached: WaifuConfig | null = null

export function loadConfig(): WaifuConfig {
  if (cached) return cached
  const path = configPath()
  if (!existsSync(path)) {
    cached = DEFAULT_CONFIG
    return cached
  }
  process.stdout.write(`[config] ${path}\n`)
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<WaifuConfig>
    cached = merge(DEFAULT_CONFIG, raw)
  } catch (err) {
    // 설정이 깨졌다고 앱이 못 뜨면 안 된다. 기본값으로 살리고 소리내어 알린다.
    process.stderr.write(`[config] ${path} 를 읽지 못해 기본값을 쓴다: ${String(err)}\n`)
    cached = DEFAULT_CONFIG
  }
  return cached
}

export function saveConfig(patch: Partial<WaifuConfig>): WaifuConfig {
  cached = merge(loadConfig(), patch)
  writeFileSync(configPath(), JSON.stringify(cached, null, 2), 'utf8')
  return cached
}
