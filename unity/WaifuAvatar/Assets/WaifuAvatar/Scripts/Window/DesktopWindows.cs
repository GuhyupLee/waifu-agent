using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using UnityEngine;

namespace WaifuAvatar.Window
{
    /// <summary>
    /// 데스크탑의 다른 창들을 훑는 얇은 Windows 계층.
    ///
    /// **여기 말고 다른 곳에 Win32 를 쓰지 마라.** 다른 OS 에서는 이 파일 전체가
    /// "후보 없음" 을 돌려주고, 창 앉기 기능만 조용히 꺼진 채 앱은 계속 돈다.
    /// 규칙은 <see cref="WindowSitPolicy"/> 와 <see cref="MonitorGeometry"/> 에 있고
    /// 그쪽은 플랫폼을 모른다.
    ///
    /// P/Invoke 시그니처와 창 필터 조건은 Mate-Engine X3.3.0 의
    /// <c>AvatarWindowHandler</c> / <c>MonitorHelper</c> 에서 가져왔다.
    /// 이 필터가 없으면 후보 목록이 유령으로 가득 찬다 — 화면에 아무것도 안 보이는
    /// 은폐된 UWP 창, 다른 데스크탑 펫의 투명 창, 알림 배너의 잔재까지 전부
    /// "앉을 수 있는 창" 으로 나온다.
    /// </summary>
    public static class DesktopWindows
    {
        /// <summary>Windows 가 아니면 전부 빈 결과다. 호출하는 쪽은 분기하지 않아도 된다.</summary>
        public static bool Supported =>
#if UNITY_STANDALONE_WIN || UNITY_EDITOR_WIN
            true;
#else
            false;
#endif

#if UNITY_STANDALONE_WIN || UNITY_EDITOR_WIN

        const int GwlStyle = -16;
        const int GwlExStyle = -20;

        const long WsCaption = 0x00C00000L;
        const long WsExLayered = 0x00080000L;
        const long WsExTransparent = 0x00000020L;
        const long WsExToolWindow = 0x00000080L;
        const long WsExNoActivate = 0x08000000L;

        const uint LwaColorKey = 0x00000001;
        const uint LwaAlpha = 0x00000002;

        const uint GaRoot = 2;
        const uint GwHwndPrev = 3;

        const int DwmwaCloaked = 14;

        const uint MonitorDefaultToNearest = 0x00000002;

        /// <summary>이 값 이하로 반투명한 창은 "안 보이는 것" 으로 친다.</summary>
        const int LayeredAlphaIgnoreBelow = 230;

        [StructLayout(LayoutKind.Sequential)]
        struct Rect32
        {
            public int Left, Top, Right, Bottom;

            public Rect ToRect() => new Rect(Left, Top, Right - Left, Bottom - Top);
        }

        [StructLayout(LayoutKind.Sequential)]
        struct MonitorInfo
        {
            public int cbSize;
            public Rect32 rcMonitor;
            public Rect32 rcWork;
            public uint dwFlags;
        }

        delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool GetWindowRect(IntPtr hWnd, out Rect32 rect);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetClassNameW")]
        static extern int GetClassName(IntPtr hWnd, StringBuilder buffer, int max);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetWindowTextLengthW")]
        static extern int GetWindowTextLength(IntPtr hWnd);

        // GWL_STYLE / GWL_EXSTYLE 은 32bit 값이라 64bit 에서도 GetWindowLongW 로 충분하다.
        // 포인터 크기 인덱스(GWLP_WNDPROC 등)를 읽을 때만 GetWindowLongPtr 이 필요하다.
        [DllImport("user32.dll", EntryPoint = "GetWindowLongW", SetLastError = true)]
        static extern int GetWindowLong(IntPtr hWnd, int index);

        [DllImport("user32.dll")]
        static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);

        [DllImport("user32.dll")]
        static extern IntPtr GetParent(IntPtr hWnd);

        [DllImport("user32.dll")]
        static extern IntPtr GetWindow(IntPtr hWnd, uint command);

        [DllImport("user32.dll")]
        static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool GetLayeredWindowAttributes(IntPtr hWnd, out uint key, out byte alpha, out uint flags);

        [DllImport("user32.dll")]
        static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetMonitorInfoW")]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);

        [DllImport("dwmapi.dll")]
        static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out int value, int size);

        [DllImport("kernel32.dll")]
        static extern uint GetCurrentProcessId();

        // 열거는 초당 수 회 돌아간다. 델리게이트와 버퍼를 매번 새로 만들면
        // 그만큼이 매 프레임 GC 압력이 된다.
        static readonly StringBuilder ClassBuffer = new StringBuilder(256);
        static readonly EnumWindowsProc Callback = OnWindow;
        static List<SitCandidate> _sink;
        static IntPtr _self;
        static uint _selfPid;
        static Rect _monitorBounds;
        static Rect _taskbarRect;
        static bool _taskbarSittable;

        /// <summary>
        /// 앉을 수 있는 창 후보를 모은다. 결과는 <paramref name="into"/> 를 비우고 채운다.
        /// </summary>
        /// <param name="self">우리 창의 HWND. UniWindowController 가 준다.</param>
        /// <param name="includeTaskbar">작업표시줄도 후보에 넣을지. 설정에서 따로 끈다.</param>
        public static void Collect(List<SitCandidate> into, long self, bool includeTaskbar)
        {
            into.Clear();
            _sink = into;
            _self = new IntPtr(self);
            _selfPid = GetCurrentProcessId();

            // 전체화면 판정과 작업표시줄은 **우리 창이 있는 모니터** 기준이다.
            // Display.main 을 쓰면 보조 모니터에서 전부 어긋난다.
            _monitorBounds = new Rect(0f, 0f, 0f, 0f);
            _taskbarSittable = false;
            if (TryGetMonitor(_self, out var monitor, out var work))
            {
                _monitorBounds = monitor;
                var edge = MonitorGeometry.TaskbarFrom(monitor, work, out _taskbarRect);
                _taskbarSittable = includeTaskbar && MonitorGeometry.IsSittable(edge);
            }

            EnumWindows(Callback, IntPtr.Zero);

            // 작업표시줄은 창으로 열거되지만(Shell_TrayWnd) 위 필터를 통과하지 못한다 —
            // 제목이 없고 크기 조건에도 안 맞는다. 그래서 따로 넣는다.
            if (_taskbarSittable && _taskbarRect.width > 0f && _taskbarRect.height > 0f)
            {
                into.Add(new SitCandidate { Id = TaskbarId, Rect = _taskbarRect, IsTaskbar = true });
            }

            _sink = null;
        }

        /// <summary>
        /// 작업표시줄에 주는 가짜 HWND.
        ///
        /// 실제 Shell_TrayWnd 핸들을 쓰지 않는 이유: 우리가 쓰는 사각형은 그 창의
        /// 실제 사각형이 아니라 모니터와 작업 영역의 차분이다. 둘을 같은 id 로
        /// 취급하면 나중에 <see cref="TryGetRect"/> 가 다른 값을 돌려준다.
        /// </summary>
        public const long TaskbarId = -1L;

        static bool OnWindow(IntPtr hWnd, IntPtr lParam)
        {
            if (hWnd == _self) return true;
            if (!IsWindowVisible(hWnd) || IsIconic(hWnd)) return true;
            if (!GetWindowRect(hWnd, out var raw)) return true;

            // 같은 프로세스의 창은 건너뛴다. 우리 자신과 우리가 띄운 보조 창들이다.
            GetWindowThreadProcessId(hWnd, out var pid);
            if (pid == _selfPid) return true;

            // 최상위 창만. 자식 창이나 소유된 팝업은 자기 부모와 같이 움직인다.
            if (GetParent(hWnd) != IntPtr.Zero) return true;
            if (GetAncestor(hWnd, GaRoot) != hWnd) return true;

            // 제목이 없는 창은 대개 사용자에게 보이는 창이 아니다.
            if (GetWindowTextLength(hWnd) == 0) return true;
            if (IsCloaked(hWnd)) return true;

            ClassBuffer.Length = 0;
            GetClassName(hWnd, ClassBuffer, ClassBuffer.Capacity);
            if (IsShellClass(ClassBuffer)) return true;
            if (IsEffectivelyInvisible(hWnd, ClassBuffer)) return true;

            var rect = raw.ToRect();
            // 전체화면 창 위에는 앉지 않는다.
            if (_monitorBounds.width > 0f && MonitorGeometry.CoversMonitor(rect, _monitorBounds)) return true;

            _sink.Add(new SitCandidate { Id = hWnd.ToInt64(), Rect = rect, IsTaskbar = false });
            return true;
        }

        /// <summary>바탕화면과 셸 내부 창들. 여기 앉으면 "허공에 앉은" 모양이 된다.</summary>
        static bool IsShellClass(StringBuilder cls)
        {
            return Equals(cls, "Progman")
                || Equals(cls, "WorkerW")
                || Equals(cls, "DV2ControlHost")
                || Equals(cls, "MsgrIMEWindowClass")
                || Equals(cls, "Shell_TrayWnd")
                || Equals(cls, "Shell_SecondaryTrayWnd")
                || StartsWith(cls, "#");
        }

        /// <summary>
        /// 창은 존재하는데 화면에는 사실상 안 보이는 경우.
        ///
        /// 레이어드 창은 알파나 컬러키로 투명해질 수 있고, 클릭 통과·툴윈도우·
        /// 비활성 플래그가 붙은 것은 대개 다른 데스크탑 오버레이다. 우리 아바타
        /// 자신도 이 조건에 걸리므로, 같은 앱을 두 개 띄워도 서로에게 앉지 않는다.
        /// </summary>
        static bool IsEffectivelyInvisible(IntPtr hWnd, StringBuilder cls)
        {
            var ex = (long)(uint)GetWindowLong(hWnd, GwlExStyle);
            if ((ex & WsExLayered) != 0)
            {
                if ((ex & WsExTransparent) != 0) return true;
                if ((ex & WsExToolWindow) != 0 || (ex & WsExNoActivate) != 0) return true;
                if (GetLayeredWindowAttributes(hWnd, out _, out var alpha, out var flags))
                {
                    if ((flags & LwaColorKey) != 0) return true;
                    if ((flags & LwaAlpha) != 0 && alpha <= LayeredAlphaIgnoreBelow) return true;
                }
            }

            var style = (long)(uint)GetWindowLong(hWnd, GwlStyle);
            // 제목 표시줄이 없고 이름도 거의 없는 창은 장식용 오버레이일 가능성이 높다.
            if ((style & WsCaption) == 0 && GetWindowTextLength(hWnd) <= 1) return true;
            if ((style & WsCaption) == 0 && Equals(cls, "UnityWndClass")) return true;

            return false;
        }

        /// <summary>
        /// 은폐된 창. 최소화와 다르다 — 다른 가상 데스크탑에 있거나 UWP 가 잠재운
        /// 창은 <c>IsWindowVisible</c> 이 여전히 true 를 준다. 이걸 안 거르면
        /// 화면에 없는 창에 아바타가 앉는다.
        /// </summary>
        static bool IsCloaked(IntPtr hWnd)
        {
            return DwmGetWindowAttribute(hWnd, DwmwaCloaked, out var cloaked, sizeof(int)) == 0 && cloaked != 0;
        }

        /// <summary>앉아 있는 창을 매 프레임 따라가기 위해 현재 사각형을 읽는다.</summary>
        public static bool TryGetRect(long id, out Rect rect)
        {
            if (id == TaskbarId)
            {
                rect = _taskbarRect;
                return _taskbarSittable && rect.width > 0f;
            }

            var hWnd = new IntPtr(id);
            if (IsWindowVisible(hWnd) && !IsIconic(hWnd) && !IsCloaked(hWnd) && GetWindowRect(hWnd, out var raw))
            {
                rect = raw.ToRect();
                return true;
            }

            rect = new Rect(0f, 0f, 0f, 0f);
            return false;
        }

        /// <summary>
        /// 이 점에서 대상 창보다 위에 있는 창이 있나.
        ///
        /// 앉으려는 창이 다른 창에 가려져 있으면 아바타가 남의 창 위에 떠 있게 된다.
        /// Z 순서는 <c>GW_HWNDPREV</c> 로 앞쪽(더 위)으로 거슬러 올라가며 훑는다.
        /// </summary>
        public static bool IsOccludedAt(long id, Vector2 point, long self)
        {
            if (id == TaskbarId) return false;

            var selfHandle = new IntPtr(self);
            var handle = GetWindow(new IntPtr(id), GwHwndPrev);
            // 순환이 생기면 프레임이 멈춘다. 실제로 창이 2048개 넘게 겹칠 일은 없다.
            for (var guard = 0; guard < 2048 && handle != IntPtr.Zero; guard++)
            {
                if (handle != selfHandle && IsWindowVisible(handle) && !IsCloaked(handle)
                    && GetWindowRect(handle, out var raw))
                {
                    GetWindowThreadProcessId(handle, out var pid);
                    if (pid != _selfPid && raw.ToRect().Contains(point))
                    {
                        ClassBuffer.Length = 0;
                        GetClassName(handle, ClassBuffer, ClassBuffer.Capacity);
                        if (!IsEffectivelyInvisible(handle, ClassBuffer)) return true;
                    }
                }
                handle = GetWindow(handle, GwHwndPrev);
            }
            return false;
        }

        /// <summary>우리 창이 있는 모니터의 전체 사각형과 작업 영역.</summary>
        public static bool TryGetMonitor(long window, out Rect monitor, out Rect work)
        {
            return TryGetMonitor(new IntPtr(window), out monitor, out work);
        }

        static bool TryGetMonitor(IntPtr window, out Rect monitor, out Rect work)
        {
            var handle = MonitorFromWindow(window, MonitorDefaultToNearest);
            var info = new MonitorInfo { cbSize = Marshal.SizeOf(typeof(MonitorInfo)) };
            if (GetMonitorInfo(handle, ref info))
            {
                monitor = info.rcMonitor.ToRect();
                work = info.rcWork.ToRect();
                return true;
            }

            monitor = new Rect(0f, 0f, 0f, 0f);
            work = monitor;
            return false;
        }

        static bool Equals(StringBuilder buffer, string value)
        {
            if (buffer.Length != value.Length) return false;
            for (var i = 0; i < value.Length; i++)
            {
                if (buffer[i] != value[i]) return false;
            }
            return true;
        }

        static bool StartsWith(StringBuilder buffer, string value)
        {
            if (buffer.Length < value.Length) return false;
            for (var i = 0; i < value.Length; i++)
            {
                if (buffer[i] != value[i]) return false;
            }
            return true;
        }

#else
        public const long TaskbarId = -1L;

        public static void Collect(List<SitCandidate> into, long self, bool includeTaskbar) => into.Clear();

        public static bool TryGetRect(long id, out Rect rect)
        {
            rect = new Rect(0f, 0f, 0f, 0f);
            return false;
        }

        public static bool IsOccludedAt(long id, Vector2 point, long self) => false;

        public static bool TryGetMonitor(long window, out Rect monitor, out Rect work)
        {
            monitor = new Rect(0f, 0f, 0f, 0f);
            work = monitor;
            return false;
        }
#endif
    }
}
