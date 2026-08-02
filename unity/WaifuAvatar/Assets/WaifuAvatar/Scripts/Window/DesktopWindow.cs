using Kirurobo;
using UnityEngine;

namespace WaifuAvatar.Window
{
    /// <summary>
    /// 투명·항상위·클릭통과 데스크탑 창.
    ///
    /// 실제 창 조작은 UniWindowController(MIT, © Kirurobo)가 한다. 여기는 그것을
    /// 우리 설정에 맞게 세우고, 마우스가 아바타 위에 있는지를 브리지로 올리는 얇은 층이다.
    ///
    /// **클릭 통과는 직접 토글하지 않는다.** UniWindowController 의 알파 히트 테스트
    /// (<c>isHitTestEnabled</c>)가 픽셀 알파를 보고 자동으로 켜고 끈다. 직접 켜고 끄면
    /// 드래그 도중 커서가 실루엣 밖으로 나갔을 때 클릭 통과로 되돌아가 mouseup 을
    /// 놓치고, 드래그가 영원히 안 끝난다.
    /// </summary>
    [RequireComponent(typeof(UniWindowController))]
    public class DesktopWindow : MonoBehaviour
    {
        UniWindowController _window;

        /// <summary>커서가 아바타 위 불투명 픽셀에 올라갔는지 바뀌었다.</summary>
        public event System.Action<bool> HoverChanged;

        bool _lastHover;

        public bool IsOver => _lastHover;

        void Awake()
        {
            _window = GetComponent<UniWindowController>();
        }

        /// <param name="hitAlpha">0..255 로 오는 설정값. UniWinC 는 0..1 을 쓴다.</param>
        public void Configure(bool alwaysOnTop, int hitAlpha)
        {
            if (_window == null) _window = GetComponent<UniWindowController>();
            if (_window == null)
            {
                Debug.LogError("[waifu] UniWindowController 가 없다. 창을 투명하게 만들 수 없다.");
                return;
            }

            _window.isTransparent = true;
            _window.isTopmost = alwaysOnTop;
            _window.forceWindowed = true;

            // 실루엣 가장자리까지 잡되, 커서가 몸에 닿기 전에 전환이 끝나야
            // 첫 클릭을 잃지 않는다.
            _window.isHitTestEnabled = true;
            _window.opacityThreshold = Mathf.Clamp01(hitAlpha / 255f);

            Debug.Log($"[waifu] 창 설정 — 투명=on, 항상위={alwaysOnTop}, " +
                      $"히트 임계값={_window.opacityThreshold:F3}");
        }

        /// <param name="anchor">0..1 정규화, **좌하단 기준** (protocol.ts 의 avatar.anchor).</param>
        public void Place(Vector2 anchor)
        {
            if (_window == null) return;

            var monitor = UniWindowController.GetMonitorRect(0);
            var size = _window.windowSize;

            // Unity 화면 좌표는 좌하단 원점이지만 창 위치는 좌상단 기준이다.
            // 그대로 넣으면 위아래가 뒤집힌 자리에 뜬다.
            var x = monitor.xMin + (monitor.width - size.x) * Mathf.Clamp01(anchor.x);
            var y = monitor.yMin + (monitor.height - size.y) * (1f - Mathf.Clamp01(anchor.y));

            _window.windowPosition = new Vector2(x, y);
            Debug.Log($"[waifu] 창 위치 {_window.windowPosition} (모니터 {monitor})");
        }

        void Update()
        {
            if (_window == null) return;

            // 클릭 통과 여부가 곧 "아바타 위에 있는가" 다. 통과 중이면 아바타 밖이다.
            var over = !_window.isClickThrough;
            if (over == _lastHover) return;

            _lastHover = over;
            HoverChanged?.Invoke(over);
        }
    }
}
