import type { PresenceSettings } from '@shared/protocol'
import { Check, S, Section, Slider } from '../controls'
import type { TabProps } from '../Settings'

/**
 * "거기 살고 있는 것처럼 보이는" 설정들.
 *
 * 이 값들은 이미 config 에도 있고 Unity 셸까지 내려가고 있었지만 화면이 없었다 —
 * `waifu.config.json` 을 손으로 고치는 사람만 만질 수 있었다는 뜻이다.
 *
 * **전부 끌 수 있게 둔다.** 데스크탑에 상주하는 것이라 취향과 작업 방해 정도가
 * 사람마다 크게 갈리고, 끄는 길이 없으면 앱을 지우는 게 유일한 선택지가 된다.
 */
export function PresenceTab({ config, patch }: TabProps): React.JSX.Element {
  const presence = config.avatar.presence

  // 존재감 설정만 갈아끼운다. avatar 를 통째로 펼쳐 넘기지 않으면 main 의
  // 섹션 병합이 나머지 avatar 필드를 기본값으로 되돌린다.
  const set = (next: Partial<PresenceSettings>): void => {
    patch({ avatar: { ...config.avatar, presence: { ...presence, ...next } } })
  }

  const unity = config.avatar.renderer === 'unity'

  return (
    <>
      {!unity && (
        <div style={S.warn}>
          이 탭의 설정은 <b>Unity 셸</b>이 해석한다. 지금 렌더러는 &quot;내장&quot;이라
          바꿔도 화면에는 반영되지 않는다. 아바타 탭에서 렌더러를 Unity 로 바꿔라.
        </div>
      )}

      <Section title="가만히 있을 때">
        <Check
          label="여러 자세를 번갈아 취하기"
          hint="한 자세로 굳어 있으면 정지 화면처럼 보인다."
          checked={presence.idle.enabled}
          onChange={(v) => set({ idle: { ...presence.idle, enabled: v } })}
        />
        <Slider
          label="한 자세를 유지하는 최소 시간"
          value={presence.idle.minHoldSec}
          min={2}
          max={60}
          step={1}
          format={(v) => `${v}초`}
          onChange={(v) =>
            set({
              idle: {
                ...presence.idle,
                minHoldSec: v,
                // 최소가 최대를 넘으면 뽑을 구간이 없어져 전환이 멈춘다.
                maxHoldSec: Math.max(v, presence.idle.maxHoldSec)
              }
            })
          }
        />
        <Slider
          label="최대 시간"
          hint="이 사이에서 무작위로 뽑는다. 일정한 간격은 기계처럼 보인다."
          value={presence.idle.maxHoldSec}
          min={2}
          max={180}
          step={1}
          format={(v) => `${v}초`}
          onChange={(v) =>
            set({
              idle: { ...presence.idle, maxHoldSec: Math.max(v, presence.idle.minHoldSec) }
            })
          }
        />
      </Section>

      <Section title="커서 따라보기">
        <Check
          label="커서를 눈으로 좇기"
          checked={presence.tracking.enabled}
          onChange={(v) => set({ tracking: { ...presence.tracking, enabled: v } })}
        />
        <Slider
          label="눈"
          value={presence.tracking.eye}
          min={0}
          max={1}
          step={0.05}
          format={(v) => (v === 0 ? '안 봄' : `${Math.round(v * 100)}%`)}
          onChange={(v) => set({ tracking: { ...presence.tracking, eye: v } })}
        />
        <Slider
          label="고개"
          value={presence.tracking.head}
          min={0}
          max={1}
          step={0.05}
          format={(v) => (v === 0 ? '안 돌림' : `${Math.round(v * 100)}%`)}
          onChange={(v) => set({ tracking: { ...presence.tracking, head: v } })}
        />
        <Slider
          label="상체"
          hint="셋을 같은 세기로 두면 눈이 고개에 붙어 보인다. 눈 > 고개 > 상체 순으로 두는 게 자연스럽다."
          value={presence.tracking.body}
          min={0}
          max={1}
          step={0.05}
          format={(v) => (v === 0 ? '안 돌림' : `${Math.round(v * 100)}%`)}
          onChange={(v) => set({ tracking: { ...presence.tracking, body: v } })}
        />
      </Section>

      <Section title="건드렸을 때">
        <Check
          label="만지면 반응하기"
          hint="머리를 쓰다듬거나 찌르면 표정과 자세로 답한다."
          checked={presence.touch}
          onChange={(v) => set({ touch: v })}
        />
        <Check
          label="잡아 끌 때 전용 자세 쓰기"
          hint="끄면 하던 자세 그대로 끌려온다."
          checked={presence.dragMotion}
          onChange={(v) => set({ dragMotion: v })}
        />
        <Check
          label="끌 때 관성으로 몸이 기울기"
          hint="창을 채는 방향의 반대로 눕고, 팔다리가 한 박자 늦게 따라온다. 창에 앉아 있는 동안에는 흔들리지 않는다."
          checked={presence.dragSway.enabled}
          onChange={(v) => set({ dragSway: { ...presence.dragSway, enabled: v } })}
        />
        <Slider
          label="기우는 세기"
          value={presence.dragSway.strength}
          min={0}
          max={2}
          step={0.1}
          format={(v) => (v === 0 ? '없음' : `${v.toFixed(1)}배`)}
          onChange={(v) => set({ dragSway: { ...presence.dragSway, strength: v } })}
        />
        <Check
          label="화면 밖으로 나가지 않게 붙잡기"
          hint="투명하고 클릭이 통과하는 창이라, 화면 밖으로 나가면 되찾을 방법이 없다."
          checked={presence.clampToScreen}
          onChange={(v) => set({ clampToScreen: v })}
        />
      </Section>

      <Section title="창에 걸터앉기">
        <Check
          label="다른 창의 윗변에 앉히기"
          hint="잡아서 창 제목 표시줄 위로 가져가면 거기 걸터앉는다. 그냥 지나가는 것만으로는 붙지 않는다."
          checked={presence.windowSit.enabled}
          onChange={(v) => set({ windowSit: { ...presence.windowSit, enabled: v } })}
        />
        <Check
          label="작업표시줄에도 앉히기"
          hint="화면 아래에 붙어 있는 작업표시줄에만 해당한다. 자동 숨김이면 앉을 자리가 없다."
          checked={presence.windowSit.taskbar}
          onChange={(v) => set({ windowSit: { ...presence.windowSit, taskbar: v } })}
        />
        <div style={S.hint}>
          Windows 전용이다. 다른 OS 에서는 이 기능만 꺼지고 나머지는 그대로 동작한다.
        </div>
        <div style={S.hint}>
          앉을 자리를 찾느라 열린 창의 위치와 크기를 읽는다. 창 제목이나 프로그램 이름은
          읽지 않고, 읽은 것은 아바타 셸 밖으로 나가지 않는다 — 에이전트에게도 전달되지 않는다.
        </div>
      </Section>

      <Section title="혼자 돌아다니기">
        <Check
          label="가끔 화면 안에서 자리 옮기기"
          hint="작업표시줄과 커서 주변은 피한다. 말하는 중·끄는 중·앉은 중·자는 중에는 움직이지 않는다."
          checked={presence.roam.enabled}
          onChange={(v) => set({ roam: { ...presence.roam, enabled: v } })}
        />
        <Slider
          label="한 자리에 머무는 시간"
          hint="평균값이다. 실제 간격은 지수분포로 뽑아 대부분 이보다 짧고 가끔 훨씬 길다 — 일정한 간격은 기계처럼 보인다."
          value={presence.roam.meanDwellMin}
          min={0.5}
          max={30}
          step={0.5}
          format={(v) => (v < 1 ? `${Math.round(v * 60)}초` : `${v}분`)}
          onChange={(v) => set({ roam: { ...presence.roam, meanDwellMin: v } })}
        />
      </Section>

      <Section title="잠들기">
        <Check
          label="오래 두면 자기"
          checked={presence.sleep.enabled}
          onChange={(v) => set({ sleep: { ...presence.sleep, enabled: v } })}
        />
        <Slider
          label="이만큼 조용하면 잠든다"
          value={presence.sleep.afterIdleMin}
          min={1}
          max={120}
          step={1}
          format={(v) => `${v}분`}
          onChange={(v) => set({ sleep: { ...presence.sleep, afterIdleMin: v } })}
        />
        <Check
          label="시간대로도 재우기"
          hint="끄면 시각과 무관하게 유휴 시간만 본다."
          checked={presence.sleep.byClock}
          onChange={(v) => set({ sleep: { ...presence.sleep, byClock: v } })}
        />
        {presence.sleep.byClock && (
          <>
            <Slider
              label="자기 시작"
              value={presence.sleep.fromHour}
              min={0}
              max={23}
              step={1}
              format={(v) => `${v}시`}
              onChange={(v) => set({ sleep: { ...presence.sleep, fromHour: v } })}
            />
            <Slider
              label="일어나기"
              hint="자정을 넘기는 구간(23시 → 7시)도 된다."
              value={presence.sleep.toHour}
              min={0}
              max={23}
              step={1}
              format={(v) => `${v}시`}
              onChange={(v) => set({ sleep: { ...presence.sleep, toHour: v } })}
            />
          </>
        )}
      </Section>

      <Section title="화면 밝기에 맞춰 물들기">
        <Check
          label="데스크탑 색으로 아바타 조명 물들이기"
          hint="어두운 화면에서는 은은하게, 짙은 색 배경에서는 그 색으로 비춘다. 같은 화면 안에 있는 것처럼 보인다."
          checked={presence.ambientLight.enabled}
          onChange={(v) => set({ ambientLight: { ...presence.ambientLight, enabled: v } })}
        />
        <div style={S.warn}>
          켜면 화면 가장자리 색을 초당 몇 번 읽는다. 읽은 픽셀은 아바타 셸 밖으로 나가지
          않는다 — 에이전트에게도, 디스크에도 가지 않고, 화면을 160×90 으로 줄여 받아 네
          개의 평균 색으로 뭉갠 뒤 버린다. 그 크기에서는 글자를 읽을 수 없다. 그래도
          화면을 주기적으로 읽는 것은 사실이라 기본값은 꺼짐이다.
        </div>
        {presence.ambientLight.enabled && (
          <>
            <Slider
              label="읽는 빈도"
              hint="높이면 반응이 빠른 대신 CPU 를 계속 쓴다."
              value={presence.ambientLight.sampleHz}
              min={1}
              max={30}
              step={1}
              format={(v) => `초당 ${v}번`}
              onChange={(v) => set({ ambientLight: { ...presence.ambientLight, sampleHz: v } })}
            />
            <Slider
              label="물드는 속도"
              hint="낮으면 화면이 바뀔 때마다 조명이 번쩍인다."
              value={presence.ambientLight.smoothing}
              min={0}
              max={1}
              step={0.05}
              format={(v) => (v < 0.4 ? '빠르게' : v < 0.8 ? '보통' : '느리게')}
              onChange={(v) => set({ ambientLight: { ...presence.ambientLight, smoothing: v } })}
            />
          </>
        )}
      </Section>

      <Section title="모니터에 맞춘 크기">
        <Check
          label="모니터 해상도에 맞춰 크기 자동 보정"
          hint="4K 와 FHD 를 섞어 쓰면 한쪽에 맞춘 크기가 다른 쪽에서 어긋난다. 아바타가 있는 모니터를 보고 그때그때 맞춘다."
          checked={presence.autoScale.enabled}
          onChange={(v) => set({ autoScale: { ...presence.autoScale, enabled: v } })}
        />
        {presence.autoScale.enabled && (
          <>
            <Slider
              label="기준 세로 해상도"
              hint="이 해상도에서 아바타 탭의 '크기' 가 그대로 쓰인다. 평소 쓰는 모니터에 맞춰라."
              value={presence.autoScale.referenceHeight}
              min={720}
              max={2160}
              step={60}
              format={(v) => `${v}p`}
              onChange={(v) => set({ autoScale: { ...presence.autoScale, referenceHeight: v } })}
            />
            <Slider
              label="자동 보정 상한"
              hint="세로로 아주 긴 모니터에서 아바타가 화면을 덮지 않게 막는다."
              value={presence.autoScale.max}
              min={1}
              max={4}
              step={0.1}
              format={(v) => `${v.toFixed(1)}배`}
              onChange={(v) => set({ autoScale: { ...presence.autoScale, max: v } })}
            />
          </>
        )}
      </Section>

      <Section title="말풍선">
        <div style={S.warn}>
          Unity 셸에는 아직 말풍선을 그리는 UI 가 없다. 문구를 만드는 규칙(자르기·표시
          시간)까지만 동작하고 화면에는 나오지 않는다. 자막을 지금 보려면 아바타 탭에서
          렌더러를 &quot;내장&quot; 으로 두고 성격과 말 탭의 &quot;자막 보이기&quot; 를 쓴다.
        </div>
        <Check
          label="아바타 옆에 자막 띄우기"
          checked={presence.bubble.enabled}
          onChange={(v) => set({ bubble: { ...presence.bubble, enabled: v } })}
        />
        <Slider
          label="한 번에 보여줄 글자 수"
          hint="넘치면 잘라서 보여준다. 긴 답변이 화면을 덮는 것을 막는다."
          value={presence.bubble.maxChars}
          min={40}
          max={400}
          step={10}
          format={(v) => `${v}자`}
          onChange={(v) => set({ bubble: { ...presence.bubble, maxChars: v } })}
        />
      </Section>
    </>
  )
}
