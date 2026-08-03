import { Check, Field, S, Section, Slider } from '../controls'
import type { TabProps } from '../Settings'

/**
 * 와이프가 어떤 사람인가에 대한 설정. 프로그램 설정과 섞지 않는다.
 *
 * 성격을 손보러 들어온 사람이 CLI 실행 파일 경로를 먼저 보게 되면, 이 앱이
 * 무엇인지에 대한 인상이 거기서 정해진다.
 */
export function WaifuTab({ config, patch }: TabProps): React.JSX.Element {
  return (
    <>
      <Section title="누구인가">
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
        <div style={S.hint}>
          여기 적은 것은 매 대화의 시작에 붙는다. 길수록 매번 그만큼을 다시 읽히므로,
          말투와 태도처럼 자주 흔들리는 것만 적는 편이 낫다.
        </div>
      </Section>

      <Section title="말과 자막">
        <Field
          label="자막 언어 (음성은 항상 일본어)"
          value={config.persona.subtitleLang}
          onCommit={(v) => patch({ persona: { ...config.persona, subtitleLang: v.trim() } })}
        />
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
      </Section>

      <Section title="일하는 모습 보여주기">
        <Check
          label="작업 기록을 대화에 섞기"
          hint="어떤 툴을 왜 돌렸는지 보여준다. 끄면 대화만 남는다 — 조용하지만, 뭘 하고 있는지 알 수 없다."
          checked={config.chat.showActivity}
          onChange={(v) => patch({ chat: { ...config.chat, showActivity: v } })}
        />
      </Section>
    </>
  )
}
