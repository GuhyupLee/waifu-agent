using System.Collections.Generic;
using UnityEngine;

namespace WaifuAvatar.Avatar
{
    /// <summary>
    /// 재생 중인 모션 **위에** 숨쉬기·표류·머리 추적을 더한다.
    ///
    /// 대입이 아니라 곱셈(쿼터니언 누적)인 것이 핵심이다. 회전을 대입하면 그 프레임의
    /// 모션이 통째로 사라진다. 그래서 예전 구현은 "클립이 돌면 절차적 보정을 통째로
    /// 건너뛰기" 였고, 결과적으로 **모션 중에는 호흡이 멈춘 캐릭터**가 됐다.
    /// 사람은 걸으면서도 숨을 쉰다.
    ///
    /// **함정 — 오버레이는 누적된다.** 애니메이션이 트랙을 갖고 있지 않은 본
    /// (어깨는 VRMA 에 트랙이 없는 경우가 흔하다)은 매 프레임 우리 오프셋이 쌓인다.
    /// TypeScript 쪽 실측에서 1분에 척추가 1.96 rad(112°)까지 갔다. 몸이 접힌다.
    ///
    /// 그래서 <see cref="AddRotation"/> 은 지난 프레임에 남긴 값이 그대로면 먼저
    /// 걷어내고 새로 얹는다. 값이 달라졌다면 애니메이션이 덮어쓴 것이므로 그것을
    /// 새 기준으로 삼는다. `PoseOverlayTests` 가 이 규칙을 지킨다.
    /// </summary>
    public class PoseOverlay
    {
        struct State
        {
            /// <summary>오버레이를 얹기 **전** 값.</summary>
            public Quaternion Base;
            /// <summary>지난 프레임에 우리가 남긴 값. 그대로면 아무도 덮어쓰지 않았다.</summary>
            public Quaternion Applied;
            public bool HasApplied;
        }

        readonly Dictionary<Transform, State> _states = new Dictionary<Transform, State>();

        /// <summary>모델을 바꾸면 본이 통째로 사라진다. 남은 상태는 의미가 없다.</summary>
        public void Clear() => _states.Clear();

        /// <summary>
        /// 오버레이 회전을 더한다.
        ///
        /// 매 프레임 **모든 대상 본에 대해** 불러야 한다. 값이 0 이어도 건너뛰지 마라 —
        /// 지난 프레임에 얹은 오프셋을 걷어내는 것도 이 함수의 일이라, 건너뛰면
        /// 마지막 자세가 그대로 굳는다.
        /// </summary>
        public void AddRotation(Transform bone, Vector3 eulerRadians)
        {
            if (bone == null) return;

            var current = bone.localRotation;
            if (_states.TryGetValue(bone, out var state))
            {
                // 우리가 남긴 값 그대로면 아무도 안 건드렸다는 뜻이다. 걷어낸다.
                if (state.HasApplied && Approximately(current, state.Applied))
                {
                    current = state.Base;
                }
            }
            else
            {
                state = new State();
            }

            state.Base = current;
            var offset = Quaternion.Euler(
                eulerRadians.x * Mathf.Rad2Deg,
                eulerRadians.y * Mathf.Rad2Deg,
                eulerRadians.z * Mathf.Rad2Deg);
            var applied = current * offset;

            bone.localRotation = applied;
            state.Applied = applied;
            state.HasApplied = true;
            _states[bone] = state;
        }

        /// <summary>
        /// 쿼터니언 동일성. Unity 의 == 는 각도 오차 허용치가 커서(약 0.1도)
        /// 작은 오버레이를 "안 바뀐 것" 으로 읽는다. 성분으로 직접 비교한다.
        /// </summary>
        public static bool Approximately(Quaternion a, Quaternion b, float epsilon = 1e-6f)
        {
            return Mathf.Abs(a.x - b.x) < epsilon
                   && Mathf.Abs(a.y - b.y) < epsilon
                   && Mathf.Abs(a.z - b.z) < epsilon
                   && Mathf.Abs(a.w - b.w) < epsilon;
        }
    }

    /// <summary>
    /// 오버레이가 각 본에 넣을 값. 순수 계산이라 씬 없이 테스트한다.
    ///
    /// pose.ts 의 `applyLivelinessOverlay` 와 같은 배분이다. 두 렌더러가 같은
    /// 캐릭터로 보여야 하므로 계수를 임의로 바꾸지 마라.
    /// </summary>
    public struct OverlayInput
    {
        public float Elapsed;
        /// <summary>0..1. 모션이 크게 움직이는 동안에는 낮춰 저작된 동작을 방해하지 않는다.</summary>
        public float Weight;
        public float Yaw;
        public float Pitch;
        /// <summary>모션이 재생 중인가. 재생 중이면 머리 추적을 훨씬 약하게 얹는다.</summary>
        public bool MotionPlaying;
    }

    public struct OverlayRotations
    {
        public Vector3 Spine;
        public Vector3 Chest;
        public Vector3 LeftShoulder;
        public Vector3 RightShoulder;
        public Vector3 Neck;
        public Vector3 Head;
    }

    public static class OverlayMath
    {
        /// <summary>안정 호흡 한 번에 걸리는 시간(초). 분당 약 14회.</summary>
        public const float BreathPeriod = 4.2f;

        public static OverlayRotations Compute(OverlayInput input)
        {
            var weight = input.Weight;
            // 0..1 을 -0.5..0.5 로 옮겨 중립 자세를 기준으로 부풀렸다 꺼지게 한다.
            var breath = (Liveliness.BreathCurve(input.Elapsed / BreathPeriod) - 0.5f) * weight;
            // 사인 하나로 흔들면 메트로놈이 된다. 서로 안 나누어떨어지는 신호를 겹친다.
            var swayZ = Liveliness.Drift(input.Elapsed * 0.31f, 3f) * 0.016f * weight;
            var swayX = Liveliness.Drift(input.Elapsed * 0.24f, 7f) * 0.010f * weight;

            // 저작된 모션이 이미 고개를 쓰고 있을 수 있으므로 크게 얹지 않는다.
            // 그래도 0 으로 두면 모션 중에는 커서를 완전히 무시해서 남처럼 보인다.
            var track = input.MotionPlaying ? 0.35f * weight : 0f;

            return new OverlayRotations
            {
                Spine = new Vector3(breath * 0.020f + swayX * 0.4f, swayX * 0.5f, swayZ * 0.5f),
                Chest = new Vector3(breath * 0.014f, 0f, swayZ * 0.3f),
                // 들이쉬면 어깨가 조금 올라간다. 가슴만 움직이면 풍선처럼 보인다.
                LeftShoulder = new Vector3(0f, 0f, -breath * 0.030f),
                RightShoulder = new Vector3(0f, 0f, breath * 0.030f),
                Neck = new Vector3(input.Pitch * 0.35f * track, input.Yaw * 0.35f * track, 0f),
                Head = new Vector3(input.Pitch * 0.5f * track, input.Yaw * 0.5f * track, -swayZ * 0.6f)
            };
        }
    }
}
