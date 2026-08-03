using UnityEngine;

namespace WaifuAvatar.Window
{
    /// <summary>
    /// OS 데스크톱 좌표의 커서를 Unity 카메라 좌표로 옮기는 순수 계산.
    ///
    /// Windows/UniWindowController 는 좌상단 원점이고 Unity 카메라는 좌하단 원점이다.
    /// 창 크기와 렌더 버퍼 크기가 DPI 때문에 달라도 비율로 환산한다.
    /// </summary>
    public static class DragTetherMath
    {
        public static bool TryCameraPixel(
            Vector2 desktopCursor,
            Vector2 windowPosition,
            Vector2 windowSize,
            int cameraPixelWidth,
            int cameraPixelHeight,
            out Vector2 cameraPixel)
        {
            cameraPixel = Vector2.zero;
            if (windowSize.x <= 0f || windowSize.y <= 0f || cameraPixelWidth <= 0 || cameraPixelHeight <= 0)
                return false;

            var local = desktopCursor - windowPosition;
            var x = local.x / windowSize.x * cameraPixelWidth;
            var y = (1f - local.y / windowSize.y) * cameraPixelHeight;
            if (!IsFinite(x) || !IsFinite(y)) return false;

            cameraPixel = new Vector2(x, y);
            return true;
        }

        /// <summary>손과 목표점의 차이만큼 공통 부모를 옮기면 손이 목표에 고정된다.</summary>
        public static Vector3 RootOffset(Vector3 handWorld, Vector3 targetWorld)
        {
            return targetWorld - handWorld;
        }

        /// <summary>0..1 복귀 시간을 양 끝에서 부드럽게 만든다.</summary>
        public static float SmoothReturn(float progress)
        {
            var p = Mathf.Clamp01(progress);
            return p * p * (3f - 2f * p);
        }

        static bool IsFinite(float value) => !float.IsNaN(value) && !float.IsInfinity(value);
    }
}
