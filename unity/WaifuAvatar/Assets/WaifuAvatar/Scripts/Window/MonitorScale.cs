using UnityEngine;

namespace WaifuAvatar.Window
{
    /// <summary>
    /// 아바타가 서 있는 모니터의 해상도에 맞춰 배율을 보정한다.
    ///
    /// 같은 픽셀 크기라도 4K 모니터에서는 물리적으로 절반만 하다. 4K 주 모니터와
    /// FHD 보조 모니터를 섞어 쓰면 한쪽에 맞춘 크기가 다른 쪽에서 반드시 어긋난다 —
    /// 취향 문제가 아니라 그냥 잘못 보이는 것이다.
    ///
    /// **DPI 배율은 곱하지 않는다.** 창 좌표와 크기가 이미 물리 픽셀이라, 거기에
    /// Windows 표시 배율을 또 곱하면 150% 로 설정한 4K 화면에서 아바타가 1.5배
    /// 더 커진다. 해상도만 보면 표시 배율을 어떻게 두었든 물리 크기가 일정해진다.
    /// (그래서 Shcore.dll 의 GetDpiForMonitor 도 쓰지 않는다.)
    ///
    /// 순수 계산이라 EditMode 에서 테스트한다.
    /// </summary>
    public static class MonitorScale
    {
        /// <summary>
        /// 사용자가 정한 배율에 곱할 값.
        /// </summary>
        /// <param name="monitorHeight">아바타가 있는 모니터의 세로 해상도(px).</param>
        /// <param name="referenceHeight">이 해상도에서 보정이 1이 된다.</param>
        /// <param name="min">하한. 세로가 아주 작은 화면에서 아바타가 사라지지 않게.</param>
        /// <param name="max">상한. 세로로 아주 긴 모니터에서 화면을 덮지 않게.</param>
        public static float Factor(float monitorHeight, float referenceHeight, float min, float max)
        {
            if (monitorHeight <= 0f || referenceHeight <= 0f) return 1f;

            // 상한과 하한이 뒤집혀 들어와도 Clamp 가 이상한 값을 뱉지 않게 한다.
            var low = Mathf.Min(min, max);
            var high = Mathf.Max(min, max);
            return Mathf.Clamp(monitorHeight / referenceHeight, low, high);
        }
    }
}
