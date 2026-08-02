import { Check, S, Section, Slider } from '../controls'
import type { TabProps } from '../Settings'

export function AvatarTab({ config, patch }: TabProps): React.JSX.Element {
  return (
    <>
      <Section title="모델">
        <div style={{ ...S.hint, wordBreak: 'break-all', marginBottom: '8px' }}>
          {config.avatar.modelPath ?? '(없음 — 빈 화면으로 뜬다)'}
        </div>
        <button
          style={S.button}
          onClick={() => {
            void window.waifu.pickModel().then((p) => {
              if (p) patch({ avatar: { ...config.avatar, modelPath: p } })
            })
          }}
        >
          모델 고르기
        </button>
        <div style={{ ...S.hint, marginTop: '8px' }}>
          VRM 을 권한다. FBX 는 휴머노이드 본과 표정 이름에 표준이 없어 표정과 립싱크가
          동작하지 않을 수 있다.
        </div>
      </Section>

      <Section title="창">
        <Check
          label="항상 위에 두기"
          hint="끄면 다른 창에 가려진다."
          checked={config.avatar.alwaysOnTop}
          onChange={(v) => patch({ avatar: { ...config.avatar, alwaysOnTop: v } })}
        />
        <Slider
          label="크기"
          value={config.avatar.scale}
          min={0.5}
          max={2}
          step={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => patch({ avatar: { ...config.avatar, scale: v } })}
        />
      </Section>

      <Section title="움직임">
        <Check
          label="가만히 있을 때 스스로 움직이기"
          hint="둘러보거나 기지개를 켠다. 끄면 숨쉬기만 한다."
          checked={config.avatar.ambientMotion}
          onChange={(v) => patch({ avatar: { ...config.avatar, ambientMotion: v } })}
        />
        <Slider
          label="잡아 끌 때 흔들리는 정도"
          hint="0 이면 흔들리지 않고 창만 따라온다."
          value={config.avatar.swayStrength}
          min={0}
          max={2}
          step={0.1}
          format={(v) => (v === 0 ? '없음' : `${v.toFixed(1)}배`)}
          onChange={(v) => patch({ avatar: { ...config.avatar, swayStrength: v } })}
        />
      </Section>

      <Section title="클릭 판정">
        <Slider
          label="실루엣 감도"
          value={config.avatar.hitAlpha}
          min={1}
          max={64}
          step={1}
          format={(v) => (v <= 8 ? `${v} (넓게)` : v <= 24 ? `${v} (보통)` : `${v} (좁게)`)}
          onChange={(v) => patch({ avatar: { ...config.avatar, hitAlpha: v } })}
        />
        <div style={S.hint}>
          낮을수록 몸 가장자리까지 클릭을 받는다. 첫 클릭이 자주 씹히면 낮추고, 아바타
          주변 빈 곳이 클릭을 먹으면 올려라.
        </div>
        <div style={S.warn}>
          클릭이 전달되기 전에 판정이 먼저 끝나야 해서, 값이 너무 높으면 아바타를 눌러도
          반응하지 않는 것처럼 느껴진다.
        </div>
      </Section>
    </>
  )
}
