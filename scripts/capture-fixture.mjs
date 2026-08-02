/**
 * 실제 CLI 출력을 픽스처로 떠서 tests/fixtures 에 저장한다.
 *
 * 파서 테스트를 매번 CLI 호출로 돌리면 구독 한도를 태운다. 스키마가 바뀌었다고 의심될 때만
 * 이 스크립트를 한 번 돌리고, 평소에는 저장된 픽스처로 테스트한다.
 *
 *   node scripts/capture-fixture.mjs claude-multiturn
 *
 * claude-multiturn 은 이 앱의 핵심 가정을 검증한다:
 * 프로세스 하나를 살려둔 채 stdin 으로 여러 턴을 밀어넣어도 맥락이 유지되는가.
 */
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `system/init` 은 설치된 플러그인·스킬·MCP 서버 목록과 홈 디렉터리 경로를 통째로 싣고 온다.
 * 파서는 거기서 session_id 와 model 만 읽으므로, 저장소에 커밋되는 픽스처에서는 걷어낸다.
 * 이벤트 구조 자체는 그대로 남으므로 테스트가 검증하는 바는 달라지지 않는다.
 */
const INIT_DROP = ['tools', 'mcp_servers', 'slash_commands', 'agents', 'skills', 'plugins', 'memory_paths']

function sanitize(line) {
  let obj
  try {
    obj = JSON.parse(line)
  } catch {
    return line
  }
  if (obj.type === 'system' && obj.subtype === 'init') {
    for (const k of INIT_DROP) delete obj[k]
  }
  // 남아 있는 홈 경로를 치환한다 (transcript_path, cwd 등).
  // 직렬화된 뒤에는 Windows 경로의 백슬래시가 이중으로 escape 되어 있으므로
  // 두 형태를 모두 지워야 한다. 한쪽만 지우면 사용자명이 남는다.
  const home = homedir()
  const homeEscaped = JSON.stringify(home).slice(1, -1)
  return JSON.stringify(obj).split(home).join('<HOME>').split(homeEscaped).join('<HOME>')
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = resolve(ROOT, 'tests/fixtures')

const TURNS = [
  'Read package.json and reply with only the value of the name field. No other words.',
  'What was the value you just told me? Reply with only that word, nothing else.'
]

/** claude 는 Windows 에서 .cmd 셰임일 수 있어 shell 경유가 필요하다. */
const IS_WIN = process.platform === 'win32'

function captureClaudeMultiturn() {
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--replay-user-messages',
    '--verbose',
    '--allowedTools',
    'Read'
  ]

  const child = spawn('claude', args, {
    cwd: ROOT,
    shell: IS_WIN,
    stdio: ['pipe', 'pipe', 'pipe']
  })

  const lines = []
  const stderr = []
  let turn = 0
  let buf = ''

  const sendTurn = (text) => {
    const msg = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] }
    }
    child.stdin.write(JSON.stringify(msg) + '\n')
    console.error(`[capture] -> turn ${turn + 1}: ${text.slice(0, 50)}...`)
  }

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    // 청크 경계에서 라인이 잘리므로 마지막 조각은 버퍼에 남긴다.
    buf += chunk
    const parts = buf.split('\n')
    buf = parts.pop() ?? ''
    for (const line of parts) {
      if (!line.trim()) continue
      lines.push(line)
      let evt
      try {
        evt = JSON.parse(line)
      } catch {
        console.error('[capture] JSON 파싱 실패:', line.slice(0, 120))
        continue
      }
      if (evt.type === 'result') {
        turn += 1
        console.error(`[capture] <- result ${turn}: is_error=${evt.is_error} "${evt.result}"`)
        if (turn < TURNS.length) {
          sendTurn(TURNS[turn])
        } else {
          child.stdin.end()
        }
      }
    }
  })

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (c) => stderr.push(c))

  child.on('close', (code) => {
    if (buf.trim()) lines.push(buf)
    mkdirSync(OUT_DIR, { recursive: true })
    const out = resolve(OUT_DIR, 'claude-multiturn.jsonl')
    writeFileSync(out, lines.map(sanitize).join('\n') + '\n', 'utf8')
    console.error(`\n[capture] exit=${code}  ${lines.length} lines -> ${out}`)
    if (stderr.length) console.error('[capture] stderr:', stderr.join('').slice(0, 500))

    const types = new Map()
    for (const l of lines) {
      try {
        const e = JSON.parse(l)
        const k =
          e.type === 'stream_event'
            ? `stream_event/${e.event?.type}`
            : e.subtype
              ? `${e.type}/${e.subtype}`
              : e.type
        types.set(k, (types.get(k) ?? 0) + 1)
      } catch {
        types.set('PARSE_FAIL', (types.get('PARSE_FAIL') ?? 0) + 1)
      }
    }
    console.error('[capture] 이벤트 분포:')
    for (const [k, v] of [...types].sort((a, b) => b[1] - a[1])) console.error(`  ${String(v).padStart(4)}  ${k}`)
  })

  sendTurn(TURNS[0])
}

const which = process.argv[2] ?? 'claude-multiturn'
if (which === 'claude-multiturn') {
  captureClaudeMultiturn()
} else {
  console.error(`알 수 없는 픽스처: ${which}`)
  process.exit(1)
}
