/**
 * 와이프 제어 MCP 서버.
 *
 * Claude Code / Codex 가 이 스크립트를 stdio 자식 프로세스로 띄운다. 에이전트는 턴을 도는
 * **도중에** 여기 있는 툴을 불러 아바타를 움직인다. 최종 응답만 TTS 로 읽는 단방향 구조와
 * 달리, 표정과 모션이 감성분석 추측이 아니라 에이전트의 명시적 의도가 된다.
 *
 * 이 파일은 `node`(또는 ELECTRON_RUN_AS_NODE=1 인 Electron)가 직접 실행한다.
 * **electron 을 import 하면 안 된다.** electron-vite 의 `?modulePath` 로 격리 빌드되므로
 * main 번들과 청크를 공유하지 않는다.
 *
 * 파일명이 `mcp-server.ts` 인 이유: `?modulePath` 가 `out/main/<basename>-<hash>.js` 로
 * 내보내므로, electron-builder 의 asarUnpack 글롭이 `out/main/mcp-server-*.js` 처럼
 * 명확해진다. `server.ts` 였다면 글롭이 `server-*.js` 라 너무 넓다.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { EMOTIONS } from '@shared/protocol'
import type { Emotion } from '@shared/protocol'
import { ControlClient } from '../child/controlClient'

/** 아바타 제어는 즉시 반영된다. 오래 걸리면 뭔가 잘못된 것이다. */
const UI_TIMEOUT_MS = 30_000

const control = ControlClient.fromEnv()

/** 제어 서버가 없으면 에이전트에게 솔직히 알린다. 조용히 성공한 척하면 디버깅이 지옥이 된다. */
function noControl(): { content: [{ type: 'text'; text: string }]; isError: true } {
  return {
    content: [{ type: 'text', text: '와이프 앱에 연결할 수 없다. 아바타 제어를 건너뛰었다.' }],
    isError: true
  }
}

async function call(
  tool: Parameters<ControlClient['call']>[0],
  args: Record<string, unknown>
): Promise<{ content: [{ type: 'text'; text: string }]; isError?: true }> {
  if (!control) return noControl()
  try {
    const result = await control.call(tool, args, UI_TIMEOUT_MS)
    return { content: [{ type: 'text', text: typeof result === 'string' ? result : 'ok' }] }
  } catch (err) {
    return { content: [{ type: 'text', text: `실패: ${(err as Error).message}` }], isError: true }
  }
}

const emotionSchema = z.enum(EMOTIONS as unknown as [Emotion, ...Emotion[]])

const server = new McpServer({ name: 'waifu', version: '0.1.0' })

server.registerTool(
  'waifu_say',
  {
    title: '말하기',
    description:
      '와이프가 소리 내어 말한다. 사용자에게 하는 말은 전부 이 툴로 해라 — 텍스트로만 답하지 마라. ' +
      '턴 도중에도 불러도 된다 (예: 파일을 뒤지기 전에 "잠깐만, 좀 볼게"). ' +
      'text 는 화면 자막(사용자 언어), speech_ja 는 실제로 읽을 일본어 대사다.',
    inputSchema: {
      text: z.string().describe('화면에 뜨는 자막. 사용자의 언어로.'),
      speech_ja: z.string().optional().describe('TTS 가 읽을 일본어 대사. 없으면 무음 자막만 뜬다.'),
      emotion: emotionSchema.optional().describe('말하는 동안의 표정.'),
      motion: z.string().optional().describe('같이 재생할 모션 이름 (예: wave, nod, think).')
    }
  },
  async (args) => call('waifu_say', args as Record<string, unknown>)
)

server.registerTool(
  'waifu_express',
  {
    title: '표정 바꾸기',
    description: '말하지 않고 표정만 바꾼다. 작업 중 반응을 보여줄 때 쓴다.',
    inputSchema: {
      emotion: emotionSchema,
      intensity: z.number().min(0).max(1).optional().describe('0..1. 기본 1.')
    }
  },
  async (args) => call('waifu_express', args as Record<string, unknown>)
)

server.registerTool(
  'waifu_motion',
  {
    title: '모션 재생',
    description: '몸짓 애니메이션을 재생한다. 사용 가능한 이름은 waifu_status 응답에서 알려준다.',
    inputSchema: {
      name: z.string(),
      loop: z.boolean().optional()
    }
  },
  async (args) => call('waifu_motion', args as Record<string, unknown>)
)

server.registerTool(
  'waifu_status',
  {
    title: '상태 표시',
    description:
      '와이프가 지금 무엇을 하는 중인지 몸으로 보여준다. 긴 작업을 시작할 때 working 으로, ' +
      '끝나면 idle 로 되돌려라.',
    inputSchema: {
      state: z.enum(['idle', 'thinking', 'working', 'speaking', 'error'])
    }
  },
  async (args) => call('waifu_status', args as Record<string, unknown>)
)

server.registerTool(
  'remember',
  {
    title: '기억하기',
    description:
      '사용자에 대해 알게 된 것을 다음 세션까지 남긴다. 대화에서 드러난 취향·습관·진행 중인 일처럼 ' +
      '다시 물어보면 실례가 될 것들을 저장해라. 이번 대화에서만 쓸 정보는 저장하지 마라.',
    inputSchema: {
      key: z.string().describe('짧은 슬러그. 같은 키로 다시 쓰면 갱신된다.'),
      value: z.string()
    }
  },
  async (args) => call('remember', args as Record<string, unknown>)
)

server.registerTool(
  'recall',
  {
    title: '기억 꺼내기',
    description: '저장해둔 기억을 검색한다.',
    inputSchema: { query: z.string() }
  },
  async (args) => call('recall', args as Record<string, unknown>)
)

server.registerTool(
  'task_update',
  {
    title: '작업 상태 갱신',
    description:
      '지금 하고 있는 작업의 상태를 적는다. 앱을 껐다 켜거나 사용량 한도로 중단됐다가 ' +
      '이어서 할 때, 여기 적힌 것만이 어디서부터 다시 시작할지 아는 근거가 된다. ' +
      '오래 걸리는 일은 단계가 바뀔 때마다 갱신해라.',
    inputSchema: {
      state: z
        .enum(['running', 'waiting-user', 'done', 'failed'])
        .optional()
        .describe('waiting-user 는 사용자 답을 받아야 진행되는 상태다.'),
      plan: z.string().optional().describe('지금 무엇을 하는 중인지 한두 문장으로.'),
      next_action: z.string().optional().describe('이 턴이 끊겨도 다음에 이어서 할 일.'),
      needs_user: z.string().optional().describe('사용자에게 물어봐야 하는 것. 없으면 빈 문자열.'),
      title: z.string().optional().describe('작업 이름을 더 정확하게 바꾼다.')
    }
  },
  async (args) => call('task_update', args as Record<string, unknown>)
)

server.registerTool(
  'task_note',
  {
    title: '작업 기록',
    description:
      '작업 저널에 한 줄 남긴다. 나중에 사용자가 "어디까지 했어?" 라고 물으면 이걸로 답한다. ' +
      '결정한 것, 발견한 것, 건너뛴 것처럼 다시 떠올려야 할 것만 남겨라.',
    inputSchema: { text: z.string() }
  },
  async (args) => call('task_note', args as Record<string, unknown>)
)

server.registerTool(
  'waifu_move',
  {
    title: '다른 모니터로 이동',
    description:
      '아바타를 다른 모니터로 옮긴다. 사용자가 "이리 와" 라고 하거나, 지금 작업 중인 화면 쪽으로 ' +
      '가는 게 자연스러울 때 쓴다. 모니터가 하나뿐이면 아무 일도 일어나지 않는다.',
    inputSchema: {
      to: z
        .enum(['left', 'right', 'cursor'])
        .describe("cursor 는 마우스가 있는 모니터로 간다 — \"이리 와\" 에 해당한다.")
    }
  },
  async (args) => call('waifu_move', args as Record<string, unknown>)
)

server.registerTool(
  'task_list',
  {
    title: '작업 목록',
    description: '아직 끝나지 않은 작업들을 본다. 사용자가 진행 상황을 물을 때 쓴다.',
    inputSchema: {}
  },
  async () => call('task_list', {})
)

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport())
}

void main().catch((err: unknown) => {
  // stdout 은 MCP 프로토콜 전용이다. 로그를 섞으면 핸드셰이크가 깨진다.
  process.stderr.write(`waifu mcp 서버 시작 실패: ${String(err)}\n`)
  process.exit(1)
})
