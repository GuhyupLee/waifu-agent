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

        Vector2? _pendingAnchor;

        /// <summary>
        /// 아바타를 세울 자리를 예약한다.
        ///
        /// **바로 옮기지 않는다.** UniWindowController 의 네이티브 창 정보는 자기
        /// Awake 가 끝나야 채워지는데, 컴포넌트 Awake 순서는 보장되지 않는다.
        /// 실측에서 이 시점의 `GetMonitorRect(0)` 이 0x0 을 돌려줘 아바타가 설정을
        /// 무시하고 화면 좌상단에 섰다. 모니터 크기가 잡힐 때까지 미룬다.
        /// </summary>
        /// <param name="anchor">0..1 정규화, **좌하단 기준** (protocol.ts 의 avatar.anchor).</param>
        public void Place(Vector2 anchor)
        {
            _pendingAnchor = anchor;
            TryPlace();
        }

        /// <returns>자리를 잡았으면 true. 아직 모니터를 못 읽었으면 false.</returns>
        bool TryPlace()
        {
            if (_window == null || !_pendingAnchor.HasValue) return false;

            var monitor = UniWindowController.GetMonitorRect(0);
            // 0x0 은 "아직 준비 안 됨" 이다. 그대로 쓰면 전부 0 으로 나눠 좌상단에 붙는다.
            if (monitor.width <= 0f || monitor.height <= 0f) return false;

            var size = _window.windowSize;
            if (size.x <= 0f || size.y <= 0f) return false;

            _window.windowPosition = ScreenClamp.FromAnchor(_pendingAnchor.Value, size, monitor);
            Debug.Log($"[waifu] 창 위치 {_window.windowPosition} (모니터 {monitor})");
            _pendingAnchor = null;
            return true;
        }

        void Update()
        {
            if (_window == null) return;

            // 예약된 자리가 있으면 잡힐 때까지 계속 시도한다. 한 번만 시도하고 포기하면
            // 창이 준비되는 프레임을 놓쳐 설정이 조용히 무시된다.
            if (_pendingAnchor.HasValue) TryPlace();

            // 클릭 통과 여부가 곧 "아바타 위에 있는가" 다. 통과 중이면 아바타 밖이다.
            var over = !_window.isClickThrough;
            if (over == _lastHover) return;

            _lastHover = over;
            HoverChanged?.Invoke(over);
        }
    }
}
