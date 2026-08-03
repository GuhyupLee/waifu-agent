import type { WaifuConfig } from '@shared/protocol'

/**
 * 명령 없이도 스스로 움직이게 하는 판단.
 *
 * 아바타가 부를 때만 반응하면 "떠 있는 UI" 지 "살아 있는 것" 이 아니다.
 * 다만 자율 행동은 잘못 만들면 성가신 물건이 된다 — 작업 중에 화면을 가로지르거나
 * 5초마다 뭔가 하면 그 뒤로는 꺼버리게 된다.
 *
 * 그래서 규칙을 이렇게 잡는다:
 *  - **조용할 때만.** 대화 중이거나 작업 중이면 아무것도 하지 않는다.
 *  - **가끔.** 간격을 넓게 두고, 매번 다르게 한다.
 *  - **말은 하지 않는다.** 먼저 말을 거는 건 알림의 몫이고, 그건 방해 금지 시간을 지킨다.
 *    여기서 하는 건 몸짓과 위치 이동뿐이다.
 */

export type IdleAction =
  /** 제자리에서 뭔가 한다. 둘러보기·기지개 같은 것. */
  | { kind: 'gesture'; motion: string }
  /** 커서가 있는 화면으로 옮겨간다. */
  | { kind: 'follow' }
  /** 아무것도 하지 않는다. */
  | { kind: 'none' }

export interface IdleContext {
  /** 마지막으로 사용자와 주고받은 뒤 흐른 시간(ms). */
  idleMs: number
  /** 에이전트가 턴을 돌고 있는지. */
  busy: boolean
  /** 사용자가 아바타를 잡고 있는지. */
  dragging: boolean
  /** 커서가 아바타가 있는 화면과 다른 화면에 있는지. */
  cursorOnOtherDisplay: boolean
  /** 지금 재생 가능한 몸짓. */
  motions: readonly string[]
}

/** 이보다 조용해야 스스로 움직인다. 대화 직후에 딴짓하면 무시당하는 느낌을 준다. */
export const IDLE_THRESHOLD_MS = 90_000

/**
 * 다음 자율 행동까지의 간격.
 *
 * 고정 간격이면 시계처럼 규칙적이라 기계처럼 보인다. 범위 안에서 흩뿌린다.
 */
export function nextIdleDelayMs(random: number): number {
  const MIN = 45_000
  const MAX = 180_000
  return Math.round(MIN + (MAX - MIN) * random)
}

/**
 * 지금 무엇을 할지 정한다.
 *
 * 커서가 다른 화면으로 넘어가 있으면 따라가는 쪽을 크게 우선한다 —
 * 사용자가 있는 곳에 있는 게 가장 "살아 있는" 행동이다.
 */
export function decideIdleAction(ctx: IdleContext, random: number): IdleAction {
  // 일하는 중이거나 잡혀 있으면 끼어들지 않는다.
  if (ctx.busy || ctx.dragging) return { kind: 'none' }
  if (ctx.idleMs < IDLE_THRESHOLD_MS) return { kind: 'none' }

  if (ctx.cursorOnOtherDisplay) {
    // 매번 따라가면 화면을 오가느라 정신없다. 절반 정도만.
    return random < 0.5 ? { kind: 'follow' } : { kind: 'none' }
  }

  const gestures = ctx.motions.filter((m) => IDLE_GESTURES.includes(m))
  if (gestures.length === 0) return { kind: 'none' }

  // 나머지 확률은 아무것도 하지 않는 데 쓴다. 늘 뭔가 하면 산만하다.
  const ACT_CHANCE = 0.6
  if (random > ACT_CHANCE) return { kind: 'none' }

  // 게이트를 통과한 난수는 [0, ACT_CHANCE] 안에만 있다. 그 사실을 무시하고
  // 원래 범위인 것처럼 쓰면 뒤쪽 몸짓에 확률이 몰린다 — 실제로 마지막 하나가
  // 25%, 나머지는 각 8% 였다. 살아남은 구간을 다시 [0,1) 로 펴서 고르게 만든다.
  const unit = Math.min(0.999999, random / ACT_CHANCE)
  const index = Math.min(gestures.length - 1, Math.floor(unit * gestures.length))
  return { kind: 'gesture', motion: gestures[index]! }
}

/**
 * 혼자 있을 때 해도 자연스러운 몸짓.
 *
 * 인사·박수처럼 상대가 있어야 말이 되는 것과, 화내기·슬퍼하기처럼 이유 없이 하면
 * 이상한 것은 뺐다. 자율 행동은 "심심해 보이는" 정도여야 한다.
 */
export const IDLE_GESTURES: readonly string[] = [
  'look-around',
  'stretch',
  'yawn',
  'curious-head-tilt',
  'idle-curious',
  'idle-shy',
  'idle-proud',
  'idle-impatient',
  'relax',
  'sleepy'
]

/**
 * 자율 행동을 켤지. **설정 하나만 본다.**
 *
 * 예전 주석은 "조용한 시간을 함께 본다" 고 했지만 그런 코드는 여기에도 호출부에도
 * 없다. 조용한 시간(`isQuiet`)은 알림·리마인더 경로만 본다 — 유휴 몸짓은 소리를
 * 내지 않으므로 시간대로 막을 이유가 없다.
 */
export function autonomyEnabled(config: WaifuConfig): boolean {
  return config.avatar.ambientMotion
}
