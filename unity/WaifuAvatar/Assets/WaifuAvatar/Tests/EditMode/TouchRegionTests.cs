using NUnit.Framework;
using UnityEngine;
using WaifuAvatar.Avatar;

namespace WaifuAvatar.Tests
{
    /// <summary>
    /// 만진 자리 판정.
    ///
    /// 콜라이더 대신 상대 높이로 나누는 이유는 VRM 마다 본 구성이 달라서다.
    /// 여기서 잠그는 것은 "모델이 달라도 머리는 위, 손은 옆" 이라는 성질이다.
    /// </summary>
    public class TouchRegionTests
    {
        [Test]
        public void 정수리는_머리다()
        {
            Assert.AreEqual(TouchRegion.Head, TouchRegions.Classify(new Vector2(0.5f, 0.95f)));
        }

        [Test]
        public void 머리_바로_아래는_얼굴이다()
        {
            Assert.AreEqual(TouchRegion.Face, TouchRegions.Classify(new Vector2(0.5f, 0.84f)));
        }

        [Test]
        public void 몸통_가운데는_몸이다()
        {
            Assert.AreEqual(TouchRegion.Body, TouchRegions.Classify(new Vector2(0.5f, 0.5f)));
        }

        [Test]
        public void 몸통_높이의_양옆은_손이다()
        {
            Assert.AreEqual(TouchRegion.Hand, TouchRegions.Classify(new Vector2(0.1f, 0.5f)));
            Assert.AreEqual(TouchRegion.Hand, TouchRegions.Classify(new Vector2(0.9f, 0.5f)));
        }

        [Test]
        public void 배는_손으로_치지_않는다()
        {
            // 옆쪽을 전부 손으로 치면 팔이 몸에 붙은 자세에서 배를 만질 수 없다.
            Assert.AreEqual(TouchRegion.Body, TouchRegions.Classify(new Vector2(0.45f, 0.5f)));
        }

        [Test]
        public void 다리는_손이_아니라_몸이다()
        {
            Assert.AreEqual(TouchRegion.Body, TouchRegions.Classify(new Vector2(0.1f, 0.15f)));
        }

        [Test]
        public void 바깥은_판정하지_않는다()
        {
            // 커서가 창 밖일 때 0,0 으로 떨어뜨리면 만지지도 않았는데 반응한다.
            foreach (var p in new[]
                     {
                         new Vector2(-0.1f, 0.5f), new Vector2(1.1f, 0.5f),
                         new Vector2(0.5f, -0.1f), new Vector2(0.5f, 1.1f)
                     })
            {
                Assert.AreEqual(TouchRegion.None, TouchRegions.Classify(p), p.ToString());
            }
        }

        [Test]
        public void 부위마다_다른_반응을_준다()
        {
            // 전부 같은 표정이면 어디를 만져도 똑같아 보인다.
            var head = TouchRegions.EmotionFor(TouchRegion.Head);
            var hand = TouchRegions.EmotionFor(TouchRegion.Hand);
            Assert.IsNotNull(head);
            Assert.IsNotNull(hand);
            Assert.AreNotEqual(head, hand);
        }

        [Test]
        public void None_에는_반응이_없다()
        {
            Assert.IsNull(TouchRegions.EmotionFor(TouchRegion.None));
        }

        [Test]
        public void 반응_표정은_protocol_의_Emotion_이름이다()
        {
            // 여기 오타가 나면 표정이 조용히 무시된다 — VRM 은 없는 프리셋에
            // 값을 넣어도 에러를 내지 않는다.
            var valid = new[] { "neutral", "happy", "sad", "angry", "surprised", "relaxed" };
            foreach (TouchRegion region in System.Enum.GetValues(typeof(TouchRegion)))
            {
                var emotion = TouchRegions.EmotionFor(region);
                if (emotion == null) continue;
                Assert.Contains(emotion, valid, $"{region} 의 표정 이름");
            }
        }
    }
}
