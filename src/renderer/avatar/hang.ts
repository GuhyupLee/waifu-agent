/**
 * 창을 잡아 끌 때 몸이 크레인에 매달린 것처럼 뒤따라 흔들리게 하는 물리.
 *
 * 머리 위 한 점(앵커)에 매달린 감쇠 진자로 푼다. 앵커가 가속하면 몸이 반대쪽으로
 * 밀리고, 멈추면 몇 번 흔들리다 잦아든다. 속도에 비례해 각도를 대입하는 식으로는
 * 이 "놓았을 때 흔들리는" 느낌이 안 나온다.
 *
 *   θ'' = -(g/L)·sin θ  -  c·θ'  -  (a/L)·cos θ
 *          ↑ 중력 복원      ↑ 감쇠    ↑ 앵커 가속의 관성
 */

/** 진자 길이(m). 짧을수록 빠르게 흔들린다. */
const LENGTH = 0.55
const GRAVITY = 9.8
/** 감쇠 계수. 낮추면 오래 흔들린다. */
const DAMPING = 3.2
/** 화면 픽셀 → 미터. 드래그 속도가 흔들림 크기에 얼마나 반영될지 정한다. */
const PX_TO_M = 0.006
/** 목이 꺾여 보이지 않도록 제한. */
const MAX_SWING = 0.5
/** 세로 흔들림(늘어났다 줄어드는 느낌)의 스프링 상수. */
const BOB_STIFFNESS = 90
const BOB_DAMPING = 9

export class HangPhysics {
  /** 좌우 스윙 각(라디안). */
  private angle = 0
  private angVel = 0
  /** 세로 출렁임(m). 아래가 양수. */
  private bob = 0
  private bobVel = 0

  /** 앵커의 속도(m/s). 가속도를 얻으려면 이전 값이 필요하다. */
  private vx = 0
  private vy = 0
  private grabbed = false

  get swing(): number {
    return this.angle
  }

  get droop(): number {
    return this.bob
  }

  /** 잡히는 순간 살짝 튀어오르게 해서 "들렸다"는 느낌을 준다. */
  grab(): void {
    this.grabbed = true
    this.bobVel -= 1.2
  }

  release(): void {
    this.grabbed = false
    // 놓으면 아래로 툭 떨어지는 반동.
    this.bobVel += 0.9
  }

  /** 이번 프레임의 앵커 이동량(화면 픽셀). 드래그 중이 아니면 0 을 넣는다. */
  push(dxPx: number, dyPx: number, delta: number): void {
    if (delta <= 0) return
    const nvx = (dxPx * PX_TO_M) / delta
    const nvy = (dyPx * PX_TO_M) / delta
    // 가속도는 속도 변화량이다. 등속으로 끌면 흔들리지 않고, 방향을 꺾을 때 흔들린다.
    this.ax = (nvx - this.vx) / delta
    this.ay = (nvy - this.vy) / delta
    this.vx = nvx
    this.vy = nvy
  }

  private ax = 0
  private ay = 0

  update(delta: number): void {
    // 물리는 큰 delta 에서 발산한다. 창 이동이나 절전 복귀로 프레임이 튀어도 안전하게 잘라둔다.
    const dt = Math.min(delta, 1 / 30)

    const angAcc =
      -(GRAVITY / LENGTH) * Math.sin(this.angle) -
      DAMPING * this.angVel -
      (this.ax / LENGTH) * Math.cos(this.angle)

    this.angVel += angAcc * dt
    this.angle += this.angVel * dt

    if (this.angle > MAX_SWING || this.angle < -MAX_SWING) {
      this.angle = Math.max(-MAX_SWING, Math.min(MAX_SWING, this.angle))
      // 한계에서는 속도를 죽여 벽에 붙어 떠는 현상을 막는다.
      this.angVel *= -0.3
    }

    // 세로는 단순 스프링. 잡고 있는 동안에는 위로 당겨진 상태를 평형점으로 삼는다.
    const rest = this.grabbed ? -0.03 : 0
    const bobAcc = -BOB_STIFFNESS * (this.bob - rest) - BOB_DAMPING * this.bobVel + this.ay * 0.4
    this.bobVel += bobAcc * dt
    this.bob += this.bobVel * dt

    // 다음 프레임에 push 가 없으면 가속도는 0 이다(등속 또는 정지).
    this.ax = 0
    this.ay = 0
    if (!this.grabbed) {
      this.vx = 0
      this.vy = 0
    }
  }
}
