using NUnit.Framework;
using UnityEngine;
using WaifuAvatar.Avatar;

namespace WaifuAvatar.Tests
{
    /// <summary>
    /// 데스크탑 색 -> 조명. 눈으로 봐야 아는 것이 많지만, 두 가지는 기계가 잡을 수 있다 —
    /// 어두운 화면에서 조명이 죽지 않는 것과, 색상이 색환을 거꾸로 돌지 않는 것.
    /// </summary>
    public class AmbientMixTests
    {
        static AmbientSample Uniform(Color color)
        {
            return new AmbientSample { Top = color, Bottom = color, Left = color, Right = color };
        }

        /// <summary>충분히 시간을 흘려 목표에 붙인다.</summary>
        static AmbientMix Settled(Color color)
        {
            var mix = new AmbientMix();
            mix.Update(Uniform(color), 0f);
            for (var i = 0; i < 200; i++) mix.Update(Uniform(color), 0.1f);
            return mix;
        }

        /// <summary>
        /// 어두운 화면에서도 조명이 검게 죽지 않는다. 샘플한 RGB 를 그대로 색으로
        /// 쓰면 검은 배경에서 아바타가 통째로 안 보인다.
        /// </summary>
        [Test]
        public void 어두운_화면에서도_조명이_죽지_않는다()
        {
            var mix = Settled(new Color(0.02f, 0.02f, 0.02f));

            Assert.Greater(mix.Top.Intensity, 0f);
            var light = mix.Top.Color;
            Assert.Greater(light.r + light.g + light.b, 0.5f);
        }

        /// <summary>
        /// 회색은 약한 중립광, 짙은 색은 강한 색광. 채도가 세기를 만든다.
        /// </summary>
        [Test]
        public void 채도가_높을수록_세진다()
        {
            var grey = Settled(new Color(0.5f, 0.5f, 0.5f));
            var vivid = Settled(new Color(1f, 0f, 0f));

            Assert.Less(grey.Top.Intensity, vivid.Top.Intensity);
            Assert.AreEqual(grey.Top.Intensity, grey.Top.Intensity);
            // 회색이면 색이 거의 백색이어야 한다.
            Assert.AreEqual(grey.Top.Color.r, grey.Top.Color.b, 0.05f);
            // 짙은 빨강은 빨갛게 나와야 한다.
            Assert.Greater(vivid.Top.Color.r, vivid.Top.Color.g + 0.5f);
        }

        [Test]
        public void 세기는_설정한_범위_안에_있다()
        {
            var mix = new AmbientMix { MinIntensity = 0.2f, MaxIntensity = 0.9f };
            foreach (var color in new[] { Color.black, Color.white, Color.red, new Color(0.3f, 0.7f, 0.1f) })
            {
                mix.Reset();
                mix.Update(Uniform(color), 0f);
                Assert.GreaterOrEqual(mix.Top.Intensity, 0.2f - 1e-4f);
                Assert.LessOrEqual(mix.Top.Intensity, 0.9f + 1e-4f);
            }
        }

        /// <summary>
        /// 색상은 원이다. 0.98 에서 0.02 로 갈 때 선형 보간하면 색환을 거꾸로
        /// 돌아 초록과 파랑을 훑는다 — 화면이 바뀔 때마다 무지개가 지나간다.
        /// </summary>
        [Test]
        public void 색상은_색환의_짧은_쪽으로_간다()
        {
            var from = new Vector3(0.98f, 1f, 1f);
            var to = new Vector3(0.02f, 1f, 1f);

            var half = AmbientMix.Damp(from, to, 0.5f);

            // 0.98 -> 0.02 의 중간은 0.0 근처(빨강)이지 0.5(청록)가 아니다.
            var distance = Mathf.Min(Mathf.Abs(half.x - 0f), Mathf.Abs(half.x - 1f));
            Assert.Less(distance, 0.05f);
        }

        /// <summary>
        /// 첫 샘플은 그대로 받는다. 검정에서 시작해 감쇠시키면 켜자마자 한 번
        /// 어두워졌다 밝아지는 게 보인다.
        /// </summary>
        [Test]
        public void 첫_샘플은_즉시_반영된다()
        {
            var mix = new AmbientMix();
            mix.Update(Uniform(Color.red), 0f);

            Assert.Greater(mix.Top.Color.r, mix.Top.Color.g + 0.5f);
        }

        [Test]
        public void 급격한_변화는_천천히_따라간다()
        {
            var mix = Settled(Color.blue);
            var before = mix.Top.Color;

            mix.Update(Uniform(Color.red), 1f / 60f);

            // 한 프레임 만에 빨강이 되면 화면 전환마다 조명이 번쩍인다.
            Assert.Less(Mathf.Abs(mix.Top.Color.r - before.r), 0.5f);
        }

        [Test]
        public void 리셋하면_다음_샘플을_그대로_받는다()
        {
            var mix = Settled(Color.blue);
            mix.Reset();
            mix.Update(Uniform(Color.red), 0f);

            Assert.Greater(mix.Top.Color.r, mix.Top.Color.b + 0.5f);
        }

        /// <summary>네 변은 서로 다른 색을 가진다. 한 덩어리로 뭉개면 방향감이 없다.</summary>
        [Test]
        public void 네_변이_따로_움직인다()
        {
            var mix = new AmbientMix();
            var sample = new AmbientSample
            {
                Top = Color.red,
                Bottom = Color.blue,
                Left = Color.green,
                Right = Color.white
            };
            mix.Update(sample, 0f);

            Assert.Greater(mix.Top.Color.r, mix.Top.Color.b);
            Assert.Greater(mix.Bottom.Color.b, mix.Bottom.Color.r);
            Assert.Greater(mix.Left.Color.g, mix.Left.Color.r);
            // 백색은 채도가 0 이라 가장 약하다.
            Assert.Less(mix.Right.Intensity, mix.Top.Intensity);
        }
    }
}
