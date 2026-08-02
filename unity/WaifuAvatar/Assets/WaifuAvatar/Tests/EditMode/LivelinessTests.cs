using System.Collections.Generic;
using NUnit.Framework;
using UnityEngine;
using WaifuAvatar.Avatar;

namespace WaifuAvatar.Tests
{
    /// <summary>
    /// liveliness.ts 이식이 충실한지 본다. `tests/liveliness.test.ts` 가 잠근 성질을
    /// 그대로 옮겼다 — **두 렌더러가 같은 캐릭터로 보여야 하기 때문이다.**
    ///
    /// 여기서 검사하는 것은 값이 아니라 **신호의 통계**다. "부드럽게 움직인다" 같은
    /// 것은 눈으로 봐야 하지만, "들숨이 날숨보다 짧다" 는 여기서 잠글 수 있다.
    /// </summary>
    public class SpringTests
    {
        [Test]
        public void 목표에_수렴한다()
        {
            var spring = new Spring();
            for (var i = 0; i < 300; i++) spring.Update(1f, 1f / 60f);
            Assert.That(spring.Value, Is.EqualTo(1f).Within(0.01f));
        }

        [Test]
        public void 감쇠가_약하면_지나쳤다_돌아온다()
        {
            // 오버슛은 속도 상태가 있어야만 나온다. 지수 감쇠로는 만들 수 없다.
            var spring = new Spring(0f, 2.2f, 0.35f);
            var peak = 0f;
            for (var i = 0; i < 300; i++) peak = Mathf.Max(peak, spring.Update(1f, 1f / 60f));
            Assert.Greater(peak, 1f);
        }

        [Test]
        public void 임계감쇠면_지나치지_않는다()
        {
            var spring = new Spring(0f, 2.2f, 1f);
            for (var i = 0; i < 300; i++)
            {
                Assert.LessOrEqual(spring.Update(1f, 1f / 60f), 1.0001f);
            }
        }

        [Test]
        public void 프레임이_크게_튀어도_발산하지_않는다()
        {
            // 절전 복귀나 창 드래그에서 delta 가 실제로 초 단위로 튄다.
            // 명시적 오일러였다면 여기서 폭발한다.
            var spring = new Spring();
            for (var i = 0; i < 50; i++)
            {
                var value = spring.Update(1f, 3.5f);
                Assert.IsFalse(float.IsNaN(value));
                Assert.Less(Mathf.Abs(value), 10f);
            }
        }

        [Test]
        public void delta_가_0_이면_아무_일도_없다()
        {
            var spring = new Spring(0.5f);
            Assert.AreEqual(0.5f, spring.Update(1f, 0f));
            Assert.AreEqual(0f, spring.Velocity);
        }

        [Test]
        public void snap_은_속도까지_버린다()
        {
            var spring = new Spring();
            for (var i = 0; i < 10; i++) spring.Update(1f, 1f / 60f);
            Assert.AreNotEqual(0f, spring.Velocity);

            spring.Snap(0f);
            Assert.AreEqual(0f, spring.Value);
            Assert.AreEqual(0f, spring.Velocity);
        }
    }

    public class DriftTests
    {
        [Test]
        public void 범위를_크게_벗어나지_않는다()
        {
            for (var t = 0f; t < 200f; t += 0.05f)
            {
                Assert.LessOrEqual(Mathf.Abs(Liveliness.Drift(t)), 1.2f);
            }
        }

        [Test]
        public void 짧은_주기로_반복하지_않는다()
        {
            // sin 하나면 주기가 눈에 보인다. 겹친 결과가 6.28초에 반복되면 안 된다.
            var a = Liveliness.Drift(0f);
            var b = Liveliness.Drift(2f * Mathf.PI);
            Assert.Greater(Mathf.Abs(a - b), 0.01f);
        }

        [Test]
        public void seed_가_다르면_다른_신호다()
        {
            Assert.Greater(Mathf.Abs(Liveliness.Drift(5f, 0f) - Liveliness.Drift(5f, 3f)), 0.01f);
        }
    }

    public class BreathTests
    {
        [Test]
        public void 범위_0_1_안에_있다()
        {
            for (var p = 0f; p < 3f; p += 0.01f)
            {
                var v = Liveliness.BreathCurve(p);
                Assert.GreaterOrEqual(v, -0.001f);
                Assert.LessOrEqual(v, 1.001f);
            }
        }

        [Test]
        public void 들숨이_날숨보다_짧다()
        {
            // 사인파는 5:5 라 기계로 부풀리는 느낌이 난다. 안정 호흡은 대략 4:6 이다.
            var rising = 0;
            var falling = 0;
            var previous = Liveliness.BreathCurve(0f);
            for (var p = 0.001f; p < 1f; p += 0.001f)
            {
                var v = Liveliness.BreathCurve(p);
                if (v > previous) rising++;
                else if (v < previous) falling++;
                previous = v;
            }
            Assert.Less(rising, falling);
        }

        [Test]
        public void 주기_경계에서_이어진다()
        {
            Assert.That(Liveliness.BreathCurve(0.999f), Is.EqualTo(Liveliness.BreathCurve(0f)).Within(0.01f));
        }

        [Test]
        public void 반복된다()
        {
            Assert.That(Liveliness.BreathCurve(0.3f), Is.EqualTo(Liveliness.BreathCurve(2.3f)).Within(1e-4f));
        }
    }

    public class BlinkTests
    {
        [Test]
        public void 감기가_뜨기보다_빠르다()
        {
            // 대칭 삼각형으로 만들면 눈이 아니라 셔터로 보인다.
            var shape = BlinkShape.Default;
            Assert.Less(shape.CloseSec, shape.OpenSec);
        }

        [Test]
        public void 완전히_감기고_완전히_뜬다()
        {
            var shape = BlinkShape.Default;
            Assert.AreEqual(0f, shape.Weight(0f));
            Assert.That(shape.Weight(shape.CloseSec + shape.HoldSec * 0.5f), Is.EqualTo(1f).Within(1e-4f));
            Assert.AreEqual(0f, shape.Weight(shape.Duration + 0.1f));
        }

        [Test]
        public void 범위_0_1_을_벗어나지_않는다()
        {
            var shape = BlinkShape.Default;
            for (var t = -0.1f; t < shape.Duration + 0.2f; t += 0.001f)
            {
                var w = shape.Weight(t);
                Assert.GreaterOrEqual(w, 0f);
                Assert.LessOrEqual(w, 1f);
            }
        }

        [Test]
        public void 한_번의_깜빡임이_0_3초를_넘지_않는다()
        {
            Assert.Less(BlinkShape.Default.Duration, 0.3f);
        }

        [Test]
        public void 간격은_최소값_아래로_내려가지_않는다()
        {
            for (var i = 0; i <= 100; i++)
            {
                Assert.GreaterOrEqual(Liveliness.ExponentialInterval(i / 100f, 3.5f, 1.1f), 1.1f);
            }
        }

        [Test]
        public void 짧은_간격이_긴_간격보다_흔하다()
        {
            // 균등분포면 "규칙적으로 깜빡인다" 는 인상이 남는다. 지수분포여야 한다.
            var short_ = 0;
            var long_ = 0;
            for (var i = 1; i < 1000; i++)
            {
                var v = Liveliness.ExponentialInterval(i / 1000f, 3.5f, 1.1f);
                if (v < 3.5f) short_++; else long_++;
            }
            Assert.Greater(short_, long_);
        }

        [Test]
        public void 가만두면_언젠가_깜빡인다()
        {
            var model = new BlinkModel(() => 0.5f);
            var maximum = 0f;
            for (var i = 0; i < 60 * 30; i++) maximum = Mathf.Max(maximum, model.Update(1f / 60f));
            Assert.Greater(maximum, 0.9f);
        }

        [Test]
        public void 큰_delta_가_들어와도_값이_0_1_이다()
        {
            var model = new BlinkModel(() => 0.5f);
            for (var i = 0; i < 100; i++)
            {
                var w = model.Update(2.5f);
                Assert.GreaterOrEqual(w, 0f);
                Assert.LessOrEqual(w, 1f);
            }
        }

        [Test]
        public void 시선_이동이_깜빡임을_앞당길_수_있다()
        {
            // random 이 0.2 미만이면 앞당긴다.
            var model = new BlinkModel(() => 0.05f);
            model.OnGazeShift();
            Assert.Greater(model.Update(1f / 60f), 0f);
        }

        [Test]
        public void 확률에_걸리지_않으면_앞당기지_않는다()
        {
            var model = new BlinkModel(() => 0.9f);
            model.OnGazeShift();
            Assert.AreEqual(0f, model.Update(1f / 60f));
        }
    }

    public class SaccadeTests
    {
        [Test]
        public void 작은_어긋남에는_눈을_움직이지_않는다()
        {
            // 매 프레임 도약하면 떨림이 된다.
            var model = new SaccadeModel(() => 0.5f);
            var result = model.Update(1f / 60f, new Vector2(0.02f, 0f));
            Assert.IsFalse(result.Jumped);
        }

        [Test]
        public void 큰_어긋남에는_도약한다()
        {
            var model = new SaccadeModel(() => 0.5f);
            Assert.IsTrue(model.Update(1f / 60f, new Vector2(0.8f, 0f)).Jumped);
        }

        [Test]
        public void 도약은_100ms_안에_끝난다()
        {
            // Carpenter 근사: 23ms + 2.7ms x 진폭(도). 30도라도 약 104ms 다.
            var model = new SaccadeModel(() => 0.5f);
            model.Update(1f / 60f, new Vector2(1f, 0f));

            var elapsed = 0f;
            for (var i = 0; i < 60; i++)
            {
                elapsed += 1f / 60f;
                var r = model.Update(1f / 60f, new Vector2(1f, 0f));
                if (Mathf.Abs(r.Gaze.x - 1f) < 0.01f) break;
            }
            Assert.Less(elapsed, 0.12f);
        }

        [Test]
        public void 연달아_도약하지_않는다()
        {
            // 사람은 초당 3~4회 이상 도약하지 않는다.
            var model = new SaccadeModel(() => 0.5f);
            var jumps = new List<float>();
            var t = 0f;
            var target = new Vector2(1f, 0f);

            for (var i = 0; i < 600; i++)
            {
                t += 1f / 60f;
                // 매 프레임 목표를 크게 흔들어도 도약 빈도가 제한돼야 한다.
                target = new Vector2(-target.x, target.y);
                if (model.Update(1f / 60f, target).Jumped) jumps.Add(t);
            }

            for (var i = 1; i < jumps.Count; i++)
            {
                Assert.GreaterOrEqual(jumps[i] - jumps[i - 1], 0.1f);
            }
        }

        [Test]
        public void snap_은_즉시_붙인다()
        {
            var model = new SaccadeModel(() => 0.5f);
            model.Snap(new Vector2(0.5f, -0.5f));
            var r = model.Update(1f / 60f, new Vector2(0.5f, -0.5f));
            Assert.That(r.Gaze.x, Is.EqualTo(0.5f).Within(0.02f));
            Assert.That(r.Gaze.y, Is.EqualTo(-0.5f).Within(0.02f));
        }
    }

    public class LoopVariationTests
    {
        [Test]
        public void 속도_흔들림이_6퍼센트_안이다()
        {
            // 넘기면 걷기 같은 클립에서 발이 미끄러지는 게 보인다.
            for (var i = 0; i <= 100; i++)
            {
                var (timeScale, _) = Liveliness.LoopVariation(i / 100f);
                Assert.GreaterOrEqual(timeScale, 0.94f);
                Assert.LessOrEqual(timeScale, 1.06f);
            }
        }
    }
}
