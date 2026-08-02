using System.Collections.Generic;
using UnityEngine;

namespace WaifuAvatar.Window
{
    /// <summary>
    /// 창이 화면 밖으로 사라지지 않게 붙잡는다.
    ///
    /// 투명하고 클릭이 통과하는 창이라 **화면 밖으로 나가면 되찾을 방법이 없다.**
    /// 보이지도 않고 눌리지도 않으니 설정을 열어 위치를 되돌리는 것 말고는 길이 없다.
    ///
    /// 다중 모니터에서 단순히 "주 모니터 안에 가둔다" 로 하면 보조 모니터로 옮길 수
    /// 없게 된다. 그래서 **어느 모니터든 하나에는 걸쳐 있게** 하는 방식을 쓴다.
    ///
    /// 씬을 모르는 순수 기하라 EditMode 에서 통째로 테스트한다.
    /// </summary>
    public static class ScreenClamp
    {
        /// <summary>
        /// 아바타가 이만큼은 화면 안에 남아 있어야 한다(px).
        ///
        /// 완전히 가두지 않는 이유: 모니터 경계에 걸친 자세가 자연스러울 때가 있고,
        /// 화면 끝에 반쯤 걸터앉는 것도 데스크탑 펫에서는 흔한 배치다.
        /// 다만 되찾을 수 있을 만큼은 남겨야 한다.
        /// </summary>
        public const float MinVisible = 80f;

        /// <summary>
        /// 창을 가장 많이 겹치는 모니터 쪽으로 붙잡는다.
        ///
        /// @param position 창의 좌상단 (모니터 좌표계)
        /// @param size 창 크기
        /// @param monitors 모니터 사각형들. 비어 있으면 아무것도 하지 않는다.
        /// </summary>
        public static Vector2 Clamp(Vector2 position, Vector2 size, IReadOnlyList<Rect> monitors)
        {
            if (monitors == null || monitors.Count == 0) return position;

            var window = new Rect(position.x, position.y, size.x, size.y);
            var host = BestMonitor(window, monitors);

            // 창이 모니터보다 크면 가두는 것 자체가 불가능하다. 좌상단만 맞춘다 —
            // 그러지 않으면 min > max 가 되어 Clamp 가 이상한 값을 뱉는다.
            var visibleX = Mathf.Min(MinVisible, size.x);
            var visibleY = Mathf.Min(MinVisible, size.y);

            var minX = host.xMin - (size.x - visibleX);
            var maxX = host.xMax - visibleX;
            var minY = host.yMin - (size.y - visibleY);
            var maxY = host.yMax - visibleY;

            return new Vector2(
                Mathf.Clamp(position.x, Mathf.Min(minX, maxX), Mathf.Max(minX, maxX)),
                Mathf.Clamp(position.y, Mathf.Min(minY, maxY), Mathf.Max(minY, maxY)));
        }

        /// <summary>
        /// 가장 많이 겹치는 모니터. 어디에도 안 겹치면 중심이 제일 가까운 것.
        ///
        /// 겹침이 0 일 때 첫 모니터로 떨어뜨리면, 보조 모니터 바깥으로 조금 넘어간
        /// 창이 갑자기 주 모니터로 순간이동한다.
        /// </summary>
        public static Rect BestMonitor(Rect window, IReadOnlyList<Rect> monitors)
        {
            var best = monitors[0];
            var bestOverlap = -1f;
            var bestDistance = float.MaxValue;

            foreach (var monitor in monitors)
            {
                var overlap = OverlapArea(window, monitor);
                if (overlap > bestOverlap)
                {
                    bestOverlap = overlap;
                    best = monitor;
                    bestDistance = Vector2.Distance(window.center, monitor.center);
                }
                else if (Mathf.Approximately(overlap, bestOverlap) && overlap <= 0f)
                {
                    var distance = Vector2.Distance(window.center, monitor.center);
                    if (distance < bestDistance)
                    {
                        bestDistance = distance;
                        best = monitor;
                    }
                }
            }
            return best;
        }

        public static float OverlapArea(Rect a, Rect b)
        {
            var w = Mathf.Min(a.xMax, b.xMax) - Mathf.Max(a.xMin, b.xMin);
            var h = Mathf.Min(a.yMax, b.yMax) - Mathf.Max(a.yMin, b.yMin);
            if (w <= 0f || h <= 0f) return 0f;
            return w * h;
        }

        /// <summary>
        /// 정규화 앵커(0..1, 좌하단 기준) -> 창 좌상단 좌표.
        ///
        /// Unity 화면 좌표는 좌하단 원점이지만 창 위치는 좌상단 기준이다.
        /// 그대로 넣으면 위아래가 뒤집힌 자리에 뜬다.
        /// </summary>
        public static Vector2 FromAnchor(Vector2 anchor, Vector2 size, Rect monitor)
        {
            var x = monitor.xMin + (monitor.width - size.x) * Mathf.Clamp01(anchor.x);
            var y = monitor.yMin + (monitor.height - size.y) * (1f - Mathf.Clamp01(anchor.y));
            return new Vector2(x, y);
        }

        /// <summary>창 좌상단 좌표 -> 정규화 앵커. 위치를 저장할 때 쓴다.</summary>
        public static Vector2 ToAnchor(Vector2 position, Vector2 size, Rect monitor)
        {
            var freeX = monitor.width - size.x;
            var freeY = monitor.height - size.y;
            var x = freeX > 0f ? (position.x - monitor.xMin) / freeX : 0f;
            var y = freeY > 0f ? (position.y - monitor.yMin) / freeY : 0f;
            return new Vector2(Mathf.Clamp01(x), Mathf.Clamp01(1f - y));
        }
    }
}
