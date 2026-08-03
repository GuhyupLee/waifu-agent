import { existsSync } from 'node:fs'
import { normalize, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, net, protocol } from 'electron'

/**
 * 렌더러가 앱 밖의 VRM/VRMA 파일을 읽을 수 있게 해주는 커스텀 스킴.
 *
 * `file://` 을 그냥 열어주면 렌더러가 디스크 전체를 읽을 수 있게 된다. 여기서는
 * 명시적으로 허용한 파일·디렉터리만 통과시킨다.
 */
const SCHEME = 'waifu-asset'

/** 허용 목록. 절대 경로(파일) 또는 디렉터리 접두사. */
const allowed = new Set<string>()

/**
 * 로컬 전용 스킴이라 오리진을 좁힐 실익이 없다. 접근 통제는 오리진이 아니라
 * 위 허용 목록이 담당한다 — 렌더러는 우리가 명시적으로 올린 경로만 읽을 수 있다.
 */
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Cross-Origin-Resource-Policy': 'cross-origin'
}

function allowAssetPath(path: string): void {
  allowed.add(normalize(resolve(path)))
}

function isAllowed(target: string): boolean {
  const t = normalize(resolve(target))
  for (const a of allowed) {
    // 디렉터리 허용은 접두사 비교로 하되, 구분자까지 맞춰야 한다.
    // 그렇지 않으면 `C:\data` 허용이 `C:\data-secret` 까지 열어준다.
    if (t === a || t.startsWith(a.endsWith(sep) ? a : a + sep)) return true
  }
  return false
}

/**
 * app.whenReady() **전에** 불러야 한다. 준비 후에 호출하면 무시된다.
 * fetch/스트리밍이 되도록 standard + supportFetchAPI 로 등록한다.
 */
export function registerAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: true,
        // 개발 중 렌더러 오리진은 http://localhost:5173 이라 커스텀 스킴 요청이 교차 출처가 된다.
        // corsEnabled 없이는 three 의 로더가 "Failed to fetch" 로 죽는다.
        corsEnabled: true
      }
    }
  ])
}

/** app.whenReady() 이후에 부른다. */
export function handleAssetProtocol(): void {
  protocol.handle(SCHEME, async (request) => {
    // waifu-asset://local/<URI 인코딩된 절대 경로>
    const url = new URL(request.url)
    const target = decodeURIComponent(url.pathname).replace(/^\//, '')

    if (!isAllowed(target)) {
      process.stderr.write(`[asset] 허용되지 않은 경로: ${target}\n`)
      return new Response('forbidden', { status: 403, headers: CORS })
    }
    if (!existsSync(target)) {
      process.stderr.write(`[asset] 파일 없음: ${target}\n`)
      return new Response('not found', { status: 404, headers: CORS })
    }

    try {
      const res = await net.fetch(pathToFileURL(target).toString())
      // net.fetch 가 돌려준 Response 에는 CORS 헤더가 없다. 그대로 넘기면 렌더러에서 막힌다.
      const headers = new Headers(res.headers)
      for (const [k, v] of Object.entries(CORS)) headers.set(k, v)
      return new Response(res.body, { status: res.status, headers })
    } catch (err) {
      process.stderr.write(`[asset] 읽기 실패 ${target}: ${String(err)}\n`)
      return new Response('read error', { status: 500, headers: CORS })
    }
  })

  // 앱이 들고 있는 기본 에셋은 항상 허용한다.
  allowAssetPath(resolve(app.getAppPath(), 'resources'))
}

/** 렌더러에 넘길 URL 을 만든다. 경로를 허용 목록에 넣는 일까지 여기서 한다. */
export function assetUrl(absolutePath: string): string {
  allowAssetPath(absolutePath)
  return `${SCHEME}://local/${encodeURIComponent(normalize(resolve(absolutePath)))}`
}
