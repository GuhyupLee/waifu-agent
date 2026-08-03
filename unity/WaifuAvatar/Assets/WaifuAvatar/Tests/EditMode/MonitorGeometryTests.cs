using NUnit.Framework;
using UnityEngine;
using WaifuAvatar.Window;

namespace WaifuAvatar.Tests
{
    /// <summary>
    /// 작업표시줄 판정. 화면 구성을 실제로 바꿔가며 확인할 수 없는 것들이라
    /// (세로 도킹, 자동 숨김, 다중 모니터) 여기서 사각형으로 재현한다.
    /// </summary>
    public class MonitorGeometryTests
    {
        static Rect Monitor => new Rect(0f, 0f, 1920f, 1080f);

        [Test]
        public void 아래에_붙은_작업표시줄을_찾는다()
        {
            var work = new Rect(0f, 0f, 1920f, 1032f);

            var edge = MonitorGeometry.TaskbarFrom(Monitor, work, out var taskbar);

            Assert.AreEqual(TaskbarEdge.Bottom, edge);
            Assert.AreEqual(1032f, taskbar.yMin);
            Assert.AreEqual(48f, taskbar.height);
            Assert.AreEqual(1920f, taskbar.width);
        }

        [Test]
        public void 위에_붙은_작업표시줄도_찾는다()
        {
            var work = new Rect(0f, 40f, 1920f, 1040f);

            var edge = MonitorGeometry.TaskbarFrom(Monitor, work, out var taskbar);

            Assert.AreEqual(TaskbarEdge.Top, edge);
            Assert.AreEqual(0f, taskbar.yMin);
            Assert.AreEqual(40f, taskbar.height);
        }

        [Test]
        public void 세로_도킹은_변과_두께를_준다()
        {
            var left = MonitorGeometry.TaskbarFrom(Monitor, new Rect(62f, 0f, 1858f, 1080f), out var leftBar);
            var right = MonitorGeometry.TaskbarFrom(Monitor, new Rect(0f, 0f, 1858f, 1080f), out var rightBar);

            Assert.AreEqual(TaskbarEdge.Left, left);
            Assert.AreEqual(62f, leftBar.width);
            Assert.AreEqual(TaskbarEdge.Right, right);
            Assert.AreEqual(1858f, rightBar.xMin);
        }

        /// <summary>
        /// 자동 숨김이면 작업 영역이 모니터와 같다. 여기서 억지로 화면 아래
        /// 몇 픽셀을 작업표시줄이라 우기면 숨겨진 막대 위에 아바타가 뜬다.
        /// </summary>
        [Test]
        public void 자동_숨김이면_작업표시줄이_없다()
        {
            var edge = MonitorGeometry.TaskbarFrom(Monitor, Monitor, out var taskbar);

            Assert.AreEqual(TaskbarEdge.None, edge);
            Assert.AreEqual(0f, taskbar.width);
            Assert.AreEqual(0f, taskbar.height);
        }

        /// <summary>보조 모니터는 원점이 0 이 아니다. 상대 좌표로 계산하면 여기서 깨진다.</summary>
        [Test]
        public void 보조_모니터의_음수_원점을_유지한다()
        {
            var monitor = new Rect(-1920f, -120f, 1920f, 1080f);
            var work = new Rect(-1920f, -120f, 1920f, 1032f);

            var edge = MonitorGeometry.TaskbarFrom(monitor, work, out var taskbar);

            Assert.AreEqual(TaskbarEdge.Bottom, edge);
            Assert.AreEqual(-1920f, taskbar.xMin);
            Assert.AreEqual(912f, taskbar.yMin);
        }

        [Test]
        public void 아래에_붙은_것만_앉을_수_있다()
        {
            Assert.IsTrue(MonitorGeometry.IsSittable(TaskbarEdge.Bottom));
            Assert.IsFalse(MonitorGeometry.IsSittable(TaskbarEdge.Top));
            Assert.IsFalse(MonitorGeometry.IsSittable(TaskbarEdge.Left));
            Assert.IsFalse(MonitorGeometry.IsSittable(TaskbarEdge.Right));
            Assert.IsFalse(MonitorGeometry.IsSittable(TaskbarEdge.None));
        }

        [Test]
        public void 최대화된_창은_모니터를_덮은_것으로_본다()
        {
            Assert.IsTrue(MonitorGeometry.CoversMonitor(Monitor, Monitor));
            // 테두리 없는 전체화면이 1~2px 크게 잡히는 경우가 있다.
            Assert.IsTrue(MonitorGeometry.CoversMonitor(new Rect(-1f, -1f, 1922f, 1082f), Monitor));
            Assert.IsFalse(MonitorGeometry.CoversMonitor(new Rect(0f, 0f, 1920f, 1032f), Monitor));
            Assert.IsFalse(MonitorGeometry.CoversMonitor(new Rect(200f, 100f, 800f, 600f), Monitor));
        }
    }
}
