/**
 * 셸 명령이 되돌리기 어려운 일을 하는지 판별한다.
 *
 * 목적은 "완벽한 차단" 이 아니다 — 셸 명령을 정적으로 완전히 분석하는 건 불가능하고,
 * 그렇게 주장하는 순간 거짓 안전감을 준다. 목적은 **자동 승인을 뚫고 사용자에게
 * 반드시 물어보게 만드는 것**이다. 애매하면 위험한 쪽으로 판단한다.
 *
 * 놓칠 수 있는 것들(의도적으로 인정하는 한계):
 *  - 변수·명령 치환으로 감춘 명령 (`$RM -rf /`)
 *  - base64 로 인코딩해 넘기는 페이로드
 *  - 스크립트 파일을 만들어 실행하는 우회
 * 그래서 이건 마지막 방어선이 아니라 첫 번째 그물이다. 진짜 경계는 샌드박스와
 * 사용자 승인이다.
 */

export type Danger = 'delete' | 'overwrite' | 'recursive-force' | 'system' | 'network-exec' | 'vcs'

export interface DangerFinding {
  danger: Danger
  /** 사용자에게 보여줄 설명. 명령어를 그대로 보여줘도 비개발자는 판단할 수 없다. */
  reason: string
}

interface Rule {
  danger: Danger
  pattern: RegExp
  reason: string
}

/**
 * 명령이 시작되는 자리. 문자열 처음이거나 구분자 뒤다.
 * 이걸 안 쓰면 인자나 문자열 안에 들어간 단어까지 명령으로 오인한다.
 */
const CMD_START = '(?:^|[;&|(]\\s*)'

/**
 * 명령 앞에 붙는 것들을 걷어내고 실제 실행부를 본다.
 * `sudo`, `cmd /c`, `powershell -Command` 같은 껍데기 안에 숨은 것을 잡기 위해서다.
 */
function normalize(command: string): string {
  return command
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

const RULES: Rule[] = [
  {
    danger: 'recursive-force',
    // rm -rf, rm -fr, rm --recursive --force 등
    pattern: /\brm\b[^|;&]*\s-[a-z]*r[a-z]*f|\brm\b[^|;&]*\s-[a-z]*f[a-z]*r|\brm\b[^|;&]*--recursive[^|;&]*--force/,
    reason: '하위 폴더까지 강제로 지운다'
  },
  {
    danger: 'delete',
    pattern: /\b(rm|unlink)\b(?![-\w])/,
    reason: '파일을 지운다'
  },
  {
    danger: 'delete',
    // Windows 쪽. remove-item 은 -recurse 가 없어도 폴더를 지울 수 있다.
    pattern: /\b(del|erase|rmdir|rd)\b(?![-\w])|remove-item\b/,
    reason: '파일이나 폴더를 지운다'
  },
  {
    danger: 'overwrite',
    // `>` 는 파일을 통째로 덮어쓴다. `>>` 는 덧붙이기라 제외한다.
    pattern: /[^>|]>(?!>)\s*[^\s|>]/,
    reason: '파일을 통째로 덮어쓴다'
  },
  {
    danger: 'overwrite',
    pattern: /\b(truncate|shred)\b|out-file\b|set-content\b/,
    reason: '파일 내용을 지우거나 덮어쓴다'
  },
  {
    danger: 'vcs',
    // 커밋 안 한 작업을 날린다. 되돌릴 방법이 없다.
    pattern: /git\s+(reset\s+--hard|clean\s+-[a-z]*[fd]|checkout\s+--\s|push\s+.*--force|push\s+.*-f\b)/,
    reason: '커밋하지 않은 변경이나 원격 이력을 날린다'
  },
  {
    danger: 'system',
    // format/mkfs 같은 건 **명령 위치**에서만 잡는다. 단어 조각으로 잡으면
    // `grep -r "format" src` 같은 멀쩡한 명령이 전부 막힌다.
    pattern: new RegExp(
      `${CMD_START}(format|mkfs\\S*|diskpart|fdisk|shutdown)\\b|\\bsudo\\b|\\bregedit\\b|reg\\s+delete\\b|\\bicacls\\b`
    ),
    reason: '시스템 설정이나 디스크를 건드린다'
  },
  {
    danger: 'network-exec',
    // 받아서 바로 실행하는 형태. 무엇이 실행될지 사전에 알 수 없다.
    pattern: /(curl|wget|iwr|invoke-webrequest)[^|;&]*\|\s*(bash|sh|zsh|python|node|iex)|iex\s*\(/,
    reason: '인터넷에서 받은 것을 바로 실행한다'
  }
]

/** 위험 요소를 전부 찾는다. 비어 있으면 이 그물에는 걸리지 않았다는 뜻일 뿐이다. */
export function findDangers(command: string): DangerFinding[] {
  const normalized = normalize(command)
  const found: DangerFinding[] = []
  const seen = new Set<Danger>()
  for (const rule of RULES) {
    if (!rule.pattern.test(normalized)) continue
    // 같은 종류를 여러 번 알릴 필요는 없다. 첫 번째 설명이 가장 구체적이다.
    if (seen.has(rule.danger)) continue
    seen.add(rule.danger)
    found.push({ danger: rule.danger, reason: rule.reason })
  }
  return found
}

/** 파일을 통째로 바꾸는 툴. 실행 전에 원본을 떠둬야 되돌릴 수 있다. */
const OVERWRITING_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit'])

export function isOverwritingTool(toolName: string): boolean {
  return OVERWRITING_TOOLS.has(toolName)
}

/** 셸 툴 이름. 백엔드마다 다르다. */
export function isShellTool(toolName: string): boolean {
  return toolName === 'Bash' || toolName === 'PowerShell' || toolName === 'shell'
}

/** 툴 입력에서 명령 문자열을 뽑는다. 백엔드마다 필드 이름이 다르다. */
export function extractCommand(input: unknown): string {
  if (typeof input === 'string') return input
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  for (const key of ['command', 'cmd', 'script']) {
    if (typeof o[key] === 'string') return o[key]
  }
  return ''
}

/** 툴 입력에서 대상 파일 경로를 뽑는다. */
export function extractFilePath(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  for (const key of ['file_path', 'filePath', 'path', 'notebook_path']) {
    if (typeof o[key] === 'string' && o[key]) return o[key]
  }
  return null
}
