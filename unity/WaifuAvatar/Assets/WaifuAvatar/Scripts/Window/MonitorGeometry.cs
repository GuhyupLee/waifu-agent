using UnityEngine;

namespace WaifuAvatar.Window
{
    /// <summary>작업표시줄이 붙어 있는 변. 없으면 <see cref="None"/>.</summary>
    public enum TaskbarEdge
    {
        None,
        Bottom,
        Top,
        Left,
        Right,
    }

    /// <summary>
    /// 모니터 사각형에서 작업표시줄과 전체화면을 읽어내는 순수 기하.
    ///
    /// Win32 는 작업표시줄 위치를 알려주는 깔끔한 API 가 없다. 대신 모니터 전체
    /// 사각형(<c>rcMonitor</c>)과 작업 영역(<c>rcWork</c>)을 주는데, 둘의 차이가
    /// 곧 작업표시줄이다. 그 차분 계산만 여기로 빼서 EditMode 에서 테스트한다 —
    /// 화면 구성을 바꿔가며 눈으로 확인하는 것은 재현이 안 된다.
    ///
    /// 좌표계는 **데스크탑 픽셀, 좌상단 원점, y 는 아래로 증가**한다. Unity 화면
    /// 좌표(좌하단 원점)와 반대라 섞으면 위아래가 뒤집힌다.
    ///
    /// Mate-Engine X3.3.0 의 <c>MonitorHelper.GetTaskbarRectForWindow</c> 에서
    /// 변 판정을 가져와, P/Invoke 를 떼어내고 어느 변인지를 함께 돌려주도록 고쳤다.
    /// </summary>
    public static class MonitorGeometry
    {
        /// <summary>
        /// 모니터와 작업 영역의 차이에서 작업표시줄을 찾는다.
        ///
        /// 자동 숨김이면 작업 영역이 모니터와 같아 <see cref="TaskbarEdge.None"/> 이
        /// 나온다. 이때 억지로 화면 아래 몇 픽셀을 작업표시줄이라 우기면, 숨겨진
        /// 작업표시줄 위에 아바타가 떠 있게 된다.
        /// </summary>
        public static TaskbarEdge TaskbarFrom(Rect monitor, Rect work, out Rect taskbar)
        {
            // 어느 변이 잘렸는지를 본다. 여러 변이 동시에 잘리는 구성(작업표시줄 +
            // 도킹된 앱 바)에서는 가장 두꺼운 쪽을 작업표시줄로 본다 — 그쪽이
            // 아바타가 앉을 만한 유일한 후보다.
            var bottom = monitor.yMax - work.yMax;
            var top = work.yMin - monitor.yMin;
            var left = work.xMin - monitor.xMin;
            var right = monitor.xMax - work.xMax;

            var thickest = Mathf.Max(Mathf.Max(bottom, top), Mathf.Max(left, right));
            if (thickest <= 0f)
            {
                taskbar = new Rect(0f, 0f, 0f, 0f);
                return TaskbarEdge.None;
            }

            if (thickest == bottom)
            {
                taskbar = new Rect(monitor.xMin, work.yMax, monitor.width, bottom);
                return TaskbarEdge.Bottom;
            }
            if (thickest == top)
            {
                taskbar = new Rect(monitor.xMin, monitor.yMin, monitor.width, top);
                return TaskbarEdge.Top;
            }
            if (thickest == left)
            {
                taskbar = new Rect(monitor.xMin, monitor.yMin, left, monitor.height);
                return TaskbarEdge.Left;
            }

            taskbar = new Rect(work.xMax, monitor.yMin, right, monitor.height);
            return TaskbarEdge.Right;
        }

        /// <summary>
        /// 이 작업표시줄에 앉을 수 있나.
        ///
        /// 아래쪽에 붙어 있을 때만 허용한다. 위·좌·우 도킹에서도 "윗변"은 존재하지만
        /// 거기 앉으면 화면 맨 위 모서리나 세로 막대 꼭대기에 매달린 모양이 된다.
        /// 상류는 아래 도킹만 가정하고 만들어져 이 경우를 구분하지 않는다.
        /// </summary>
        public static bool IsSittable(TaskbarEdge edge) => edge == TaskbarEdge.Bottom;

        /// <summary>
        /// 창이 모니터를 통째로 덮고 있나 (최대화·전체화면).
        ///
        /// 전체화면 창 위에는 앉지 않는다. 앉을 윗변이 화면 밖이거나 화면 맨 위라
        /// 아바타가 잘리고, 영상이나 게임을 가리는 것도 대개 원치 않는 동작이다.
        ///
        /// 테두리 없는 전체화면이 모니터보다 1~2px 크게 잡히는 경우가 있어
        /// 허용 오차를 둔다.
        /// </summary>
        public static bool CoversMonitor(Rect window, Rect monitor, float tolerance = 2f)
        {
            return window.xMin <= monitor.xMin + tolerance
                && window.yMin <= monitor.yMin + tolerance
                && window.xMax >= monitor.xMax - tolerance
                && window.yMax >= monitor.yMax - tolerance;
        }
    }
}
