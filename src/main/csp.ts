import { app, session } from 'electron'

/**
 * 렌더러가 무엇을 불러올 수 있는지 좁힌다.
 *
 * 이 앱은 사용자가 고른 임의의 VRM/VRMA 파일을 렌더러에서 파싱한다. 무엇을 불러올 수
 * 있는지 정해두지 않으면, 모델 파일이 외부로 요청을 보내는 통로가 될 수 있다.
 *
 * HTML 의 meta 태그가 아니라 헤더로 주는 이유:
 *  - 개발과 배포에서 정책이 달라야 한다. dev 서버는 `unsafe-eval` 이 필요하지만
 *    배포본에는 있으면 안 된다. meta 태그로는 이걸 나누기 번거롭다.
 *  - 두 곳에 적어두면 어느 쪽이 실제로 적용되는지 헷갈린다. 한 곳에서만 정한다.
 */
function policy(): string {
  const dev = !app.isPackaged

  const directives: Record<string, string[]> = {
    // 명시하지 않은 것은 전부 막는다. 새 리소스 종류를 쓰게 되면 여기서 걸려
    // 의식적으로 열게 된다.
    'default-src': ["'none'"],
    'script-src': ["'self'"],
    // three.js 와 React 가 인라인 스타일을 쓴다.
    'style-src': ["'self'", "'unsafe-inline'"],
    // waifu-asset: 는 main 이 허용 목록에 올린 경로만 열어주는 자체 스킴이다.
    'img-src': ["'self'", 'data:', 'blob:', 'waifu-asset:'],
    // 합성된 음성은 Blob URL 로 재생한다. base64 를 data: URL 로 넘기면
    // 긴 발화에서 URL 길이 제한에 걸린다.
    'media-src': ["'self'", 'blob:'],
    'connect-src': ["'self'", 'blob:', 'data:', 'waifu-asset:'],
    'font-src': ["'self'", 'data:'],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'frame-src': ["'none'"]
  }

  if (dev) {
    // Vite 의 HMR 과 소스맵 때문에 필요하다. 배포본에는 넣지 않는다 —
    // Electron 이 unsafe-eval 을 감지하면 보안 경고를 띄우는 것도 그래서다.
    directives['script-src']!.push("'unsafe-inline'", "'unsafe-eval'")
    directives['connect-src']!.push('http://localhost:*', 'ws://localhost:*')
  }

  return Object.entries(directives)
    .map(([key, values]) => `${key} ${values.join(' ')}`)
    .join('; ')
}

/** app.whenReady() 이후에 부른다. */
export function applyContentSecurityPolicy(): void {
  const csp = policy()
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp]
      }
    })
  })
  process.stdout.write(`[csp] ${app.isPackaged ? '배포' : '개발'} 정책 적용\n`)
}
