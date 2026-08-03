using System.Collections.Generic;
using NUnit.Framework;
using UnityEngine;
using WaifuAvatar.Window;

namespace WaifuAvatar.Tests
{
    /// <summary>
    /// 화면 안 배회. 여기서 잡는 것은 "언제 움직이지 **않는가**" 다 —
    /// 아바타가 혼자 걸어 다니는 기능은 멈춰야 할 때 안 멈추면 곧바로 방해가 된다.
    /// </summary>
    public class RoamPlannerTests
    {
        static Rect Screen => new Rect(0f, 0f, 1920f, 1032f);

        /// <summary>난수를 정해진 순서로 뱉는다. 다 쓰면 마지막 값을 되풀이한다.</summary>
        static System.Func<float> Sequence(params float[] values)
        {
            var queue = new Queue<float>(values);
            var last = values.Length > 0 ? values[values.Length - 1] : 0.5f;
            return () =>
            {
                if (queue.Count == 0) return last;
                last = queue.Dequeue();
                return last;
            };
        }

        static RoamInput At(float left, float right, bool busy = false, Vector2? cursor = null)
        {
            return new RoamInput
            {
                Enabled = true,
                Busy = busy,
                AvatarLeft = left,
                AvatarRight = right,
                Bounds = Screen,
                // 기본 커서는 화면 밖 멀리 둔다. 커서 회피가 다른 테스트를 오염시키지 않게.
                Cursor = cursor ?? new Vector2(-5000f, 0f),
            };
        }

        /// <summary>머무는 시간을 소진해 다음 결정을 강제한다.</summary>
        static RoamPlan Wait(RoamPlanner planner, RoamInput input, float seconds = 600f)
        {
            return planner.Update(seconds, input);
        }

        [Test]
        public void 가만히_있다가_결국_움직인다()
        {
            var planner = new RoamPlanner(Sequence(0.5f, 0.5f));

            var immediate = planner.Update(0.016f, At(900f, 1020f));
            Assert.IsFalse(immediate.Moving);

            var later = Wait(planner, At(900f, 1020f));
            Assert.IsTrue(later.Moving);
            Assert.AreNotEqual(0, later.Direction);
        }

        [Test]
        public void 바쁘면_즉시_멈춘다()
        {
            var planner = new RoamPlanner(Sequence(0.5f, 0.5f));
            Assert.IsTrue(Wait(planner, At(900f, 1020f)).Moving);

            var stopped = planner.Update(0.016f, At(900f, 1020f, busy: true));

            Assert.IsFalse(stopped.Moving);
            Assert.AreEqual(0, stopped.Direction);
        }

        [Test]
        public void 꺼져_있으면_움직이지_않는다()
        {
            var planner = new RoamPlanner(Sequence(0.5f, 0.5f));
            var input = At(900f, 1020f);
            input.Enabled = false;

            Assert.IsFalse(Wait(planner, input).Moving);
        }

        /// <summary>
        /// 왼쪽 벽에 붙어 있으면 오른쪽으로만 간다. 난수가 왼쪽을 골라도 마찬가지다.
        /// </summary>
        [Test]
        public void 왼쪽_끝에서는_오른쪽으로만_간다()
        {
            // 첫 값 0.1 은 "왼쪽" 을 고르는 값이다 — 그래도 왼쪽은 막혀 있어야 한다.
            var planner = new RoamPlanner(Sequence(0.1f, 0.5f));

            var plan = Wait(planner, At(10f, 130f));

            Assert.IsTrue(plan.Moving);
            Assert.AreEqual(1, plan.Direction);
        }

        [Test]
        public void 오른쪽_끝에서는_왼쪽으로만_간다()
        {
            var planner = new RoamPlanner(Sequence(0.9f, 0.5f));

            var plan = Wait(planner, At(1790f, 1910f));

            Assert.IsTrue(plan.Moving);
            Assert.AreEqual(-1, plan.Direction);
        }

        /// <summary>
        /// 창이 화면보다 넓은 구성이면 양쪽 다 막힌다. 그때 억지로 걷게 하면
        /// 벽에 붙어 제자리걸음한다.
        /// </summary>
        [Test]
        public void 양쪽_다_막히면_움직이지_않는다()
        {
            var planner = new RoamPlanner(Sequence(0.5f));
            var input = At(10f, 1910f);

            Assert.IsFalse(Wait(planner, input).Moving);
        }

        /// <summary>사용자가 일하고 있는 자리로는 다가가지 않는다.</summary>
        [Test]
        public void 커서_쪽으로는_가지_않는다()
        {
            var planner = new RoamPlanner(Sequence(0.5f, 0.5f));
            // 커서가 아바타 바로 오른쪽에 있다.
            var plan = Wait(planner, At(900f, 1020f, cursor: new Vector2(1050f, 500f)));

            Assert.IsTrue(plan.Moving);
            Assert.AreEqual(-1, plan.Direction);
        }

        /// <summary>
        /// 이미 커서 옆에 서 있어도 **멀어지는** 방향은 열려 있어야 한다.
        /// 아니면 커서 옆에 갇혀 영영 못 움직인다.
        /// </summary>
        [Test]
        public void 커서_옆에_있어도_멀어질_수는_있다()
        {
            var planner = new RoamPlanner(Sequence(0.5f, 0.5f));
            var plan = Wait(planner, At(900f, 1020f, cursor: new Vector2(960f, 500f)));

            Assert.IsTrue(plan.Moving);
        }

        /// <summary>걷는 도중에 커서가 앞을 막으면 멈춘다. 출발할 때의 판단이 만료된다.</summary>
        [Test]
        public void 걷는_도중_커서가_막으면_멈춘다()
        {
            var planner = new RoamPlanner(Sequence(0.9f, 1f));
            var plan = Wait(planner, At(400f, 520f));
            Assert.IsTrue(plan.Moving);
            Assert.AreEqual(1, plan.Direction);

            var blocked = planner.Update(0.016f, At(400f, 520f, cursor: new Vector2(600f, 500f)));

            Assert.IsFalse(blocked.Moving);
        }

        /// <summary>
        /// 도착하면 멈추고 다시 머문다. 계속 걸으면 화면을 왕복하는 스크린세이버가 된다.
        /// </summary>
        [Test]
        public void 정해진_거리를_가면_멈춘다()
        {
            // 두 번째 난수 0 -> 최소 거리(120px). 90px/s 이므로 2초면 넘는다.
            var planner = new RoamPlanner(Sequence(0.5f, 0f));
            Assert.IsTrue(Wait(planner, At(900f, 1020f)).Moving);

            for (var i = 0; i < 200; i++) planner.Update(0.016f, At(900f, 1020f));

            Assert.IsFalse(planner.Moving);
        }

        /// <summary>
        /// 벽까지 남은 거리보다 멀리 가겠다고 하면 그만큼 잘라야 한다.
        /// 안 그러면 벽에 붙은 채 남은 시간을 제자리걸음으로 쓴다.
        /// </summary>
        [Test]
        public void 벽까지_남은_거리를_넘겨_계획하지_않는다()
        {
            // 최대 거리(480px)를 요구하지만 오른쪽 벽까지 200px 뿐이다.
            var planner = new RoamPlanner(Sequence(0.9f, 1f));
            var plan = Wait(planner, At(1600f, 1720f));

            Assert.IsTrue(plan.Moving);
            Assert.AreEqual(1, plan.Direction);

            // 200 - 64(가장자리 여유) = 136px -> 90px/s 로 1.6초 안에 끝난다.
            for (var i = 0; i < 120; i++) planner.Update(0.016f, At(1600f, 1720f));
            Assert.IsFalse(planner.Moving);
        }

        /// <summary>
        /// 머무는 시간이 지수분포여야 한다. 균등분포면 "일정한 간격으로 움직인다"가
        /// 눈에 남는다 — 지수분포는 대부분 짧고 가끔 아주 길다.
        /// </summary>
        [Test]
        public void 머무는_시간이_지수분포다()
        {
            var samples = new List<float>();
            for (var i = 1; i < 40; i++)
            {
                var u = i / 40f;
                var planner = new RoamPlanner(Sequence(0.5f, 0.5f, u));
                Assert.IsTrue(Wait(planner, At(900f, 1020f)).Moving);
                // 걸음을 끝내 다음 머무는 시간을 뽑게 한다.
                for (var f = 0; f < 400 && planner.Moving; f++) planner.Update(0.05f, At(900f, 1020f));

                // 이제 dwell 이 다 지나갈 때까지 세어 본다.
                var waited = 0f;
                while (!planner.Update(0.5f, At(900f, 1020f)).Moving && waited < 2000f) waited += 0.5f;
                samples.Add(waited);
            }

            samples.Sort();
            var median = samples[samples.Count / 2];
            var longest = samples[samples.Count - 1];

            // 균등분포라면 최댓값이 중앙값의 2배 근처다. 지수분포는 꼬리가 훨씬 길다.
            Assert.Greater(longest, median * 2.5f);
            // 최소 대기도 지켜야 한다 — 도착하자마자 다시 출발하면 안 된다.
            Assert.GreaterOrEqual(samples[0], 20f);
        }
    }
}
