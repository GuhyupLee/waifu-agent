using UnityEngine;

namespace WaifuAvatar.Avatar
{
    /// <summary>
    /// 잡아 끄는 동안 몸이 관성으로 기우는 물리.
    ///
    /// 창을 오른쪽으로 채면 몸은 왼쪽으로 눕고, 멈추면 스프링으로 되돌아오며 살짝
    /// 지나친다. 팔다리는 몸통을 **반대 위상으로 뒤따른다** — 전부 같이 기울면
    /// 통짜 판때기를 기울인 것처럼 보이고, 그게 인형 같아 보이는 주된 이유다.
    ///
    /// Mate-Engine X3.3.0 의 <c>AvatarSwayController</c> 에서 신호 흐름
    /// (창 속도 → 저역통과 → 스프링 → 팔다리 지연 → 가중치 페이드)과 상한값을
    /// 가져왔다. 세 가지를 바꿨다:
    ///
    ///  - **속도를 초당 픽셀로 쓴다.** 상류는 프레임당 픽셀을 그대로 각도로 바꿔서,
    ///    같은 손놀림이 120Hz 에서는 절반만 기울어진다.
    ///  - **적분기를 우리 <see cref="Spring"/> 으로 바꿨다.** 상류는 명시적 오일러라
    ///    delta 가 튀면 발산한다. 절전 복귀와 창 드래그가 정확히 그 상황이다.
    ///  - **본에 직접 쓰지 않는다.** 상류는 localRotation 에 곱하고 다음 프레임에
    ///    역쿼터니언으로 걷어낸다. 우리는 <see cref="PoseOverlay"/> 가 그 일을
    ///    이미 하고 있어서, 여기서는 각도만 만들고 얹는 일은 그쪽에 맡긴다.
    ///
    /// 씬을 모르는 순수 클래스라 EditMode 에서 통째로 테스트한다.
    /// </summary>
    public class SwayModel
    {
        /// <summary>
        /// 초당 픽셀 -> 도.
        ///
        /// 상류 값은 "프레임당 픽셀 × 0.25도" 였다. 60Hz 기준으로 환산하면
        /// 60px/s 당 0.25도, 곧 0.00417 이다.
        /// </summary>
        public float HorizontalToLean = 0.00417f;
        public float VerticalToPitch = 0.0025f;

        /// <summary>기울기 상한(도). 넘어가면 사람이 아니라 고무 인형이 된다.</summary>
        public float MaxLeanZ = 25f;
        public float MaxLeanX = 12f;

        /// <summary>팔다리가 몸통을 뒤따르는 속도. 클수록 덜 늘어진다.</summary>
        public float LimbLag = 6f;

        /// <summary>효과가 실리는 속도(초당). 걷힐 때는 두 배로 쓴다.</summary>
        public float BlendSpeed = 8f;

        /// <summary>창 위치는 정수 픽셀이라 프레임마다 계단처럼 튄다. 그 계단을 눌러 준다.</summary>
        public float VelocitySmoothing = 12f;

        /// <summary>설정의 세기(0 이면 꺼짐). 상한도 같이 눌린다.</summary>
        public float Strength = 1f;

        readonly Spring _leanZ = new Spring(0f, 2.6f, 0.35f);
        readonly Spring _leanX = new Spring(0f, 2.6f, 0.35f);

        Vector2 _velocity;
        float _limbZ;
        float _limbX;
        float _weight;

        /// <summary>지금 효과가 얼마나 실려 있나(0..1). 테스트와 로그용.</summary>
        public float Weight => _weight;

        /// <param name="velocity">창이 움직인 속도(초당 데스크탑 픽셀, y 는 아래가 +).</param>
        /// <param name="active">끌고 있고 스웨이가 켜져 있나. 앉아 있는 동안은 false 다.</param>
        public void Update(Vector2 velocity, bool active, float delta)
        {
            if (delta <= 0f) return;

            var smoothing = 1f - Mathf.Exp(-VelocitySmoothing * delta);
            _velocity = Vector2.Lerp(_velocity, active ? velocity : Vector2.zero, smoothing);

            // 창이 오른쪽으로 가면 몸은 왼쪽으로 눕는다. 부호가 반대인 것이 관성이다.
            var targetZ = Mathf.Clamp(-_velocity.x * HorizontalToLean, -MaxLeanZ, MaxLeanZ);
            // 데스크탑 y 는 아래로 증가한다. 아래로 채면 몸이 뒤로 젖혀진다.
            var targetX = Mathf.Clamp(_velocity.y * VerticalToPitch, -MaxLeanX, MaxLeanX);

            _leanZ.Update(active ? targetZ : 0f, delta);
            _leanX.Update(active ? targetX : 0f, delta);

            var lag = 1f - Mathf.Exp(-LimbLag * delta);
            _limbZ = Mathf.Lerp(_limbZ, -_leanZ.Value, lag);
            _limbX = Mathf.Lerp(_limbX, -_leanX.Value, lag);

            // 놓을 때는 두 배로 빨리 걷어낸다. 실릴 때는 서서히여야 자연스럽지만,
            // 놓았는데 몸이 계속 기울어 있으면 "안 놓아진" 것처럼 보인다.
            var speed = active ? BlendSpeed : BlendSpeed * 2f;
            _weight = Mathf.MoveTowards(_weight, active ? 1f : 0f, speed * delta);
        }

        /// <summary>몸통에 얹을 회전(라디안). <see cref="PoseOverlay"/> 에 그대로 넘긴다.</summary>
        public Vector3 Hips => Scaled(_leanX.Value, _leanZ.Value);

        /// <summary>
        /// 팔에 얹을 회전(라디안). 몸통보다 작고 늦다.
        ///
        /// 계수 0.55/0.35 는 상류의 armsAdditive/legsAdditive 기본 상한
        /// (18°/8°, 12°/6°)을 몸통 상한(25°/12°)에 대한 비율로 옮긴 것이다.
        /// </summary>
        public Vector3 Arms => Scaled(_limbX * 0.66f, _limbZ * 0.72f);

        public Vector3 Legs => Scaled(_limbX * 0.5f, _limbZ * 0.48f);

        Vector3 Scaled(float pitchDegrees, float rollDegrees)
        {
            var k = _weight * Mathf.Max(0f, Strength) * Mathf.Deg2Rad;
            return new Vector3(pitchDegrees * k, 0f, rollDegrees * k);
        }

        /// <summary>절전 복귀. 몇 시간치 속도를 한 번에 적분하면 몸이 접힌다.</summary>
        public void Snap()
        {
            _velocity = Vector2.zero;
            _leanZ.Snap(0f);
            _leanX.Snap(0f);
            _limbZ = 0f;
            _limbX = 0f;
            _weight = 0f;
        }
    }
}
