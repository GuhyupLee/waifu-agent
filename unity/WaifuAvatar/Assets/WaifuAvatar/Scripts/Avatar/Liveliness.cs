using System;
using UnityEngine;

namespace WaifuAvatar.Avatar
{
    /// <summary>
    /// 살아있어 보이게 하는 것들. `src/renderer/avatar/liveliness.ts` 의 이식이다.
    ///
    /// 캐릭터가 인형처럼 보이는 이유는 대개 자세가 나빠서가 아니라 **움직임의 통계가
    /// 사람과 다르기** 때문이다. 완전 주기의 사인, 균등분포 난수, 대칭 이징 —
    /// 전부 자연에 없는 신호다. 여기 모인 것은 그 통계를 사람 쪽으로 옮기는 도구다.
    ///
    /// **상수를 임의로 바꾸지 마라.** 각 값에는 근거가 붙어 있고, TypeScript 쪽과
    /// 같은 값을 유지해야 두 렌더러가 같은 캐릭터로 보인다.
    ///
    /// 전부 Unity 컴포넌트가 아닌 순수 클래스로 두어 EditMode 에서 테스트한다.
    /// </summary>

    /// <summary>
    /// 속도를 가진 2차 스프링.
    ///
    /// 지수 감쇠에는 속도 상태가 없다. 목표가 갑자기 바뀌면 가속도가 무한대라 관성도
    /// 오버슛도 만들 수 없다 — 늘 "부드럽게 미끄러지는" 느낌만 난다. 사람 머리는
    /// 빠르게 돌면 살짝 지나쳤다 돌아온다. 그건 속도가 있어야 나온다.
    ///
    /// 적분은 음함수 오일러다. 명시적 오일러는 프레임이 튀면 발산하는데,
    /// 창을 드래그하거나 절전에서 깨어나면 delta 가 실제로 튄다.
    /// </summary>
    public class Spring
    {
        public float Value;
        public float Velocity;

        readonly float _frequency;
        readonly float _damping;

        /// <param name="frequency">초당 진동수(Hz). 클수록 빨리 붙는다.</param>
        /// <param name="damping">1 이면 임계감쇠. 0.7 근처면 살짝 지나쳤다 돌아온다.</param>
        public Spring(float value = 0f, float frequency = 2.2f, float damping = 0.78f)
        {
            Value = value;
            _frequency = frequency;
            _damping = damping;
        }

        public float Update(float target, float delta)
        {
            if (delta <= 0f) return Value;

            var omega = 2f * Mathf.PI * _frequency;
            var f = 1f + 2f * delta * _damping * omega;
            var oo = omega * omega;
            var detInv = 1f / (f + delta * delta * oo);

            Velocity = (Velocity + delta * oo * (target - Value)) * detInv;
            Value += delta * Velocity;
            return Value;
        }

        /// <summary>절전 복귀처럼 시간이 크게 건너뛴 뒤에는 속도를 버리고 목표에 붙인다.</summary>
        public void Snap(float value)
        {
            Value = value;
            Velocity = 0f;
        }
    }

    public static class Liveliness
    {
        /// <summary>
        /// 서로 나누어떨어지지 않는 사인의 합.
        ///
        /// sin(t) 하나면 주기가 눈에 보인다. 무리수에 가까운 비율로 셋을 겹치면
        /// 실질적으로 반복되지 않으면서도 부드럽다. 펄린 노이즈를 넣을 만큼의 값이 아니다.
        /// </summary>
        /// <returns>대략 -1..1</returns>
        public static float Drift(float t, float seed = 0f)
        {
            return (Mathf.Sin(t * 0.71f + seed * 1.7f) * 0.6f +
                    Mathf.Sin(t * 1.13f + seed * 3.1f) * 0.3f +
                    Mathf.Sin(t * 2.39f + seed * 5.9f) * 0.1f) / 0.85f;
        }

        /// <summary>
        /// 들숨보다 날숨이 길다.
        ///
        /// 안정 호흡의 들숨:날숨은 대략 4:6 이다. 사인파는 5:5 라서, 조용히 보고 있으면
        /// "기계로 부풀리는" 느낌이 난다. 한쪽을 시간축에서 압축해 비대칭으로 만든다.
        /// </summary>
        /// <returns>0(다 내쉼) .. 1(다 들이쉼)</returns>
        public static float BreathCurve(float phase)
        {
            var p = phase - Mathf.Floor(phase);
            const float inhale = 0.4f;
            if (p < inhale)
            {
                // 들숨은 짧고 빠르다.
                return 0.5f - 0.5f * Mathf.Cos(p / inhale * Mathf.PI);
            }
            return 0.5f + 0.5f * Mathf.Cos((p - inhale) / (1f - inhale) * Mathf.PI);
        }

        /// <summary>
        /// 같은 idle 클립을 매번 정확히 같은 속도·위상으로 재생하면 몇 번만 봐도 루프가
        /// 보인다. 속도를 몇 퍼센트 흔들고 시작 위상을 옮기면 같은 클립이 매번 다르게 읽힌다.
        /// </summary>
        public static (float timeScale, float phase) LoopVariation(float random)
        {
            var u = Mathf.Clamp(random, 0f, 0.999999f);
            // ±6% 를 넘기면 걷기 같은 클립에서 발이 미끄러지는 게 보인다.
            return (0.94f + u * 0.12f, u);
        }

        /// <summary>루프 클립의 재생 시간을 프레임 delta만큼 전진시키고 길이 안으로 감싼다.</summary>
        public static float LoopTime(float current, float delta, float timeScale, float duration)
        {
            if (duration <= 0f || float.IsNaN(duration) || float.IsInfinity(duration)) return 0f;
            var next = current + Mathf.Max(0f, delta) * Mathf.Max(0f, timeScale);
            next %= duration;
            if (next < 0f) next += duration;
            return next;
        }

        /// <summary>원샷 클립은 끝에서 감지 않고 멈추며, 끝에 닿았는지도 함께 돌려준다.</summary>
        public static float OneShotTime(
            float current,
            float delta,
            float timeScale,
            float duration,
            out bool finished)
        {
            if (duration <= 0f || float.IsNaN(duration) || float.IsInfinity(duration))
            {
                finished = true;
                return 0f;
            }

            var next = current + Mathf.Max(0f, delta) * Mathf.Max(0f, timeScale);
            finished = next >= duration;
            return Mathf.Clamp(next, 0f, duration);
        }

        /// <summary>
        /// 다음 사건까지의 간격을 지수분포로 뽑는다.
        ///
        /// 균등분포를 쓰면 "규칙적으로 일어난다" 는 인상이 남는다. 실제 간격은 대개
        /// 짧고 가끔 아주 길다. 깜빡임과 idle 전환이 같은 이유로 이걸 쓴다.
        /// </summary>
        public static float ExponentialInterval(float random, float meanSec, float minSec)
        {
            var u = Mathf.Clamp(random, 1e-6f, 0.999999f);
            return minSec + -Mathf.Log(1f - u) * (meanSec - minSec);
        }
    }

    public struct BlinkShape
    {
        /// <summary>감는 데 걸리는 시간(초). 뜨는 것보다 훨씬 빠르다.</summary>
        public float CloseSec;
        /// <summary>완전히 감은 채로 머무는 시간(초).</summary>
        public float HoldSec;
        /// <summary>뜨는 데 걸리는 시간(초).</summary>
        public float OpenSec;

        /// <summary>
        /// 감는 건 빠르고 뜨는 건 느리다. 대칭 삼각형으로 만들면 눈이 아니라 셔터로 보인다.
        /// 실측 문헌의 대략치(감기 ~70ms, 뜨기 ~150ms)를 따른다.
        /// </summary>
        public static BlinkShape Default => new BlinkShape { CloseSec = 0.07f, HoldSec = 0.02f, OpenSec = 0.15f };

        public float Duration => CloseSec + HoldSec + OpenSec;

        /// <summary>깜빡임 진행 시간 -> 눈꺼풀 닫힘 정도. 0(뜬 눈) .. 1(감은 눈)</summary>
        public float Weight(float t)
        {
            if (t <= 0f) return 0f;
            if (t < CloseSec)
            {
                // 감을 때는 가속한다. 눈꺼풀은 근육이 아니라 이완으로 떨어진다.
                var p = t / CloseSec;
                return p * p;
            }
            var held = t - CloseSec;
            if (held < HoldSec) return 1f;
            var opening = held - HoldSec;
            if (opening >= OpenSec) return 0f;
            // 뜰 때는 감속한다. 끝에서 천천히 멈춰야 눈꺼풀에 무게가 있어 보인다.
            var q = opening / OpenSec;
            return 1f - q * (2f - q);
        }
    }

    /// <summary>
    /// 깜빡임 스케줄러.
    ///
    /// 시간만으로 돌지 않는다. 큰 시선 이동은 깜빡임을 부르고(약 20%), 사람은 이따금
    /// 두 번 연달아 깜빡인다. 이 두 가지가 "타이머로 깜빡인다" 는 인상을 지운다.
    /// </summary>
    public class BlinkModel
    {
        readonly Func<float> _random;
        readonly BlinkShape _shape;
        float _remaining;
        float _elapsedInBlink = -1f;
        int _queued;

        public BlinkModel(Func<float> random = null, BlinkShape? shape = null)
        {
            _random = random ?? (() => UnityEngine.Random.value);
            _shape = shape ?? BlinkShape.Default;
            _remaining = Liveliness.ExponentialInterval(_random(), 3.5f, 1.1f);
        }

        /// <summary>큰 시선 이동이 일어났음을 알린다. 확률적으로 깜빡임을 앞당긴다.</summary>
        public void OnGazeShift()
        {
            if (_elapsedInBlink >= 0f) return;
            if (_random() < 0.2f) _remaining = 0f;
        }

        /// <returns>이번 프레임의 눈꺼풀 닫힘 정도 0..1</returns>
        public float Update(float delta)
        {
            if (_elapsedInBlink >= 0f)
            {
                _elapsedInBlink += delta;
                if (_elapsedInBlink >= _shape.Duration)
                {
                    _elapsedInBlink = -1f;
                    if (_queued > 0)
                    {
                        _queued -= 1;
                        // 연속 깜빡임은 간격이 짧다. 정상 간격을 다시 뽑으면 두 번처럼 안 보인다.
                        _remaining = 0.09f + _random() * 0.12f;
                    }
                    else
                    {
                        _remaining = Liveliness.ExponentialInterval(_random(), 3.5f, 1.1f);
                        // 이따금 두 번 연달아 깜빡인다.
                        if (_random() < 0.14f) _queued = 1;
                    }
                    return 0f;
                }
                return _shape.Weight(_elapsedInBlink);
            }

            _remaining -= delta;
            if (_remaining > 0f) return 0f;

            // 문턱을 넘고 남은 시간을 그대로 이어받는다. 0 부터 시작하면 프레임마다
            // 조금씩 늦어지고, 시선 이동으로 즉시 깜빡이라고 해도 한 프레임 비어 보인다.
            _elapsedInBlink = Mathf.Min(-_remaining, _shape.Duration);
            return _shape.Weight(_elapsedInBlink);
        }
    }

    public struct SaccadeResult
    {
        public Vector2 Gaze;
        /// <summary>이번 프레임에 도약이 시작됐다. 깜빡임 트리거로 쓴다.</summary>
        public bool Jumped;
    }

    /// <summary>
    /// 눈은 미끄러지지 않는다.
    ///
    /// 커서를 부드럽게 lerp 로 따라가게 하면 사람 눈이 아니라 감시 카메라가 된다.
    /// 실제 눈은 **고정 -> 도약 -> 고정** 을 반복한다. 도약은 30~80ms 안에 끝나고,
    /// 그 사이 시각은 사실상 꺼져 있다.
    ///
    /// 도약 시간은 Carpenter 의 선형 근사를 쓴다: 23ms + 2.7ms × 진폭(도).
    /// 고정 중에도 미세 표류가 있어 완전히 멈추지 않는다 — 멈추면 그림처럼 보인다.
    /// </summary>
    public class SaccadeModel
    {
        readonly Func<float> _random;
        readonly float _degreesPerUnit;

        Vector2 _current;
        Vector2 _from;
        Vector2 _to;
        float _t;
        float _duration;
        bool _moving;
        /// <summary>목표가 움직인 뒤 반응까지의 지연. 즉시 따라가면 기계처럼 보인다.</summary>
        float _latency;
        float _elapsed;

        /// <param name="degreesPerUnit">정규화 좌표 1.0 을 몇 도로 볼지. 도약 시간 계산에만 쓴다.</param>
        public SaccadeModel(Func<float> random = null, float degreesPerUnit = 30f)
        {
            _random = random ?? (() => UnityEngine.Random.value);
            _degreesPerUnit = degreesPerUnit;
        }

        /// <param name="target">정규화된 응시 목표(-1..1)</param>
        public SaccadeResult Update(float delta, Vector2 target)
        {
            _elapsed += delta;
            var jumped = false;

            if (_moving)
            {
                _t += delta;
                var p = _duration > 0f ? Mathf.Min(1f, _t / _duration) : 1f;
                // 도약은 거의 등속으로 끝난다. 양 끝만 살짝 둥글린다.
                var ease = p * p * (3f - 2f * p);
                _current = Vector2.LerpUnclamped(_from, _to, ease);
                if (p >= 1f) _moving = false;
            }
            else
            {
                _latency -= delta;
                var dist = Vector2.Distance(target, _current);

                // 이보다 작은 어긋남은 눈을 움직이지 않는다. 매 프레임 도약하면 떨림이 된다.
                const float threshold = 0.05f;
                if (dist > threshold && _latency <= 0f)
                {
                    _from = _current;
                    _to = target;
                    _duration = 0.023f + 0.0027f * (dist * _degreesPerUnit);
                    _t = 0f;
                    _moving = true;
                    jumped = true;
                    // 다음 도약까지의 최소 간격. 사람은 초당 3~4회 이상 도약하지 않는다.
                    _latency = 0.12f + _random() * 0.18f;
                }
            }

            // 고정 중에도 눈은 완전히 멈추지 않는다. 아주 작은 표류를 얹는다.
            var micro = _moving ? 0f : 0.006f;
            return new SaccadeResult
            {
                Gaze = new Vector2(
                    _current.x + Liveliness.Drift(_elapsed * 2.3f, 11f) * micro,
                    _current.y + Liveliness.Drift(_elapsed * 2.1f, 29f) * micro),
                Jumped = jumped
            };
        }

        public void Snap(Vector2 target)
        {
            _current = target;
            _moving = false;
            _latency = 0f;
        }
    }
}
