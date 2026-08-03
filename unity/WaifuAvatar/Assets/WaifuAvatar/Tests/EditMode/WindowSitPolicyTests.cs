using System.Collections.Generic;
using NUnit.Framework;
using UnityEngine;
using WaifuAvatar.Window;

namespace WaifuAvatar.Tests
{
    /// <summary>
    /// 창 걸터앉기 규칙.
    ///
    /// 여기 있는 것은 전부 **오작동을 막는 장치**의 검증이다. 창에 앉는 기능은
    /// 붙는 것보다 "안 붙어야 할 때 안 붙는 것"이 어렵다 — 아바타를 그냥 옮기려는데
    /// 지나가던 창에 철컥 붙거나, 앉혀 놨는데 손만 대면 떨어지면 없느니만 못하다.
    /// 상류(Mate-Engine)에서 실사용으로 다듬어진 조건들이라 값을 바꾸기 전에
    /// 이 테스트들이 왜 있는지부터 읽어야 한다.
    /// </summary>
    public class WindowSitPolicyTests
    {
        const long WindowId = 1234L;

        static List<SitCandidate> One(Rect rect, bool taskbar = false)
        {
            return new List<SitCandidate> { new SitCandidate { Id = WindowId, Rect = rect, IsTaskbar = taskbar } };
        }

        static Rect Window => new Rect(400f, 300f, 900f, 600f);

        static WindowSitPolicy Fresh()
        {
            // 래치를 1로 줄여둔다. 기본값 18은 실제 사용에서 앉는 모션이 자리를
            // 잡는 동안 버티기 위한 것이고, 테스트에서 18틱을 돌리면 의도가 흐려진다.
            return new WindowSitPolicy { LatchTicks = 1 };
        }

        static SitInput At(Vector2 probe, bool dragging = true, Vector2? cursor = null,
            IReadOnlyList<SitCandidate> candidates = null)
        {
            return new SitInput
            {
                Enabled = true,
                Dragging = dragging,
                Probe = probe,
                Cursor = cursor ?? probe,
                Scale = 1f,
                Candidates = candidates ?? One(Window),
            };
        }

        /// <summary>드래그를 <see cref="WindowSitPolicy.MinDragHoldSec"/> 이상 유지한 상태로 만든다.</summary>
        static void HoldDrag(WindowSitPolicy policy, Vector2 grab, IReadOnlyList<SitCandidate> candidates = null)
        {
            // 잡은 자리는 창에서 멀리 둔다. 유지 시간을 채우는 동안 앉아버리면
            // 정작 검증하려는 순간이 사라진다.
            policy.Update(0f, At(grab, cursor: grab, candidates: candidates));
            policy.Update(1f, At(grab, cursor: grab, candidates: candidates));
        }

        [Test]
        public void 창_윗변에_닿으면_앉는다()
        {
            var policy = Fresh();
            var far = new Vector2(800f, 900f);
            HoldDrag(policy, far);

            var decision = policy.Update(0.02f, At(new Vector2(850f, 302f), cursor: new Vector2(850f, 302f)));

            Assert.AreEqual(SitChange.Snapped, decision.Change);
            Assert.AreEqual(WindowId, decision.Id);
            Assert.IsTrue(policy.Sitting);
            // 창 좌변 400, 폭 900 -> 850 은 정확히 절반.
            Assert.AreEqual(0.5f, decision.Fraction, 0.001f);
        }

        /// <summary>
        /// 잡자마자 창 위를 지나가면 앉지 않는다. 아바타를 화면 반대편으로
        /// 옮기는 도중에 창이 하나 걸렸다고 붙어버리면 옮길 방법이 없다.
        /// </summary>
        [Test]
        public void 짧게_잡고_지나가면_앉지_않는다()
        {
            var policy = Fresh();
            var start = new Vector2(800f, 900f);
            policy.Update(0f, At(start, cursor: start));

            var decision = policy.Update(0.1f, At(new Vector2(850f, 302f), cursor: new Vector2(850f, 302f)));

            Assert.AreEqual(SitChange.None, decision.Change);
            Assert.IsFalse(policy.Sitting);
        }

        /// <summary>제자리 클릭은 드래그가 아니다.</summary>
        [Test]
        public void 커서가_움직이지_않으면_앉지_않는다()
        {
            var policy = Fresh();
            var still = new Vector2(850f, 302f);
            policy.Update(0f, At(still, cursor: still));
            var decision = policy.Update(1f, At(still, cursor: still));

            Assert.AreEqual(SitChange.None, decision.Change);
        }

        [Test]
        public void 끌지_않으면_앉지_않는다()
        {
            var policy = Fresh();
            var decision = policy.Update(1f, At(new Vector2(850f, 302f), dragging: false));

            Assert.AreEqual(SitChange.None, decision.Change);
        }

        [Test]
        public void 윗변에서_멀면_앉지_않는다()
        {
            var policy = Fresh();
            var far = new Vector2(800f, 900f);
            HoldDrag(policy, far);

            // 창 안쪽 한가운데. 가로는 걸치지만 세로가 반경 밖이다.
            var decision = policy.Update(0.02f, At(new Vector2(850f, 500f), cursor: new Vector2(850f, 500f)));

            Assert.AreEqual(SitChange.None, decision.Change);
        }

        [Test]
        public void 작은_창에는_앉지_않는다()
        {
            var policy = Fresh();
            var tiny = One(new Rect(400f, 300f, 120f, 40f));
            var far = new Vector2(430f, 900f);
            HoldDrag(policy, far, tiny);

            var decision = policy.Update(0.02f, At(new Vector2(430f, 302f), cursor: new Vector2(430f, 302f), candidates: tiny));

            Assert.AreEqual(SitChange.None, decision.Change);
        }

        /// <summary>작업표시줄은 얇아서 최소 높이 조건에 걸린다. 예외로 통과시켜야 한다.</summary>
        [Test]
        public void 얇은_작업표시줄에는_앉는다()
        {
            var policy = Fresh();
            var taskbar = One(new Rect(0f, 1032f, 1920f, 48f), taskbar: true);
            var far = new Vector2(960f, 700f);
            HoldDrag(policy, far, taskbar);

            var decision = policy.Update(0.02f, At(new Vector2(960f, 1034f), cursor: new Vector2(960f, 1034f), candidates: taskbar));

            Assert.AreEqual(SitChange.Snapped, decision.Change);
            Assert.IsTrue(policy.OnTaskbar);
        }

        /// <summary>
        /// 앉은 직후에는 몇 틱 무조건 붙어 있는다. 앉는 모션이 시작되며 엉덩이가
        /// 움직이는데, 그 첫 프레임을 "멀어졌다"로 읽으면 앉자마자 떨어진다.
        /// </summary>
        [Test]
        public void 앉은_직후_한_틱은_떨어지지_않는다()
        {
            var policy = new WindowSitPolicy { LatchTicks = 3 };
            var far = new Vector2(800f, 900f);
            HoldDrag(policy, far);
            policy.Update(0.02f, At(new Vector2(850f, 302f), cursor: new Vector2(850f, 302f)));

            // 곧바로 창에서 한참 떨어진 자리로 보내도 래치가 버틴다.
            var held = policy.Update(0.02f, At(new Vector2(850f, 900f), cursor: new Vector2(850f, 900f)));

            Assert.AreEqual(SitChange.None, held.Change);
            Assert.IsTrue(policy.Sitting);
        }

        [Test]
        public void 세로로_끌어내면_일어난다()
        {
            var policy = Fresh();
            var far = new Vector2(800f, 900f);
            HoldDrag(policy, far);
            policy.Update(0.02f, At(new Vector2(850f, 302f), cursor: new Vector2(850f, 302f)));
            policy.Update(0.02f, At(new Vector2(850f, 302f), cursor: new Vector2(850f, 302f))); // 래치 소진

            var decision = policy.Update(0.02f, At(new Vector2(850f, 600f), cursor: new Vector2(850f, 600f)));

            Assert.AreEqual(SitChange.Released, decision.Change);
            Assert.IsFalse(policy.Sitting);
        }

        /// <summary>
        /// 앉은 채 가로로 훑는 것은 자리 옮기기다. 아바타는 창에 붙잡혀 있어
        /// 위치만 보면 항상 "가까이"라, 커서 이동을 따로 봐야 구분된다.
        /// </summary>
        [Test]
        public void 가로로_훑으면_자리만_옮긴다()
        {
            var policy = Fresh();
            var far = new Vector2(800f, 900f);
            HoldDrag(policy, far);
            policy.Update(0.02f, At(new Vector2(850f, 302f), cursor: new Vector2(850f, 302f)));
            policy.Update(0.02f, At(new Vector2(850f, 302f), cursor: new Vector2(850f, 302f)));

            var decision = policy.Update(0.02f, At(new Vector2(1210f, 302f), cursor: new Vector2(1210f, 302f)));

            Assert.AreEqual(SitChange.None, decision.Change);
            Assert.IsTrue(policy.Sitting);
            // 창 좌변 400, 폭 900 -> 1210 은 90%.
            Assert.AreEqual(0.9f, policy.Fraction, 0.001f);
        }

        /// <summary>
        /// 떼어낸 자리 근처에서는 다시 앉지 않는다. 쿨다운만 두면 그 시간이
        /// 끝나는 순간 같은 창에 도로 붙어, 사용자는 아바타를 떼어낼 수 없다.
        /// </summary>
        /// <summary>
        /// 실제 드래그는 프레임마다 몇 px 씩 움직이므로, 떨어져 나오는 지점은 창
        /// 윗변에서 겨우 밴드(24px) 바깥이다. 그래서 가드 중심이 창 바로 옆에
        /// 찍히고, 손을 조금만 되돌리면 그대로 다시 붙으려 한다 — 그걸 막는다.
        /// </summary>
        [Test]
        public void 뗀_자리_근처에서는_다시_앉지_않는다()
        {
            var policy = Fresh();
            var far = new Vector2(800f, 900f);
            HoldDrag(policy, far);
            policy.Update(0.02f, At(new Vector2(850f, 302f), cursor: new Vector2(850f, 302f)));
            policy.Update(0.02f, At(new Vector2(850f, 302f), cursor: new Vector2(850f, 302f)));
            var released = policy.Update(0.02f, At(new Vector2(850f, 332f), cursor: new Vector2(850f, 332f)));
            Assert.AreEqual(SitChange.Released, released.Change);

            // 쿨다운이 지나도 가드 존 안이면 안 붙는다.
            policy.Update(1f, At(new Vector2(850f, 332f), cursor: new Vector2(850f, 332f)));
            var again = policy.Update(0.02f, At(new Vector2(850f, 302f), cursor: new Vector2(850f, 302f)));

            Assert.AreEqual(SitChange.None, again.Change);
        }

        /// <summary>가드 존은 반경이 있다. 충분히 멀어지면 다시 앉을 수 있어야 한다.</summary>
        [Test]
        public void 가드_존_밖으로_나가면_다시_앉는다()
        {
            var policy = Fresh();
            var far = new Vector2(800f, 900f);
            HoldDrag(policy, far);
            policy.Update(0.02f, At(new Vector2(850f, 302f), cursor: new Vector2(850f, 302f)));
            policy.Update(0.02f, At(new Vector2(850f, 302f), cursor: new Vector2(850f, 302f)));
            policy.Update(0.02f, At(new Vector2(850f, 600f), cursor: new Vector2(850f, 600f)));

            // 가드 반경(240px)보다 멀리 간 뒤 돌아온다.
            policy.Update(1f, At(new Vector2(850f, 1000f), cursor: new Vector2(850f, 1000f)));
            var again = policy.Update(0.02f, At(new Vector2(850f, 302f), cursor: new Vector2(850f, 302f)));

            Assert.AreEqual(SitChange.Snapped, again.Change);
        }

        /// <summary>창이 닫히거나 최소화되면 후보에서 사라진다. 그때 허공에 남으면 안 된다.</summary>
        [Test]
        public void 창이_사라지면_일어난다()
        {
            var policy = Fresh();
            var far = new Vector2(800f, 900f);
            HoldDrag(policy, far);
            policy.Update(0.02f, At(new Vector2(850f, 302f), cursor: new Vector2(850f, 302f)));

            var decision = policy.Update(0.02f, new SitInput
            {
                Enabled = true,
                Dragging = false,
                Probe = new Vector2(850f, 302f),
                Cursor = new Vector2(850f, 302f),
                Scale = 1f,
                Candidates = new List<SitCandidate>(),
            });

            Assert.AreEqual(SitChange.Released, decision.Change);
        }

        [Test]
        public void 놓으면_계속_앉아_있는다()
        {
            var policy = Fresh();
            var far = new Vector2(800f, 900f);
            HoldDrag(policy, far);
            policy.Update(0.02f, At(new Vector2(850f, 302f), cursor: new Vector2(850f, 302f)));

            // 마우스를 놓고 창에서 멀어져도(창이 움직여도) 앉은 상태는 유지된다.
            var decision = policy.Update(0.02f, At(new Vector2(850f, 900f), dragging: false));

            Assert.AreEqual(SitChange.None, decision.Change);
            Assert.IsTrue(policy.Sitting);
        }

        [Test]
        public void 설정을_끄면_즉시_일어난다()
        {
            var policy = Fresh();
            var far = new Vector2(800f, 900f);
            HoldDrag(policy, far);
            policy.Update(0.02f, At(new Vector2(850f, 302f), cursor: new Vector2(850f, 302f)));

            var input = At(new Vector2(850f, 302f));
            input.Enabled = false;
            var decision = policy.Update(0.02f, input);

            Assert.AreEqual(SitChange.Released, decision.Change);
            Assert.IsFalse(policy.Sitting);
        }

        /// <summary>배율을 키우면 판정 반경도 같이 커진다. 안 그러면 큰 아바타는 앉기 어렵다.</summary>
        [Test]
        public void 배율이_크면_판정_반경도_커진다()
        {
            var far = new Vector2(800f, 900f);
            var probe = new Vector2(850f, 340f); // 윗변에서 40px — 기본 반경 24px 밖

            var small = Fresh();
            HoldDrag(small, far);
            Assert.AreEqual(SitChange.None, small.Update(0.02f, At(probe, cursor: probe)).Change);

            var large = Fresh();
            large.Update(0f, At(far, cursor: far));
            large.Update(1f, At(far, cursor: far));
            var scaled = At(probe, cursor: probe);
            scaled.Scale = 2f; // 반경 48px
            Assert.AreEqual(SitChange.Snapped, large.Update(0.02f, scaled).Change);
        }

        [Test]
        public void 강제_해제는_앉아_있을_때만_변화를_보고한다()
        {
            var policy = Fresh();
            Assert.AreEqual(SitChange.None, policy.Release().Change);

            var far = new Vector2(800f, 900f);
            HoldDrag(policy, far);
            policy.Update(0.02f, At(new Vector2(850f, 302f), cursor: new Vector2(850f, 302f)));

            Assert.AreEqual(SitChange.Released, policy.Release().Change);
            Assert.AreEqual(SitChange.None, policy.Release().Change);
        }
    }
}
