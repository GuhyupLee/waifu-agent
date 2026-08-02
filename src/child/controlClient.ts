import { request } from 'node:http'
import { CONTROL_ENV } from '@shared/protocol'
import type { ControlRequest, ControlResponse, WaifuToolName } from '@shared/protocol'

/**
 * Claude Code 가 spawn 하는 자식 스크립트(MCP 서버, 권한 훅)가 Electron main 의
 * ControlServer 를 호출하는 통로.
 *
 * node 빌트인만 쓴다. 이 파일은 `?modulePath` 로 격리 빌드되어 패키징 후에는
 * node_modules 가 닿지 않는 곳에서 실행되므로, 외부 의존을 하나라도 남기면 죽는다.
 *
 * `src/shared/` 에 두지 않는 이유: 렌더러도 shared 를 import 하는데, node 전용 모듈이
 * 섞이면 vite 가 브라우저용으로 외부화하다가 런타임에 터진다. shared 는 순수 타입·상수만 둔다.
 */
export class ControlClient {
  private seq = 0

  constructor(
    private readonly port: string,
    private readonly token: string
  ) {}

  /** 환경변수에서 접속 정보를 읽는다. 없으면 null — 호출자가 상황에 맞게 실패 처리한다. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): ControlClient | null {
    const port = env[CONTROL_ENV.port]
    const token = env[CONTROL_ENV.token]
    return port && token ? new ControlClient(port, token) : null
  }

  /**
   * 툴 한 번 호출.
   *
   * timeoutMs 는 호출마다 다르다 — 표정 바꾸기는 즉시지만 권한 승인은 사용자가
   * 커피 타러 갔을 수도 있다.
   */
  call(tool: WaifuToolName, args: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const payload: ControlRequest = { id: `${tool}_${++this.seq}_${process.pid}`, tool, args }
    const body = Buffer.from(JSON.stringify(payload), 'utf8')

    return new Promise<unknown>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: Number(this.port),
          path: '/tool',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': body.byteLength,
            'x-waifu-token': this.token
          }
        },
        (res) => {
          let text = ''
          res.setEncoding('utf8')
          res.on('data', (c: string) => (text += c))
          res.on('end', () => {
            if (res.statusCode !== 200) {
              reject(new Error(`제어 서버 응답 ${res.statusCode}`))
              return
            }
            let out: ControlResponse
            try {
              out = JSON.parse(text) as ControlResponse
            } catch {
              reject(new Error('제어 서버 응답을 해석할 수 없다'))
              return
            }
            if (out.ok) resolve(out.result)
            else reject(new Error(out.error ?? '제어 서버가 실패를 알렸다'))
          })
        }
      )

      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`${tool} 응답 시간 초과 (${timeoutMs}ms)`))
      })
      req.on('error', reject)
      req.end(body)
    })
  }

  /** HTTP 는 요청마다 연결이 끝나므로 따로 닫을 것이 없다. 호출부 대칭을 위해 남겨둔다. */
  close(): void {}
}
