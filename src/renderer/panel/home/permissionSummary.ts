import type { PermissionRequest } from '@shared/protocol'

export interface PermissionSummary {
  action: string
  reason: string
  target: string
  reversibility: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function shortValue(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() ? value.trim().slice(0, 240) : null
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
    return value.join(' ').slice(0, 240)
  }
  return null
}

function targetFrom(input: unknown): string | null {
  const record = asRecord(input)
  if (!record) return shortValue(input)

  const keys = [
    'file_path',
    'filePath',
    'path',
    'notebook_path',
    'command',
    'url',
    'query',
    'pattern'
  ] as const
  for (const key of keys) {
    const value = shortValue(record[key])
    if (value) return value
  }
  return null
}

function actionName(toolName: string): string {
  const names: Readonly<Record<string, string>> = {
    Read: '파일 읽기',
    Glob: '파일 찾기',
    Grep: '내용 검색',
    Edit: '파일 수정',
    Write: '파일 쓰기',
    NotebookEdit: '노트북 수정',
    Bash: '명령 실행',
    shell: '명령 실행'
  }
  return names[toolName] ?? toolName
}

function reversibilityFor(request: PermissionRequest): string {
  if (request.reason && /되돌리기 어렵|복구하기 어렵|삭제|파괴/i.test(request.reason)) {
    return '이 작업은 바로 되돌리기 어려울 수 있어.'
  }
  if (/^(Read|Glob|Grep|NotebookRead)$/i.test(request.toolName)) {
    return '파일을 바꾸지 않는 요청이야.'
  }
  if (/^(Edit|Write|NotebookEdit)$/i.test(request.toolName)) {
    return '변경 전 사본이 남아 있다면 설정의 최근 변경에서 되돌릴 수 있어.'
  }
  if (/^(Bash|shell)$/i.test(request.toolName)) {
    return '명령의 결과에 따라 되돌리기 어려울 수 있어.'
  }
  return '이 입력만으로는 되돌릴 수 있는지 확인되지 않아.'
}

export function summarizePermission(request: PermissionRequest): PermissionSummary {
  return {
    action: actionName(request.toolName),
    reason: request.reason?.trim() || '이 작업을 계속하려면 승인이 필요해.',
    target:
      targetFrom(request.input) ?? '대상을 자동으로 확인하지 못했어. 세부 내용을 직접 확인해줘.',
    reversibility: reversibilityFor(request)
  }
}

const MAX_PERMISSION_DETAIL_CHARS = 6_000

export function permissionDetails(input: unknown): string {
  try {
    const details = JSON.stringify(input, null, 2) ?? String(input)
    if (details.length <= MAX_PERMISSION_DETAIL_CHARS) return details
    return `${details.slice(0, MAX_PERMISSION_DETAIL_CHARS)}\n… (입력이 길어 일부만 표시했어)`
  } catch {
    return '[세부 내용을 표시할 수 없음]'
  }
}
