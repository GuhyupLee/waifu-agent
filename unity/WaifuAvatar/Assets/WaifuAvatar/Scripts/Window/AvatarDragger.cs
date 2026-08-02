using System;
using Kirurobo;
using UnityEngine;

namespace WaifuAvatar.Window
{
    /// <summary>
    /// 아바타를 잡아 끌어 창을 옮긴다. 짧게 누르면 클릭으로 본다.
    ///
    /// 입력을 <c>UnityEngine.Input</c> 이 아니라 UniWindowController 의 OS 수준 API
    /// (<c>GetMouseButtons</c>/<c>GetCursorPosition</c>)로 받는다. 이유가 둘이다:
    ///
    ///  1. 레거시 Input Manager 인지 새 Input System 인지에 따라 코드가 갈리지 않는다.
    ///  2. **클릭 통과 중에도 커서를 읽을 수 있다.** Unity 의 입력은 창이 클릭을
    ///     통과시키는 동안 마우스 이벤트를 받지 못한다. 그 상태에서 커서 위치를 알려면
    ///     OS 에 직접 물어보는 수밖에 없다.
    /// </summary>
    public class AvatarDragger : MonoBehaviour
    {
        /// <summary>이 거리(px) 안에서 떼면 드래그가 아니라 클릭이다.</summary>
        const float ClickSlop = 4f;

        [SerializeField] DesktopWindow _window;

        UniWindowController _controller;
        bool _dragging;
        Vector2 _grabCursor;
        Vector2 _grabWindow;
        bool _wasPressed;

        public event Action Clicked;
        public event Action DragStarted;
        public event Action DragEnded;

        public bool IsDragging => _dragging;

        void Awake()
        {
            _controller = UniWindowController.current;
            if (_window == null) _window = GetComponent<DesktopWindow>();
        }

        void Update()
        {
            if (_controller == null) return;

            var pressed = (UniWindowController.GetMouseButtons() & UniWindowController.MouseButton.Left) != 0;
            var cursor = UniWindowController.GetCursorPosition();

            if (pressed && !_wasPressed) OnPress(cursor);
            else if (!pressed && _wasPressed) OnRelease(cursor);
            else if (pressed && _dragging) OnDrag(cursor);

            _wasPressed = pressed;
        }

        void OnPress(Vector2 cursor)
        {
            // 아바타 위가 아니면 우리 일이 아니다. 뒤에 있는 창이 받아야 한다.
            if (_window == null || !_window.IsOver) return;

            _dragging = true;
            _grabCursor = cursor;
            _grabWindow = _controller.windowPosition;
            DragStarted?.Invoke();
        }

        void OnDrag(Vector2 cursor)
        {
            // 잡은 순간의 창 위치에 커서 이동량을 더한다. 매 프레임 현재 위치에
            // 증분을 더하면 반올림 오차가 쌓여 커서와 아바타가 서서히 어긋난다.
            _controller.windowPosition = _grabWindow + (cursor - _grabCursor);
        }

        void OnRelease(Vector2 cursor)
        {
            if (!_dragging) return;
            _dragging = false;

            if (Vector2.Distance(cursor, _grabCursor) <= ClickSlop) Clicked?.Invoke();
            DragEnded?.Invoke();
        }
    }
}
