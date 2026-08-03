import { useEffect, useState } from 'react'
import type { BackendKind, Diagnostics } from '@shared/protocol'
import { Check, Field, S, Section, Slider } from '../controls'
import type { TabProps } from '../Settings'

const BACKEND_LABELS: Record<BackendKind, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex'
}

/**
 * 프로그램 자체의 설정 — 어떤 CLI 를 쓰는지, 창을 닫으면 어떻게 되는지, Unity 셸.
 *
 * 퍼소나·대화는 <c>WaifuTab</c>, 그리는 방식은 <c>AvatarTab</c> 이 맡는다.
 * 예전에는 이 셋이 '일반' 탭 하나에 섞여 있어서, 성격을 바꾸러 들어간 사람이
 * 백엔드 실행 파일 경로를 먼저 봐야 했다.
 */
export function SystemTab({ config, patch }: TabProps): React.JSX.Element {
  return (
    <>
      <Section title="무엇이 생각을 하나">
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
        <div style={S.warn}>
          같은 &quot;도와주기&quot; 라도 Codex 쪽이 더 헐겁다. Claude Code 는 툴마다 확인을
          받지만, Codex 에는 물어볼 경로가 없어 샌드박스 등급으로만 막는다.
        </div>
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
          onCommit={(v) => patch({ backend: { ...config.backend, codex: { ...config.backend.codex, bin: v.trim() } } })}
        />
        <div style={S.hint}>저장한 뒤 ‘앱 다시 시작’을 눌러야 현재 실행에 반영된다.</div>
      </Section>

      <Section title="창과 트레이">
        <div style={S.hint}>로그인 실행과 트레이 아이콘 변경은 저장 후 앱을 다시 시작해야 반영된다.</div>
        <Check
          label="로그인할 때 자동으로 실행"
          checked={config.system.launchAtLogin}
          onChange={(v) => patch({ system: { ...config.system, launchAtLogin: v } })}
        />
        <Check
          label="트레이 아이콘 띄우기"
          checked={config.system.trayIcon}
          onChange={(v) => patch({ system: { ...config.system, trayIcon: v } })}
        />
        <Check
          label="창을 닫아도 트레이에 남기"
          hint="끄면 창을 닫는 순간 아바타도 같이 사라진다."
          checked={config.system.closeToTray}
          onChange={(v) => patch({ system: { ...config.system, closeToTray: v } })}
        />
      </Section>

      <Section title="Unity 셸">
        <Field
          label="플레이어 실행 파일 — 비워두면 Unity 셸을 띄우지 않는다"
          value={config.unity.playerPath}
          onCommit={(v) => patch({ unity: { ...config.unity, playerPath: v.trim() } })}
        />
        <Slider
          label="다시 살릴 횟수"
          hint="셸이 비정상 종료할 때 몇 번까지 다시 띄울지. 무한 재시작은 죽은 셸을 계속 되살리며 로그만 채운다."
          value={config.unity.maxRestarts}
          min={0}
          max={10}
          step={1}
          format={(v) => (v === 0 ? '다시 살리지 않음' : `${v}번`)}
          onChange={(v) => patch({ unity: { ...config.unity, maxRestarts: v } })}
        />
        <div style={S.hint}>
          플레이어를 직접 실행하면 바로 종료된다. 브리지 포트와 토큰을 환경변수로 받아야
          붙을 수 있고, 이건 의도된 동작이다 — 아무나 띄운 셸이 붙을 수 있으면 토큰이
          의미가 없다.
        </div>
        <div style={S.hint}>플레이어·재시작 횟수·Unity 존재감 설정은 앱을 다시 시작할 때 적용된다.</div>
      </Section>

      <Diagnose />
    </>
  )
}

/** 지금 무엇이 붙어 있는지. 안 될 때 어디부터 볼지 알려준다. */
function Diagnose(): React.JSX.Element {
  const [d, setD] = useState<Diagnostics | null>(null)
  const [restarting, setRestarting] = useState(false)
  const [restartError, setRestartError] = useState<string | null>(null)

  const reload = (): void => {
    void window.waifu.diagnostics().then(setD)
  }
  useEffect(reload, [])

  return (
    <Section title="지금 상태">
      {!d && <div style={S.hint}>아직 준비되지 않았다.</div>}
      {d && (
        <div style={{ ...S.hint, lineHeight: 1.8 }}>
          백엔드: {BACKEND_LABELS[d.backend]}
          {d.busy ? ' (작업 중)' : ''}
          <br />
          작업 폴더: {d.runtime?.cwd ?? '아직 적용되지 않음'}
          <br />
          권한: {d.runtime?.permissionMode ?? '아직 적용되지 않음'}
          <br />
          세션: {d.sessionId ?? '아직 없음 — 첫 대화에서 만들어진다'}
          <br />
          모션: {d.motions}개 · 진행 중 작업: {d.activeTasks}개 · 기억: {d.memories}개
        </div>
      )}
      {d?.backendRestartRequired && (
        <>
          <div style={{ ...S.warn, marginTop: '8px' }}>
            저장된 시작 설정이 현재 실행과 다르다. 작업이 없을 때 앱 전체를 다시 시작해야 한다.
          </div>
          <button
            style={{ ...S.ghost, marginTop: '8px' }}
            disabled={restarting || d.busy}
            onClick={() => {
              setRestarting(true)
              setRestartError(null)
              void window.waifu.restartApp().then((result) => {
                setRestarting(false)
                if (!result.ok) setRestartError(result.reason ?? '다시 시작하지 못했다.')
                reload()
              }, (err: unknown) => {
                setRestarting(false)
                setRestartError(String(err))
                reload()
              })
            }}
          >
            {restarting ? '앱을 다시 시작하는 중…' : '앱 다시 시작해 적용'}
          </button>
        </>
      )}
      {restartError && <div style={{ ...S.warn, marginTop: '8px' }}>{restartError}</div>}
      <button style={{ ...S.ghost, marginTop: '8px' }} onClick={reload}>
        새로고침
      </button>
    </Section>
  )
}
