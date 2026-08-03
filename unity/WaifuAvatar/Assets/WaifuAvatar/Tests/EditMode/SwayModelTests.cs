using NUnit.Framework;
using UnityEngine;
using WaifuAvatar.Avatar;

namespace WaifuAvatar.Tests
{
    /// <summary>
    /// 드래그 관성. 눈으로 봐야 하는 것이 많은 영역이라, 여기서는 **부호와 순서**를
    /// 잡는다 — 어느 쪽으로 눕는지, 팔이 몸통을 뒤따르는지, 놓았을 때 걷히는지.
    /// 세기와 곡선의 취향은 실제 앱을 띄워 봐야 안다.
    /// </summary>
    public class SwayModelTests
    {
        const float Step = 1f / 60f;

        static SwayModel Fresh() => new SwayModel();

        /// <summary>여러 프레임 같은 속도로 끈다.</summary>
        static void Drag(SwayModel sway, Vector2 velocity, int frames)
        {
            for (var i = 0; i < frames; i++) sway.Update(velocity, true, Step);
        }

        [Test]
        public void 오른쪽으로_채면_몸이_왼쪽으로_눕는다()
        {
            var sway = Fresh();
            Drag(sway, new Vector2(1200f, 0f), 30);

            // 창이 +x 로 가면 관성은 -x 다. roll(Z)이 음수여야 한다.
            Assert.Less(sway.Hips.z, 0f);
        }

        [Test]
        public void 왼쪽으로_채면_반대로_눕는다()
        {
            var sway = Fresh();
            Drag(sway, new Vector2(-1200f, 0f), 30);

            Assert.Greater(sway.Hips.z, 0f);
        }

        /// <summary>
        /// 팔은 몸통과 **반대 방향**으로 남는다. 같이 기울면 통짜 판때기가 된다.
        /// </summary>
        [Test]
        public void 팔은_몸통을_반대_위상으로_뒤따른다()
        {
            var sway = Fresh();
            Drag(sway, new Vector2(1200f, 0f), 30);

            Assert.Less(sway.Hips.z, 0f);
            Assert.Greater(sway.Arms.z, 0f);
            // 팔은 몸통보다 작게 움직인다.
            Assert.Less(Mathf.Abs(sway.Arms.z), Mathf.Abs(sway.Hips.z));
            // 다리는 팔보다 더 작다.
            Assert.Less(Mathf.Abs(sway.Legs.z), Mathf.Abs(sway.Arms.z));
        }

        [Test]
        public void 놓으면_되돌아온다()
        {
            var sway = Fresh();
            Drag(sway, new Vector2(1200f, 0f), 30);
            var peak = Mathf.Abs(sway.Hips.z);
            Assert.Greater(peak, 0f);

            for (var i = 0; i < 60; i++) sway.Update(Vector2.zero, false, Step);

            Assert.AreEqual(0f, sway.Hips.z, 1e-4f);
            Assert.AreEqual(0f, sway.Weight, 1e-4f);
        }

        /// <summary>
        /// 걷히는 것이 실리는 것보다 빨라야 한다. 놓았는데 몸이 계속 기울어 있으면
        /// 아직 잡혀 있는 것처럼 보인다.
        /// </summary>
        [Test]
        public void 걷힐_때가_실릴_때보다_빠르다()
        {
            var rising = Fresh();
            rising.Update(new Vector2(1200f, 0f), true, Step * 6);
            var gained = rising.Weight;

            var falling = Fresh();
            for (var i = 0; i < 40; i++) falling.Update(new Vector2(1200f, 0f), true, Step);
            var before = falling.Weight;
            falling.Update(Vector2.zero, false, Step * 6);
            var lost = before - falling.Weight;

            Assert.Greater(lost, gained);
        }

        [Test]
        public void 세기가_0이면_기울지_않는다()
        {
            var sway = Fresh();
            sway.Strength = 0f;
            Drag(sway, new Vector2(2400f, 0f), 30);

            Assert.AreEqual(0f, sway.Hips.z, 1e-6f);
            Assert.AreEqual(0f, sway.Arms.z, 1e-6f);
        }

        /// <summary>아주 빠르게 채도 상한을 넘지 않는다. 넘으면 고무 인형이 된다.</summary>
        [Test]
        public void 아무리_빨라도_상한을_넘지_않는다()
        {
            var sway = Fresh();
            Drag(sway, new Vector2(100000f, 100000f), 120);

            // 스프링 오버슛까지 감안해 여유를 준다. 요는 "발산하지 않는다" 이다.
            Assert.Less(Mathf.Abs(sway.Hips.z) * Mathf.Rad2Deg, sway.MaxLeanZ * 1.5f);
            Assert.Less(Mathf.Abs(sway.Hips.x) * Mathf.Rad2Deg, sway.MaxLeanX * 1.5f);
        }

        /// <summary>
        /// 절전에서 깨면 delta 가 초 단위로 튄다. 명시적 오일러 적분기는 여기서
        /// 발산했다 — 그래서 우리 Spring 은 음함수 오일러다.
        /// </summary>
        [Test]
        public void 델타가_크게_튀어도_발산하지_않는다()
        {
            var sway = Fresh();
            Drag(sway, new Vector2(1200f, 0f), 20);

            sway.Update(new Vector2(1200f, 0f), true, 30f);

            Assert.IsFalse(float.IsNaN(sway.Hips.z));
            Assert.Less(Mathf.Abs(sway.Hips.z) * Mathf.Rad2Deg, sway.MaxLeanZ * 1.5f);
        }

        [Test]
        public void 스냅하면_전부_0이_된다()
        {
            var sway = Fresh();
            Drag(sway, new Vector2(1200f, 800f), 30);
            Assert.Greater(Mathf.Abs(sway.Hips.z), 0f);

            sway.Snap();

            Assert.AreEqual(0f, sway.Hips.z, 1e-6f);
            Assert.AreEqual(0f, sway.Hips.x, 1e-6f);
            Assert.AreEqual(0f, sway.Arms.z, 1e-6f);
            Assert.AreEqual(0f, sway.Weight, 1e-6f);
        }

        /// <summary>
        /// 같은 손놀림이면 프레임률이 달라도 비슷하게 기울어야 한다. 상류는 프레임당
        /// 픽셀을 그대로 각도로 바꿔서 120Hz 에서 절반만 기울었다.
        /// </summary>
        [Test]
        public void 프레임률이_달라도_비슷하게_기운다()
        {
            var at60 = Fresh();
            for (var i = 0; i < 60; i++) at60.Update(new Vector2(900f, 0f), true, 1f / 60f);

            var at120 = Fresh();
            for (var i = 0; i < 120; i++) at120.Update(new Vector2(900f, 0f), true, 1f / 120f);

            Assert.AreEqual(at60.Hips.z, at120.Hips.z, Mathf.Abs(at60.Hips.z) * 0.1f + 1e-4f);
        }
    }
}
