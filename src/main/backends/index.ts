import type { BackendKind, WaifuConfig } from '@shared/protocol'
import { ClaudeCodeBackend } from './claudeCode'
import { CodexBackend } from './codex'
import type { AgentBackend } from './types'

export function createBackend(kind: BackendKind): AgentBackend {
  return kind === 'codex' ? new CodexBackend() : new ClaudeCodeBackend()
}

/** 설정에서 해당 백엔드의 실행 파일과 모델을 꺼낸다. */
export function backendSettings(
  config: WaifuConfig,
  kind: BackendKind
): { bin: string; model?: string } {
  const s = kind === 'codex' ? config.backend.codex : config.backend.claudeCode
  return s.model ? { bin: s.bin, model: s.model } : { bin: s.bin }
}

/** 페일오버 상대. 지금은 둘뿐이라 단순하다. */
export function otherBackend(kind: BackendKind): BackendKind {
  return kind === 'claude-code' ? 'codex' : 'claude-code'
}
