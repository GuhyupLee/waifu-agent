using NUnit.Framework;
using UnityEngine;
using WaifuAvatar.Window;

namespace WaifuAvatar.Tests
{
    public class DragTetherMathTests
    {
        [Test]
        public void 창_좌상단은_카메라_좌상단으로_간다()
        {
            Assert.IsTrue(DragTetherMath.TryCameraPixel(
                new Vector2(100f, 200f),
                new Vector2(100f, 200f),
                new Vector2(400f, 600f),
                400,
                600,
                out var pixel));

            Assert.That(pixel.x, Is.EqualTo(0f).Within(1e-4f));
            Assert.That(pixel.y, Is.EqualTo(600f).Within(1e-4f));
        }

        [Test]
        public void 창_우하단은_카메라_우하단으로_간다()
        {
            Assert.IsTrue(DragTetherMath.TryCameraPixel(
                new Vector2(500f, 800f),
                new Vector2(100f, 200f),
                new Vector2(400f, 600f),
                400,
                600,
                out var pixel));

            Assert.That(pixel.x, Is.EqualTo(400f).Within(1e-4f));
            Assert.That(pixel.y, Is.EqualTo(0f).Within(1e-4f));
        }

        [Test]
        public void DPI로_렌더_버퍼가_달라도_비율을_보존한다()
        {
            Assert.IsTrue(DragTetherMath.TryCameraPixel(
                new Vector2(300f, 500f),
                new Vector2(100f, 200f),
                new Vector2(400f, 600f),
                800,
                1200,
                out var pixel));

            Assert.That(pixel.x, Is.EqualTo(400f).Within(1e-4f));
            Assert.That(pixel.y, Is.EqualTo(600f).Within(1e-4f));
        }

        [Test]
        public void 준비되지_않은_창_크기는_거절한다()
        {
            Assert.IsFalse(DragTetherMath.TryCameraPixel(
                Vector2.zero,
                Vector2.zero,
                Vector2.zero,
                400,
                600,
                out _));
        }

        [Test]
        public void 루트_오프셋은_손을_목표점으로_보낸다()
        {
            var root = new Vector3(1f, 2f, 3f);
            var hand = new Vector3(2f, 4f, 3f);
            var target = new Vector3(-1f, 5f, 3f);
            var offset = DragTetherMath.RootOffset(hand, target);

            Assert.AreEqual(target, hand + offset);
            Assert.AreEqual(new Vector3(-2f, 3f, 3f), root + offset);
        }

        [Test]
        public void 복귀_곡선은_양끝을_보존하고_중간을_부드럽게_지난다()
        {
            Assert.AreEqual(0f, DragTetherMath.SmoothReturn(-1f));
            Assert.AreEqual(0.5f, DragTetherMath.SmoothReturn(0.5f));
            Assert.AreEqual(1f, DragTetherMath.SmoothReturn(2f));
        }
    }
}
