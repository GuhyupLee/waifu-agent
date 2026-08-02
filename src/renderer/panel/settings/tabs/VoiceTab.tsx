import { useState } from 'react'
import { Check, Field, S, Section, Slider } from '../controls'
import type { TabProps } from '../Settings'

export function VoiceTab({ config, patch }: TabProps): React.JSX.Element {
  const [ping, setPing] = useState<{ checking: boolean; version: string | null | undefined }>({
    checking: false,
    version: undefined
  })

  const check = (): void => {
    setPing({ checking: true, version: undefined })
    void window.waifu.pingVoice(config.voice.engineUrl).then((version) => {
      setPing({ checking: false, version })
    })
  }

  const sttReady = Boolean(config.voice.stt.whisperPath && config.voice.stt.modelPath)

  return (
    <>
      <Section title="말하기">
        <Check
          label="소리 내어 말하기"
          hint="꺼져 있으면 자막만 뜬다."
          checked={config.voice.enabled}
          onChange={(v) => patch({ voice: { ...config.voice, enabled: v } })}
        />
        <Field
          label="엔진 주소 — AivisSpeech 10101, VOICEVOX 50021"
          value={config.voice.engineUrl}
          onCommit={(v) => patch({ voice: { ...config.voice, engineUrl: v.trim() } })}
        />
        <div style={{ ...S.row, marginTop: '8px' }}>
          <button style={S.ghost} onClick={check} disabled={ping.checking}>
            {ping.checking ? '확인 중…' : '연결 확인'}
          </button>
          {ping.version !== undefined && (
            <span style={S.hint}>
              {ping.version ? `연결됨 (버전 ${ping.version})` : '응답이 없다 — 엔진이 켜져 있는지 확인해라'}
            </span>
          )}
        </div>
        <Field
          label="화자 ID"
          value={String(config.voice.speakerId)}
          onCommit={(v) => {
            const n = Number(v)
            if (Number.isFinite(n) && n >= 0) patch({ voice: { ...config.voice, speakerId: n } })
          }}
        />
        <Slider
          label="말하는 속도"
          value={config.voice.speedScale}
          min={0.5}
          max={2}
          step={0.05}
          format={(v) => `${v.toFixed(2)}배`}
          onChange={(v) => patch({ voice: { ...config.voice, speedScale: v } })}
        />
        <div style={S.hint}>
          입 모양은 엔진이 주는 음소 길이로 맞춘다. 속도를 바꿔도 어긋나지 않는다.
        </div>
      </Section>

      <Section title="듣기">
        <div style={S.hint}>
          whisper.cpp 를 쓴다. 앱이 받지 않으니 이미 설치한 것을 가리켜라.
          둘 중 하나라도 비어 있으면 음성 입력이 꺼진다.
        </div>
        <Field
          label="whisper 실행 파일"
          value={config.voice.stt.whisperPath}
          onCommit={(v) =>
            patch({ voice: { ...config.voice, stt: { ...config.voice.stt, whisperPath: v.trim() } } })
          }
        />
        <Field
          label="모델 파일 (ggml-*.bin)"
          value={config.voice.stt.modelPath}
          onCommit={(v) =>
            patch({ voice: { ...config.voice, stt: { ...config.voice.stt, modelPath: v.trim() } } })
          }
        />
        <Field
          label="인식 언어 (auto 도 된다)"
          value={config.voice.stt.language}
          onCommit={(v) =>
            patch({ voice: { ...config.voice, stt: { ...config.voice.stt, language: v.trim() } } })
          }
        />
        <Field
          label="말하기 단축키"
          value={config.voice.sttHotkey}
          onCommit={(v) => patch({ voice: { ...config.voice, sttHotkey: v.trim() } })}
        />
        <div style={S.hint}>
          한 번 눌러 말하고 다시 눌러 보낸다. 누르고 있는 동안 녹음하는 방식은 만들 수 없다 —
          전역 단축키는 키를 뗀 시점을 알려주지 않는다.
        </div>
        {!sttReady && <div style={S.warn}>경로가 비어 있어 음성 입력이 꺼져 있다.</div>}
      </Section>
    </>
  )
}
