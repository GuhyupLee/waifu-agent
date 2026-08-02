/**
 * Claude Code / Codex 가 자식 프로세스로 띄울 스크립트들의 실행 정보를 만든다.
 *
 * `?modulePath` 는 해당 파일만 **격리 빌드**해서 `out/main/<basename>-<hash>.js` 로 내보내고,
 * 런타임에는 그 파일의 절대 경로 문자열로 평가된다. main 번들과 청크를 공유하지 않으므로
 * `electron` import 가 새어 들어갈 경로가 없다.
 */
import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { app } from 'electron'
import mcpBundlePath from '../mcp/mcp-server?modulePath'
import permissionHookPath from '../hooks/permission-hook?modulePath'

export interface ChildLaunchSpec {
  readonly command: string
  readonly args: readonly string[]
}

/**
 * 패키징되면 스크립트가 app.asar 안에 들어가는데, asar 아카이브 내부 경로는 실제 파일이 아니라
 * 외부 프로세스가 열 수 없다. electron-builder 가 asarUnpack 으로 꺼내둔 실물을 가리켜야 한다.
 */
function resolveChildPath(bundlePath: string, globHint: string): string {
  if (!app.isPackaged) return bundlePath

  const appPath = app.getAppPath() // 패키징 시 .../resources/app.asar
  const unpacked = join(`${appPath}.unpacked`, relative(appPath, bundlePath))
  if (existsSync(unpacked)) return unpacked

  throw new Error(
    `자식 스크립트가 asar 에서 풀리지 않았다.\n` +
      `  asar 내부: ${bundlePath}\n` +
      `  기대 위치: ${unpacked}\n` +
      `electron-builder 설정에 "asarUnpack": ["${globHint}"] 를 넣어라.`
  )
}

/**
 * 자식 스크립트를 실행할 명령.
 *
 * 시스템에 node 가 깔려 있다고 가정하지 않는다. `process.execPath` 는 Electron 바이너리이고,
 * `ELECTRON_RUN_AS_NODE=1` 을 붙이면 순수 Node 처럼 동작한다 (electron-vite 자신도 내부에서
 * 같은 방법을 쓴다). 이 값은 런타임에만 알 수 있으므로 MCP 등록 정보를 정적 파일로
 * 미리 만들어 둘 수 없고, main 프로세스가 그때그때 써야 한다.
 */
export function mcpLaunchSpec(): ChildLaunchSpec {
  return {
    command: process.execPath,
    args: [resolveChildPath(mcpBundlePath, 'out/main/mcp-server-*.js')]
  }
}

export function permissionHookCommand(): string {
  const path = resolveChildPath(permissionHookPath, 'out/main/permission-hook-*.js')
  // 훅은 셸 명령 문자열 하나로 등록된다. 경로에 공백이 있을 수 있으니 반드시 따옴표로 싼다.
  return `"${process.execPath}" "${path}"`
}

/** 자식 스크립트가 Node 로 동작하도록 강제하는 환경변수. */
export const RUN_AS_NODE_ENV = { ELECTRON_RUN_AS_NODE: '1' } as const
