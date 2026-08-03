using System;
using UnityEngine;

namespace WaifuAvatar.Window
{
    public struct RoamInput
    {
        public bool Enabled;

        /// <summary>
        /// 지금 움직이면 안 되는 상태인가 — 말하는 중, 끄는 중, 창에 앉은 중, 자는 중.
        ///
        /// 말하는 도중에 걸어가면 자막과 아바타가 따로 논다. 앉은 채 걸으면 창에서
        /// 미끄러진다. 끄는 중이면 사용자가 위치를 정하고 있는 것이다.
        /// </summary>
        public bool Busy;

        /// <summary>아바타 실루엣의 가로 범위(데스크탑 px). 창 사각형이 아니다.</summary>
        public float AvatarLeft;
        public float AvatarRight;

        /// <summary>걸어 다닐 수 있는 영역. 작업표시줄을 뺀 작업 영역을 준다.</summary>
        public Rect Bounds;

        /// <summary>커서(데스크탑 px). 사용자가 일하는 자리로는 걸어가지 않는다.</summary>
        public Vector2 Cursor;
    }

    public struct RoamPlan
    {
        public bool Moving;
        /// <summary>-1 왼쪽, +1 오른쪽, 0 제자리.</summary>
        public int Direction;
    }

    /// <summary>
    /// 같은 모니터 안에서 가끔 자리를 옮긴다.
    ///
    /// Mate-Engine X3.3.0 의 <c>AvatarLocomotionController</c> 에서 규칙 세 가지를
    /// 가져왔다. 그중 두 번째가 이 기능의 핵심이고, 없으면 눈에 띄게 어색하다:
    ///
    ///  1. 기본 idle 일 때만 걷는다. 다른 동작 중이면 즉시 멈추고 잠깐 쉰다.
    ///  2. **화면 경계를 창이 아니라 아바타 실루엣으로 잰다.** 투명 창은 아바타보다
    ///     훨씬 넓어서, 창 사각형으로 가두면 아바타가 화면 끝에서 한참 떨어진 곳에서
    ///     멈춘다. 반대로 창을 화면 안에만 두면 아바타는 화면 밖으로 나간다.
    ///  3. 가장자리에 가까우면 반대쪽을 고른다. 벽에 붙어 제자리걸음하지 않는다.
    ///
    /// 여기에 이 프로젝트가 요구하는 두 가지를 더했다:
    ///
    ///  - **머무는 시간은 지수분포다.** 상류는 균등분포 난수라 "규칙적으로 움직인다"가
    ///    남는다. 사람의 행동 간격은 지수분포에 가깝다 — 대부분 짧고 가끔 아주 길다.
    ///  - **커서 주변으로는 걸어가지 않는다.** 사용자가 일하고 있는 자리를 아바타가
    ///    가리면 그 순간 기능이 아니라 방해가 된다.
    ///
    /// 씬도 Win32 도 모른다. 창을 실제로 옮기는 일은 <see cref="Roamer"/> 가 한다.
    /// </summary>
    public class RoamPlanner
    {
        /// <summary>한 번 걸을 때 가는 거리(px).</summary>
        public float MinDistance = 120f;
        public float MaxDistance = 480f;

        /// <summary>머무는 시간의 평균(초). 지수분포라 대부분은 이보다 짧다.</summary>
        public float MeanDwellSec = 90f;

        /// <summary>이보다 자주는 움직이지 않는다(초). 지수분포의 짧은 꼬리를 자른다.</summary>
        public float MinDwellSec = 20f;

        /// <summary>초당 몇 px 걷나. 걷기 모션의 보폭과 대충 맞아야 발이 미끄러지지 않는다.</summary>
        public float SpeedPxPerSec = 90f;

        /// <summary>화면 가장자리에서 이 거리 안이면 반대쪽으로 돈다.</summary>
        public float EdgeMarginPx = 64f;

        /// <summary>커서 주변 이 거리 안으로는 들어가지 않는다.</summary>
        public float CursorMarginPx = 220f;

        readonly Func<float> _random;

        float _dwell;
        float _remaining;
        int _direction;

        public bool Moving => _remaining > 0f;
        public int Direction => _direction;

        /// <param name="random">0..1. 테스트에서 결정론적으로 넣기 위해 주입받는다.</param>
        public RoamPlanner(Func<float> random = null)
        {
            _random = random ?? (() => UnityEngine.Random.value);
            _dwell = MinDwellSec;
        }

        public RoamPlan Update(float delta, RoamInput input)
        {
            if (!input.Enabled || input.Busy)
            {
                // 멈출 때 남은 거리를 버린다. 되돌아오면 새로 정하는 게 자연스럽다 —
                // 말이 끝나자마자 하던 걸음을 마저 걷는 것은 로봇처럼 보인다.
                Stop();
                return Idle();
            }

            if (Moving) return Walk(delta, input);

            _dwell -= delta;
            if (_dwell > 0f) return Idle();

            Begin(input);
            return Moving ? new RoamPlan { Moving = true, Direction = _direction } : Idle();
        }

        void Begin(RoamInput input)
        {
            var direction = Choose(input);
            if (direction == 0)
            {
                // 갈 곳이 없다. 조금 뒤에 다시 본다 — 창이 닫히거나 커서가 비켜날 수 있다.
                _dwell = MinDwellSec;
                return;
            }

            _direction = direction;
            _remaining = Mathf.Lerp(MinDistance, MaxDistance, Unit());

            // 갈 수 있는 거리보다 더 가겠다고 하면 벽에 붙어 남은 시간을 낭비한다.
            var room = direction < 0
                ? input.AvatarLeft - input.Bounds.xMin
                : input.Bounds.xMax - input.AvatarRight;
            _remaining = Mathf.Min(_remaining, Mathf.Max(0f, room - EdgeMarginPx));
            if (_remaining <= 1f) Stop();
        }

        RoamPlan Walk(float delta, RoamInput input)
        {
            // 걷는 도중에도 벽과 커서를 본다. 창이 열리거나 사용자가 마우스를 옮기면
            // 출발할 때의 판단이 더 이상 맞지 않는다.
            if (!CanGo(input, _direction))
            {
                Stop();
                return Idle();
            }

            _remaining -= SpeedPxPerSec * delta;
            if (_remaining <= 0f)
            {
                Stop();
                return Idle();
            }

            return new RoamPlan { Moving = true, Direction = _direction };
        }

        /// <summary>
        /// 어느 쪽으로 갈까. 양쪽 다 막혔으면 0.
        ///
        /// 한쪽만 갈 수 있으면 고민하지 않는다. 둘 다 가능하면 무작위로 고르되,
        /// 가장자리에 가까운 쪽은 이미 <see cref="CanGo"/> 에서 걸러져 있다.
        /// </summary>
        int Choose(RoamInput input)
        {
            var left = CanGo(input, -1);
            var right = CanGo(input, 1);
            if (left && right) return Unit() < 0.5f ? -1 : 1;
            if (left) return -1;
            if (right) return 1;
            return 0;
        }

        bool CanGo(RoamInput input, int direction)
        {
            if (direction < 0)
            {
                if (input.AvatarLeft - input.Bounds.xMin <= EdgeMarginPx) return false;
            }
            else
            {
                if (input.Bounds.xMax - input.AvatarRight <= EdgeMarginPx) return false;
            }

            // 커서 쪽으로는 다가가지 않는다. 이미 커서 근처에 서 있다면 멀어지는
            // 방향은 허용해야 한다 — 아니면 커서 옆에 갇힌다.
            var center = (input.AvatarLeft + input.AvatarRight) * 0.5f;
            var toCursor = input.Cursor.x - center;
            var approaching = direction < 0 ? toCursor < 0f : toCursor > 0f;
            if (approaching && Mathf.Abs(toCursor) < CursorMarginPx) return false;

            return true;
        }

        void Stop()
        {
            _remaining = 0f;
            _direction = 0;
            _dwell = NextDwell();
        }

        /// <summary>
        /// 지수분포. 균등분포로 하면 "일정한 간격으로 움직인다"가 눈에 남는다.
        /// 짧은 쪽은 <see cref="MinDwellSec"/> 로 자른다 — 안 그러면 도착하자마자
        /// 다시 출발하는 경우가 생긴다.
        /// </summary>
        float NextDwell()
        {
            var u = Mathf.Clamp(Unit(), 1e-4f, 0.9999f);
            return MinDwellSec + -Mathf.Log(1f - u) * Mathf.Max(0.1f, MeanDwellSec);
        }

        float Unit() => Mathf.Clamp01(_random());

        static RoamPlan Idle() => new RoamPlan { Moving = false, Direction = 0 };
    }
}
