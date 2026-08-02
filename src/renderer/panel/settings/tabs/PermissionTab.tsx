import { useEffect, useState } from 'react'
import type { FileChange, PermissionMode } from '@shared/protocol'
import { Field, S, Section } from '../controls'
import type { TabProps } from '../Settings'

const LABELS: Record<PermissionMode, { name: string; desc: string }> = {
  readonly: { name: '대화만 하기', desc: '파일을 바꾸지 않는다. 읽고 답하기만 한다.' },
  guarded: { name: '도와주기', desc: '바꾸기 전에 반드시 확인한다.' },
  auto: { name: '맡겨두기', desc: '허용한 폴더 안에서 묻지 않고 작업한다.' }
}

export function PermissionTab({ config, patch }: TabProps): React.JSX.Element {
  return (
    <>
      <Section title="기본 권한">
        {(Object.keys(LABELS) as PermissionMode[]).map((mode) => (
          <label key={mode} style={S.choice}>
            <input
              type="radio"
              checked={config.permission.mode === mode}
              onChange={() => patch({ permission: { ...config.permission, mode } })}
            />
            <span>
              <b>{LABELS[mode].name}</b>
              <div style={S.hint}>{LABELS[mode].desc}</div>
            </span>
          </label>
        ))}

        {config.permission.mode === 'auto' && (
          <div style={S.warn}>
            묻지 않고 실행한다. 허용 폴더를 좁게 잡아두는 걸 권한다.
          </div>
        )}
        {config.backend.active === 'codex' && config.permission.mode === 'guarded' && (
          <div style={S.warn}>
            Codex 에는 툴마다 물어보는 경로가 없다. 샌드박스로만 막으므로 Claude Code 보다 헐겁다.
          </div>
        )}

        <div style={{ ...S.hint, marginTop: '10px' }}>
          되돌리기 어려운 명령(삭제, 덮어쓰기, git reset 등)은 어느 모드에서든 항상 물어본다.
          화면·클립보드 공유도 마찬가지다.
        </div>
      </Section>

      <Section title="작업 허용 폴더">
        <Field
          label="줄바꿈으로 구분. 비우면 홈 폴더에서 시작한다."
          multiline
          value={config.permission.workspaces.join('\n')}
          onCommit={(v) =>
            patch({
              permission: {
                ...config.permission,
                workspaces: v.split('\n').map((s) => s.trim()).filter(Boolean)
              }
            })
          }
        />
      </Section>

      <Section title="묻지 않고 통과시킬 툴">
        <Field
          label="쉼표로 구분. 읽기 전용 툴만 넣는 게 안전하다."
          value={config.permission.autoApprove.join(', ')}
          onCommit={(v) =>
            patch({
              permission: {
                ...config.permission,
                autoApprove: v.split(',').map((s) => s.trim()).filter(Boolean)
              }
            })
          }
        />
      </Section>

      <RecentChanges />
    </>
  )
}

/**
 * 에이전트가 바꾼 파일과 되돌리기.
 *
 * 삭제는 여기 안 나온다 — 셸이 지운 파일은 우리 손을 거치지 않아 뜰 수가 없다.
 */
function RecentChanges(): React.JSX.Element {
  const [changes, setChanges] = useState<FileChange[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  const reload = (): void => {
    void window.waifu.listChanges().then(setChanges)
  }
  useEffect(reload, [])

  return (
    <Section title="최근 바뀐 파일">
      {changes.length === 0 && <div style={S.hint}>아직 바뀐 파일이 없다.</div>}
      {changes.slice(0, 15).map((c) => {
        const canUndo = c.hasBackup && c.restoredAt === null
        return (
          <div key={c.id} style={S.listRow}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={S.mono}>{c.path}</div>
              <div style={S.hint}>
                {new Date(c.at).toLocaleString()} · {c.toolName}
                {c.restoredAt ? ' · 되돌림' : c.hasBackup ? '' : ' · 새로 만든 파일'}
              </div>
            </div>
            <button
              style={{ ...S.ghost, ...(canUndo ? {} : { opacity: 0.4, cursor: 'default' }) }}
              disabled={!canUndo || busy === c.id}
              onClick={() => {
                setBusy(c.id)
                void window.waifu.undoChange(c.id).then((r) => {
                  setBusy(null)
                  // 실패 이유를 숨기면 사용자는 되돌아간 줄 안다.
                  if (!r.ok) window.alert(`되돌리지 못했다: ${r.reason ?? '알 수 없는 이유'}`)
                  reload()
                })
              }}
            >
              되돌리기
            </button>
          </div>
        )
      })}
      {changes.length > 0 && (
        <div style={{ ...S.hint, marginTop: '8px' }}>
          삭제된 파일은 여기 나오지 않는다. 셸이 지운 것은 우리 손을 거치지 않는다.
        </div>
      )}
    </Section>
  )
}
