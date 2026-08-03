using System;
using System.Collections.Generic;
using Kirurobo;
using UnityEngine;

namespace WaifuAvatar.Window
{
    /// <summary>
    /// 아바타를 다른 창의 윗변이나 작업표시줄에 걸터앉힌다.
    ///
    /// 이 파일은 <see cref="WindowSitPolicy"/>(규칙)와 <see cref="DesktopWindows"/>
    /// (Win32)를 실제 씬에 **붙이는** 일만 한다. 판정도 P/Invoke 도 여기 없다.
    ///
    /// Mate-Engine X3.3.0 의 <c>AvatarWindowHandler</c> 에서 좌석 정렬과 창 추종을
    /// 가져오되 두 가지를 바꿨다:
    ///
    ///  - **좌석 오프셋을 자세가 바뀌는 동안만 갱신하고 그 뒤에는 얼린다.** 상류는
    ///    앉는 순간 아바타 경계 상자를 이분 탐색해 좌석 높이를 구하고 한 프레임 뒤
    ///    한 번 더 보정한다. 우리는 그냥 매 프레임 실측하되 <see cref="SettleSec"/>
    ///    동안만 기록한다 — 계속 실측하면 호흡으로 엉덩이가 오르내릴 때마다 창이
    ///    반대로 움직여 아바타는 굳고 창만 스멀스멀 기어간다.
    ///  - **오클루전 쿼드를 쓰지 않는다.** 상류는 앞 창들의 사각형만큼 깊이 전용
    ///    쿼드를 세워 다리를 가린다. 우리 셸은 창 하나에 아바타 하나뿐이라 그
    ///    복잡도를 감당할 이유가 없고, 대신 가려진 창에는 애초에 앉지 않는다.
    /// </summary>
    public class WindowSitter : MonoBehaviour
    {
        /// <summary>창 사각형을 다시 훑는 주기. 끌고 있을 때만 촘촘히 본다.</summary>
        const float ScanHzDragging = 15f;
        const float ScanHzIdle = 6f;

        /// <summary>앉는 모션이 자리를 잡는 동안 좌석 위치를 계속 실측하는 시간.</summary>
        const float SettleSec = 0.7f;

        /// <summary>창을 목표 위치로 끌어오는 시간 상수. 크면 물컹하고 작으면 튄다.</summary>
        const float FollowSmoothing = 0.1f;
        const float FollowMaxSpeed = 6000f;

        [SerializeField] Camera _camera;

        readonly WindowSitPolicy _policy = new WindowSitPolicy();
        readonly List<SitCandidate> _candidates = new List<SitCandidate>(64);

        UniWindowController _controller;
        Transform _hips;
        Transform _legL;
        Transform _legR;
        Transform _head;
        Transform _footL;
        Transform _footR;

        long _self;
        float _scanTimer;
        float _settleTimer;
        Vector2 _seatOffset;
        Vector2 _followVelocity;
        float _scale = 1f;

        /// <summary>설정에서 켰나. 끄면 즉시 일어난다.</summary>
        public bool Allowed { get; set; }

        /// <summary>작업표시줄도 앉을 자리로 볼지.</summary>
        public bool AllowTaskbar { get; set; } = true;

        public bool Sitting => _policy.Sitting;

        /// <summary>앉거나 일어났다. 인자는 앉았는지 여부.</summary>
        public event Action<bool> SittingChanged;

        void Awake()
        {
            _controller = UniWindowController.current;
            if (_camera == null) _camera = Camera.main;

            // 우리 창의 HWND. UniWindowController 는 핸들을 노출하지 않는다.
            _self = ResolveSelfWindow();

            if (!DesktopWindows.Supported)
            {
                Debug.Log("[waifu] 창 앉기는 Windows 전용이다. 이 플랫폼에서는 꺼진 채로 돈다.");
            }
        }

        static long ResolveSelfWindow()
        {
            try
            {
                return System.Diagnostics.Process.GetCurrentProcess().MainWindowHandle.ToInt64();
            }
            catch (Exception e)
            {
                // 핸들을 못 얻으면 자기 자신도 후보에 들어간다. 그러면 아바타가
                // 자기 창 윗변에 앉으려 하며 창이 매 프레임 도망간다.
                Debug.LogWarning($"[waifu] 창 핸들을 얻지 못했다. 창 앉기를 끈다 — {e.Message}");
                return 0L;
            }
        }

        /// <summary>모델이 바뀌면 좌석을 잡을 본을 다시 찾는다.</summary>
        public void Bind(Animator animator)
        {
            _hips = _legL = _legR = _head = _footL = _footR = null;
            if (animator == null || !animator.isHuman) return;

            _hips = animator.GetBoneTransform(HumanBodyBones.Hips);
            _legL = animator.GetBoneTransform(HumanBodyBones.LeftUpperLeg);
            _legR = animator.GetBoneTransform(HumanBodyBones.RightUpperLeg);
            _head = animator.GetBoneTransform(HumanBodyBones.Head);
            _footL = animator.GetBoneTransform(HumanBodyBones.LeftFoot);
            _footR = animator.GetBoneTransform(HumanBodyBones.RightFoot);
        }

        /// <summary>배율이 바뀌면 판정 반경과 좌석 오프셋이 전부 달라진다.</summary>
        public void SetScale(float scale)
        {
            _scale = Mathf.Max(0.01f, scale);
            Recalibrate();
        }

        /// <summary>좌석 오프셋을 다시 실측한다. 모션이나 배율이 바뀐 직후에 부른다.</summary>
        public void Recalibrate() => _settleTimer = SettleSec;

        /// <summary>강제로 일으킨다 — 잠들거나, 말하기 시작하거나, 설정이 꺼졌다.</summary>
        public void Release()
        {
            if (_policy.Release().Change == SitChange.Released) SittingChanged?.Invoke(false);
        }

        /// <summary>
        /// <c>LateUpdate</c> 인 이유가 둘이다.
        ///
        ///  1. 애니메이션이 본을 다 쓴 뒤라야 엉덩이 위치가 이번 프레임의 최종값이다.
        ///  2. <see cref="AvatarDragger"/> 가 <c>Update</c> 에서 창을 옮긴다. 앉아 있는
        ///     동안에는 그 결과를 덮어써야 하는데, 컴포넌트 실행 순서는 보장되지 않아
        ///     같은 <c>Update</c> 안에서는 어느 쪽이 이길지 알 수 없다.
        /// </summary>
        void LateUpdate()
        {
            if (_controller == null) _controller = UniWindowController.current;
            if (_controller == null || _camera == null || _self == 0L) return;

            var delta = Time.deltaTime;
            var dragging = IsDragging();

            Scan(delta, dragging);

            var input = new SitInput
            {
                Enabled = Allowed && DesktopWindows.Supported,
                Dragging = dragging,
                Probe = SeatDesktop(),
                Cursor = UniWindowController.GetCursorPosition(),
                Scale = _scale,
                Candidates = _candidates,
            };

            var decision = _policy.Update(delta, input);
            if (decision.Change == SitChange.Snapped)
            {
                _settleTimer = SettleSec;
                _followVelocity = Vector2.zero;
                Debug.Log($"[waifu] 창에 앉는다 — {(decision.IsTaskbar ? "작업표시줄" : "창 " + decision.Id)} " +
                          $"가로 {decision.Fraction:F2}");
                SittingChanged?.Invoke(true);
            }
            else if (decision.Change == SitChange.Released)
            {
                Debug.Log("[waifu] 창에서 일어난다");
                SittingChanged?.Invoke(false);
            }

            if (_policy.Sitting) Follow(delta);
        }

        bool IsDragging()
        {
            return (UniWindowController.GetMouseButtons() & UniWindowController.MouseButton.Left) != 0;
        }

        void Scan(float delta, bool dragging)
        {
            _scanTimer -= delta;
            if (_scanTimer > 0f) return;
            _scanTimer = 1f / (dragging || _policy.Sitting ? ScanHzDragging : ScanHzIdle);

            if (!Allowed || !DesktopWindows.Supported)
            {
                _candidates.Clear();
                return;
            }

            DesktopWindows.Collect(_candidates, _self, AllowTaskbar);

            // 가려진 창은 후보에서 뺀다. 앉고 나서 판정하면 이미 남의 창 위에 올라가 있다.
            // 앉아 있는 창은 빼지 않는다 — 앉은 뒤 다른 창이 위로 올라왔다고 해서
            // 아바타가 갑자기 튕겨나가면 그쪽이 더 놀랍다.
            if (!_policy.Sitting)
            {
                var probe = SeatDesktop();
                for (var i = _candidates.Count - 1; i >= 0; i--)
                {
                    if (DesktopWindows.IsOccludedAt(_candidates[i].Id, probe, _self)) _candidates.RemoveAt(i);
                }
            }
        }

        void Follow(float delta)
        {
            if (!DesktopWindows.TryGetRect(_policy.SittingId, out var rect))
            {
                Release();
                return;
            }

            var windowPosition = _controller.windowPosition;
            var live = SeatDesktop() - windowPosition;

            // 자세가 바뀌는 동안만 좌석 위치를 기록한다. 이 값은 창 위치와 무관하게
            // 자세에만 의존하므로, 여기서 창을 옮겨도 되먹임이 생기지 않는다.
            if (_settleTimer > 0f)
            {
                _settleTimer -= delta;
                _seatOffset = live;
            }

            var desired = new Vector2(rect.xMin + _policy.Fraction * rect.width, rect.yMin);
            var target = desired - _seatOffset;

            _controller.windowPosition = Vector2.SmoothDamp(
                windowPosition, target, ref _followVelocity, FollowSmoothing, FollowMaxSpeed, delta);
        }

        /// <summary>
        /// 엉덩이가 닿을 한 점을 데스크탑 픽셀로 준다.
        ///
        /// 골반 자체가 아니라 허벅지 평균에서 키의 12% 만큼 내린 자리다 — 골반은
        /// 몸 안쪽 깊숙이 있어서 그 점을 창 윗변에 맞추면 아바타가 창에 파묻힌다.
        /// 비율은 상류에서 가져왔다.
        /// </summary>
        Vector2 SeatDesktop()
        {
            var world = SeatWorld();
            return ToDesktop(world);
        }

        Vector3 SeatWorld()
        {
            if (_hips == null) return transform.position;

            var pelvis = _hips.position;
            var thigh = _legL != null && _legR != null ? (_legL.position + _legR.position) * 0.5f : pelvis;

            var headY = _head != null ? _head.position.y : pelvis.y + 0.5f;
            var footY = pelvis.y;
            if (_footL != null) footY = _footL.position.y;
            if (_footR != null) footY = Mathf.Min(footY, _footR.position.y);

            var height = Mathf.Max(0.1f, headY - footY);
            return thigh + Vector3.down * Mathf.Clamp(height * 0.12f, 0.01f, height * 0.5f);
        }

        /// <summary>
        /// 월드 좌표 -> 데스크탑 픽셀.
        ///
        /// 원점은 창 좌상단, 배율은 클라이언트 크기 대 카메라 픽셀이다. 우리 창은
        /// 테두리도 제목 표시줄도 없는 투명 창이라 창 사각형과 클라이언트 영역이
        /// 일치한다. (UniWindowController 는 클라이언트 **위치**를 노출하지 않는다 —
        /// 노출시키려면 vendoring 한 MIT 코드를 고쳐야 하는데, 테두리가 없는 이상
        /// 얻는 게 없다.)
        ///
        /// <see cref="Follow"/> 는 어차피 좌석과 창 원점의 차이만 쓰므로 원점이 상수만큼
        /// 어긋나도 상쇄된다. 어긋남이 실제로 문제가 되는 곳은 정책에 넘기는 탐침뿐이고,
        /// 거기서도 테두리가 없으면 오차가 0 이다.
        ///
        /// Unity 화면 좌표는 좌하단 원점, 데스크탑은 좌상단 원점이라 y 를 뒤집는다.
        /// </summary>
        Vector2 ToDesktop(Vector3 world)
        {
            var screen = _camera.WorldToScreenPoint(world);
            var origin = _controller.windowPosition;
            var client = _controller.clientSize;
            var pxW = Mathf.Max(1, _camera.pixelWidth);
            var pxH = Mathf.Max(1, _camera.pixelHeight);
            var width = client.x > 0f ? client.x : pxW;
            var height = client.y > 0f ? client.y : pxH;

            return new Vector2(
                origin.x + screen.x * (width / pxW),
                origin.y + (pxH - screen.y) * (height / pxH));
        }
    }
}
