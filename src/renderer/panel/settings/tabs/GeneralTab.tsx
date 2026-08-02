import { useEffect, useState } from 'react'
import type { BackendKind, Diagnostics } from '@shared/protocol'
import { Check, Field, S, Section, Slider } from '../controls'
import type { TabProps } from '../Settings'

const BACKEND_LABELS: Record<BackendKind, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex'
}

export function GeneralTab({ config, patch }: TabProps): React.JSX.Element {
  return (
    <>
      <Section title="퍼소나">
        <Field
          label="이름"
          value={config.persona.name}
          onCommit={(v) => patch({ persona: { ...config.persona, name: v } })}
        />
        <Field
          label="성격 — 시스템 프롬프트에 덧붙는다"
          multiline
          value={config.persona.instructions}
          onCommit={(v) => patch({ persona: { ...config.persona, instructions: v } })}
        />
        <Field
          label="자막 언어 (음성은 항상 일본어)"
          value={config.persona.subtitleLang}
          onCommit={(v) => patch({ persona: { ...config.persona, subtitleLang: v.trim() } })}
        />
      </Section>

      <Section title="대화">
        <Check
          label="자막 보이기"
          hint="끄면 아바타는 소리만 낸다. 음성이 꺼져 있으면 아무것도 안 보인다."
          checked={config.chat.showSubtitle}
          onChange={(v) => patch({ chat: { ...config.chat, showSubtitle: v } })}
        />
        <Slider
          label="자막이 머무는 최소 시간"
          hint="긴 말은 글자 수에 비례해 더 오래 남는다."
          value={config.chat.subtitleMinMs}
          min={1000}
          max={8000}
          step={250}
          format={(v) => `${(v / 1000).toFixed(1)}초`}
          onChange={(v) => patch({ chat: { ...config.chat, subtitleMinMs: v } })}
        />
        <Check
          label="작업 기록 보이기"
          hint="툴 실행과 진행 상황을 채팅에 섞어 보여준다. 끄면 대화만 남는다."
          checked={config.chat.showActivity}
          onChange={(v) => patch({ chat: { ...config.chat, showActivity: v } })}
        />
      </Section>

      <Section title="백엔드">
        <div style={S.row}>
          {(Object.keys(BACKEND_LABELS) as BackendKind[]).map((kind) => (
            <label key={kind} style={S.choice}>
              <input
                type="radio"
                checked={config.backend.active === kind}
                onChange={() => patch({ backend: { ...config.backend, active: kind } })}
              />
              <span>{BACKEND_LABELS[kind]}</span>
            </label>
          ))}
        </div>
        <Check
          label="한도에 걸리면 다른 쪽으로 전환"
          hint="전환하면 이전 대화 맥락은 이어지지 않는다. 두 CLI 의 세션 저장소가 서로 다르다."
          checked={config.backend.failover}
          onChange={(v) => patch({ backend: { ...config.backend, failover: v } })}
        />
        <Field
          label="Claude Code 실행 파일"
          value={config.backend.claudeCode.bin}
          onCommit={(v) =>
            patch({ backend: { ...config.backend, claudeCode: { ...config.backend.claudeCode, bin: v.trim() } } })
          }
        />
        <Field
          label="Codex 실행 파일"
          value={config.backend.codex.bin}
          onCommit={(v) =>
            patch({ backend: { ...config.backend, codex: { ...config.backend.codex, bin: v.trim() } } })
          }
        />
        <div style={S.hint}>바꾼 뒤에는 앱을 다시 시작해야 적용된다.</div>
      </Section>

      <Diagnose />
    </>
  )
}

/** 지금 무엇이 붙어 있는지. 안 될 때 어디부터 볼지 알려준다. */
function Diagnose(): React.JSX.Element {
  const [d, setD] = useState<Diagnostics | null>(null)

  const reload = (): void => {
    void window.waifu.diagnostics().then(setD)
  }
  useEffect(reload, [])

  return (
    <Section title="상태">
      {!d && <div style={S.hint}>아직 준비되지 않았다.</div>}
      {d && (
        <div style={{ ...S.hint, lineHeight: 1.8 }}>
          백엔드: {BACKEND_LABELS[d.backend]}
          {d.busy ? ' (작업 중)' : ''}
          <br />
          세션: {d.sessionId ?? '아직 없음 — 첫 대화에서 만들어진다'}
          <br />
          모션: {d.motions}개 · 진행 중 작업: {d.activeTasks}개 · 기억: {d.memories}개
        </div>
      )}
      <button style={{ ...S.ghost, marginTop: '8px' }} onClick={reload}>
        새로고침
      </button>
    </Section>
  )
}
