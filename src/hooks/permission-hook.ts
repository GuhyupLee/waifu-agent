/**
 * Claude Code `PreToolUse` 훅.
 *
 * claude 가 툴을 실행하기 **직전에** 이 스크립트를 자식 프로세스로 띄우고, stdin 으로 툴 정보를
 * 준 뒤 stdout 의 JSON 으로 실행 여부를 정한다. 우리는 그걸 ControlServer 로 넘겨
 * 와이프가 사용자에게 묻게 한다.
 *
 * 실측으로 확인한 계약 (claude 2.1.207 — 문서가 아니라 실제로 돌려본 결과다):
 *  - stdin:  { tool_name, tool_input, tool_use_id, cwd, permission_mode, session_id, transcript_path, prompt_id, effort }
 *  - stdout: { hookSpecificOutput: { hookEventName: 'PreToolUse',
 *              permissionDecision: 'allow'|'deny'|'ask'|'defer', permissionDecisionReason?, updatedInput? } }
 *  - exit 0. deny 하면 모델에게 tool_result 가 is_error:true 로 가고 reason 이 그 본문이 된다.
 *  - 훅 결정은 --permission-mode 보다 우선한다. defer 일 때만 모드 기본 동작을 따른다.
 *  - **matcher 는 반드시 "*" 여야 한다.** Read 만 막았더니 모델이 곧바로 Grep 으로 우회해
 *    같은 파일을 읽어냈다. 좁은 matcher 로 만든 readonly 는 readonly 가 아니다.
 *
 * 이 파일은 node(또는 ELECTRON_RUN_AS_NODE=1 인 Electron)가 직접 실행한다.
 * **electron 을 import 하면 안 된다.**
 */
import type { PermissionDecision } from '@shared/protocol'
import { ControlClient } from '../child/controlClient'

/** 사용자가 자리를 비웠을 수도 있으니 넉넉히 기다린다. */
const ASK_TIMEOUT_MS = 5 * 60 * 1000

interface HookInput {
  tool_name?: string
  tool_input?: unknown
  tool_use_id?: string
  cwd?: string
  permission_mode?: string
  session_id?: string
}

type Decision = 'allow' | 'deny' | 'ask' | 'defer'

interface HookOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse'
    permissionDecision: Decision
    permissionDecisionReason?: string
    updatedInput?: unknown
  }
}

function emit(out: HookOutput): never {
  process.stdout.write(JSON.stringify(out))
  process.exit(0)
}

function deny(reason: string): never {
  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  })
}

async function readStdin(): Promise<string> {
  const chunks: string[] = []
  process.stdin.setEncoding('utf8')
  for await (const c of process.stdin) chunks.push(c as string)
  return chunks.join('')
}

async function main(): Promise<void> {
  let input: HookInput
  try {
    input = JSON.parse(await readStdin()) as HookInput
  } catch {
    // 무엇을 승인하는지 모르면 승인하지 않는다.
    deny('waifu-agent: 훅 입력을 해석할 수 없어 거부했다')
  }

  const control = ControlClient.fromEnv()
  if (!control) deny('waifu-agent: 제어 서버 접속 정보가 없어 거부했다')

  let decision: PermissionDecision
  try {
    decision = (await control.call(
      'ask_permission',
      {
        toolName: input.tool_name ?? 'unknown',
        input: input.tool_input,
        toolUseId: input.tool_use_id,
        cwd: input.cwd,
        permissionMode: input.permission_mode
      },
      ASK_TIMEOUT_MS
    )) as PermissionDecision
  } catch (err) {
    // 여기서 defer 를 돌려주면 안 된다. headless + acceptEdits 조합에서 defer 는
    // 사용자가 모르는 사이에 파일 편집을 통과시킨다. 못 물어봤으면 막는 게 맞다.
    deny(`waifu-agent: 사용자에게 확인할 수 없어 거부했다 (${(err as Error).message})`)
  } finally {
    control.close()
  }

  if (decision.behavior === 'deny') deny(decision.message)

  const out: HookOutput = {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' }
  }
  if (decision.updatedInput !== undefined) out.hookSpecificOutput.updatedInput = decision.updatedInput
  emit(out)
}

void main()
