using NUnit.Framework;
using WaifuAvatar.Window;

namespace WaifuAvatar.Tests
{
    /// <summary>
    /// 해상도에 맞춘 자동 배율. 4K 주 모니터와 FHD 보조 모니터를 섞어 쓰는 구성이
    /// 이 계산의 존재 이유다 — 한쪽에 맞추면 다른 쪽에서 반드시 어긋난다.
    /// </summary>
    public class MonitorScaleTests
    {
        const float Reference = 1080f;

        [Test]
        public void 기준_해상도에서는_그대로다()
        {
            Assert.AreEqual(1f, MonitorScale.Factor(1080f, Reference, 0.5f, 3f), 1e-4f);
        }

        [Test]
        public void four_K_에서는_두_배가_된다()
        {
            Assert.AreEqual(2f, MonitorScale.Factor(2160f, Reference, 0.5f, 3f), 1e-4f);
        }

        [Test]
        public void QHD_에서는_그_사이다()
        {
            var factor = MonitorScale.Factor(1440f, Reference, 0.5f, 3f);
            Assert.Greater(factor, 1f);
            Assert.Less(factor, 2f);
        }

        [Test]
        public void 상한과_하한을_지킨다()
        {
            Assert.AreEqual(3f, MonitorScale.Factor(8640f, Reference, 0.5f, 3f), 1e-4f);
            Assert.AreEqual(0.5f, MonitorScale.Factor(200f, Reference, 0.5f, 3f), 1e-4f);
        }

        /// <summary>설정 파일을 손으로 고치면 상·하한이 뒤집힐 수 있다.</summary>
        [Test]
        public void 상한과_하한이_뒤집혀도_이상한_값을_뱉지_않는다()
        {
            var factor = MonitorScale.Factor(2160f, Reference, 3f, 0.5f);
            Assert.GreaterOrEqual(factor, 0.5f);
            Assert.LessOrEqual(factor, 3f);
        }

        /// <summary>모니터를 못 읽으면 0 이 온다. 그때 0 을 곱하면 아바타가 사라진다.</summary>
        [Test]
        public void 해상도를_모르면_보정하지_않는다()
        {
            Assert.AreEqual(1f, MonitorScale.Factor(0f, Reference, 0.5f, 3f), 1e-4f);
            Assert.AreEqual(1f, MonitorScale.Factor(1080f, 0f, 0.5f, 3f), 1e-4f);
        }
    }
}
