using NUnit.Framework;
using UnityEngine;
using WaifuAvatar.Window;

namespace WaifuAvatar.Tests
{
    /// <summary>
    /// 투명하고 클릭이 통과하는 창은 화면 밖으로 나가면 되찾을 방법이 없다.
    /// 여기서 잠그는 것은 "항상 되찾을 수 있는가" 하나다.
    /// </summary>
    public class ScreenClampTests
    {
        static readonly Rect Primary = new Rect(0f, 0f, 1920f, 1080f);
        static readonly Rect Secondary = new Rect(1920f, 0f, 1920f, 1080f);
        static readonly Vector2 Size = new Vector2(400f, 600f);

        static Rect[] Both => new[] { Primary, Secondary };

        [Test]
        public void 모니터_정보가_없으면_건드리지_않는다()
        {
            // 모니터를 못 읽었을 때 0,0 으로 끌어오면 멀쩡한 배치를 망친다.
            var position = new Vector2(-5000f, -5000f);
            Assert.AreEqual(position, ScreenClamp.Clamp(position, Size, new Rect[0]));
        }

        [Test]
        public void 화면_안에_있으면_그대로_둔다()
        {
            var position = new Vector2(500f, 300f);
            Assert.AreEqual(position, ScreenClamp.Clamp(position, Size, Both));
        }

        [Test]
        public void 왼쪽으로_벗어나도_최소한은_보인다()
        {
            var clamped = ScreenClamp.Clamp(new Vector2(-9999f, 300f), Size, Both);
            var visible = clamped.x + Size.x - Primary.xMin;
            Assert.GreaterOrEqual(visible, ScreenClamp.MinVisible - 0.01f);
        }

        [Test]
        public void 오른쪽으로_벗어나도_최소한은_보인다()
        {
            var clamped = ScreenClamp.Clamp(new Vector2(99999f, 300f), Size, Both);
            var visible = Secondary.xMax - clamped.x;
            Assert.GreaterOrEqual(visible, ScreenClamp.MinVisible - 0.01f);
        }

        [Test]
        public void 아래로_벗어나도_최소한은_보인다()
        {
            var clamped = ScreenClamp.Clamp(new Vector2(500f, 99999f), Size, Both);
            var visible = Primary.yMax - clamped.y;
            Assert.GreaterOrEqual(visible, ScreenClamp.MinVisible - 0.01f);
        }

        [Test]
        public void 보조_모니터로_옮기는_것을_막지_않는다()
        {
            // 주 모니터에 가두면 다중 모니터에서 아바타를 옮길 수 없게 된다.
            var position = new Vector2(2400f, 300f);
            Assert.AreEqual(position, ScreenClamp.Clamp(position, Size, Both));
        }

        [Test]
        public void 겹치지_않으면_가장_가까운_모니터로_붙인다()
        {
            // 보조 모니터 바깥으로 조금 넘어간 창이 주 모니터로 순간이동하면 안 된다.
            var window = new Rect(4200f, 300f, Size.x, Size.y);
            Assert.AreEqual(Secondary, ScreenClamp.BestMonitor(window, Both));
        }

        [Test]
        public void 가장_많이_겹치는_모니터를_고른다()
        {
            var window = new Rect(1800f, 300f, 400f, 600f);
            // 1800~1920 은 주 모니터(120), 1920~2200 은 보조(280). 보조가 이긴다.
            Assert.AreEqual(Secondary, ScreenClamp.BestMonitor(window, Both));
        }

        [Test]
        public void 창이_모니터보다_커도_이상한_값을_내지_않는다()
        {
            var huge = new Vector2(4000f, 3000f);
            var clamped = ScreenClamp.Clamp(new Vector2(-100f, -100f), huge, new[] { Primary });
            Assert.IsFalse(float.IsNaN(clamped.x));
            Assert.IsFalse(float.IsNaN(clamped.y));
        }

        [Test]
        public void 앵커_왕복이_보존된다()
        {
            // 위치를 저장하고 복원하는 경로다. 여기가 어긋나면 껐다 켤 때마다 조금씩 밀린다.
            foreach (var anchor in new[]
                     {
                         new Vector2(0f, 0f), new Vector2(1f, 1f),
                         new Vector2(0.85f, 0f), new Vector2(0.3f, 0.7f)
                     })
            {
                var position = ScreenClamp.FromAnchor(anchor, Size, Primary);
                var back = ScreenClamp.ToAnchor(position, Size, Primary);
                Assert.That(back.x, Is.EqualTo(anchor.x).Within(1e-3f), $"x {anchor}");
                Assert.That(back.y, Is.EqualTo(anchor.y).Within(1e-3f), $"y {anchor}");
            }
        }

        [Test]
        public void 앵커는_좌하단_기준이다()
        {
            // protocol.ts 의 avatar.anchor 주석이 좌하단 기준이라고 못박고 있다.
            // y=0 이면 화면 아래쪽에 서야 한다.
            var bottom = ScreenClamp.FromAnchor(new Vector2(0f, 0f), Size, Primary);
            var top = ScreenClamp.FromAnchor(new Vector2(0f, 1f), Size, Primary);
            Assert.Greater(bottom.y, top.y, "y=0 이 더 아래(좌상단 좌표가 더 큼)여야 한다");
        }
    }
}
