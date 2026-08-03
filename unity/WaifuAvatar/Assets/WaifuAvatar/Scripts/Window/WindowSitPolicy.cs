using System.Collections.Generic;
using UnityEngine;

namespace WaifuAvatar.Window
{
    /// <summary>
    /// 앉을 수 있는 창 하나. 데스크탑 픽셀 좌표(좌상단 원점).
    ///
    /// <see cref="Id"/> 는 Win32 의 HWND 지만 정책은 그걸 몰라도 된다. long 으로
    /// 받아 두면 정책 전체를 EditMode 에서 가짜 값으로 돌릴 수 있다.
    /// </summary>
    public struct SitCandidate
    {
        public long Id;
        public Rect Rect;
        public bool IsTaskbar;
    }

    /// <summary>정책이 만든 이번 틱의 결정. 변화가 없으면 <see cref="Change"/> 가 None.</summary>
    public enum SitChange
    {
        None,
        Snapped,
        Released,
    }

    public struct SitInput
    {
        /// <summary>설정에서 껐으면 false. 앉아 있었다면 즉시 일어난다.</summary>
        public bool Enabled;
        public bool Dragging;
        /// <summary>아바타의 엉덩이 근처 한 점 (데스크탑 px). 이게 창 윗변에 닿으면 앉는다.</summary>
        public Vector2 Probe;
        /// <summary>커서 (데스크탑 px). 세로로 크게 끌면 떼어내는 판정에 쓴다.</summary>
        public Vector2 Cursor;
        /// <summary>아바타 배율. 크게 키우면 판정 반경도 같이 커져야 한다.</summary>
        public float Scale;
        public IReadOnlyList<SitCandidate> Candidates;
    }

    public struct SitDecision
    {
        public SitChange Change;
        public long Id;
        public bool IsTaskbar;
        /// <summary>창 가로 어디에 앉았나. 0 왼쪽 끝, 1 오른쪽 끝.</summary>
        public float Fraction;
    }

    /// <summary>
    /// 아바타를 창 윗변이나 작업표시줄에 앉히는 규칙.
    ///
    /// Mate-Engine X3.3.0 의 <c>AvatarWindowHandler</c> 에서 판정 규칙만 추출해
    /// 순수 클래스로 옮겼다. 상류는 Win32 열거·오클루전 쿼드·애니메이터 파라미터·
    /// 창 이동을 한 MonoBehaviour(1000줄)에 다 넣어서, 규칙 하나 고칠 때마다
    /// 실제로 창을 띄워 눈으로 확인하는 것 말고 검증 수단이 없었다.
    ///
    /// **왜 이렇게 조건이 많은가.** 데스크탑 펫에서 "창에 앉기" 는 오작동이 곧
    /// 짜증이다 — 아바타를 그냥 옮기려는데 지나가던 창에 철컥 붙거나, 앉혀 놨는데
    /// 손만 대면 떨어지면 기능이 없느니만 못하다. 아래 여섯 개는 전부 그 두 가지
    /// 실패를 막는 장치이고, 상류에서 실사용으로 다듬어진 값들이다.
    ///
    ///  1. <see cref="MinDragHoldSec"/> — 잡고 잠깐 버텨야 앉는다. 스쳐 지나가면 안 앉는다.
    ///  2. <see cref="MinDragPixels"/> — 제자리 클릭으로는 안 앉는다.
    ///  3. <see cref="LatchTicks"/> — 앉은 직후 몇 틱은 무조건 붙어 있는다. 앉히는
    ///     모션이 시작되며 엉덩이 위치가 흔들리는데, 그걸 "멀어졌다" 로 읽으면
    ///     앉자마자 떨어진다.
    ///  4. <see cref="UnsnapCooldownSec"/> — 뗀 직후 잠깐은 못 앉는다.
    ///  5. <see cref="GuardRadiusPx"/> — 뗀 자리 근처에서는 못 앉는다. 4번만으로는
    ///     쿨다운이 끝나는 순간 같은 창에 다시 붙는다.
    ///  6. 커서 세로 이동 — 앉은 채 가로로 훑는 것은 자리 옮기기, 세로로 끄는 것은
    ///     떼어내기다. 위치만 보면 둘을 구분할 수 없다.
    ///
    /// 시간은 전부 인자로 받는다. <c>Time.unscaledTime</c> 을 직접 읽으면 테스트가
    /// 실시간을 기다려야 한다.
    /// </summary>
    public class WindowSitPolicy
    {
        /// <summary>이만큼 잡고 있어야 앉을 마음이 생긴다(초).</summary>
        public float MinDragHoldSec = 0.8f;

        /// <summary>잡은 자리에서 이만큼은 움직여야 한다(px).</summary>
        public float MinDragPixels = 4f;

        /// <summary>창 윗변에 이 거리 안으로 들어오면 앉는다(px, 배율 곱해짐).</summary>
        public float ProbeRadiusPx = 24f;

        /// <summary>앉은 뒤 이만큼 벗어나면 일어난다(px). 반경보다 작을 수 없다.</summary>
        public float UnsnapBandPx = 16f;

        /// <summary>뗀 자리 주변 이 반경 안에서는 다시 앉지 않는다(px, 배율 곱해짐).</summary>
        public float GuardRadiusPx = 240f;

        public float UnsnapCooldownSec = 0.3f;

        /// <summary>앉은 직후 무조건 붙어 있는 틱 수.</summary>
        public int LatchTicks = 18;

        /// <summary>이보다 작은 창에는 앉지 않는다. 알림 팝업이나 툴팁에 앉으면 우스꽝스럽다.</summary>
        public float MinWindowWidth = 200f;
        public float MinWindowHeight = 60f;

        long _id;
        bool _isTaskbar;
        float _fraction;
        int _latch;
        float _cooldown;
        bool _wasDragging;
        float _dragHeld;
        Vector2 _dragStart;
        float _snapCursorY;
        bool _guardActive;
        Vector2 _guardCenter;

        public bool Sitting => _id != 0L;
        public long SittingId => _id;
        public bool OnTaskbar => _isTaskbar;

        /// <summary>창 가로 어디에 앉아 있나(0..1). 창 크기가 바뀌어도 이 비율은 유지된다.</summary>
        public float Fraction => _fraction;

        public SitDecision Update(float delta, SitInput input)
        {
            _cooldown = Mathf.Max(0f, _cooldown - delta);

            var justPressed = input.Dragging && !_wasDragging;
            if (justPressed)
            {
                _dragStart = input.Cursor;
                _dragHeld = 0f;
            }
            _dragHeld = input.Dragging ? _dragHeld + delta : 0f;
            _wasDragging = input.Dragging;

            // 드래그를 놓으면 가드 존을 푼다. 놓은 뒤에도 남겨두면 다음에 잡았을 때
            // "왜 여기서만 안 앉지" 가 된다.
            if (!input.Dragging) _guardActive = false;

            if (!input.Enabled) return Release(false);
            if (Sitting) return UpdateSitting(input);
            return TrySnap(input);
        }

        SitDecision UpdateSitting(SitInput input)
        {
            if (!TryFind(input.Candidates, _id, out var target)) return Release(false);

            // 끌고 있지 않으면 계속 앉아 있는다. 창이 움직이면 따라간다.
            if (!input.Dragging)
            {
                _latch = 0;
                return None();
            }

            if (_latch > 0)
            {
                _latch--;
                return None();
            }

            if (!StillNear(input, target)) return Release(true, input.Probe);

            // 끄는 동안에는 가로 위치를 따라 옮긴다. 창 위를 미끄러지듯 이동한다.
            _fraction = HorizontalFraction(target.Rect, input.Probe.x);
            return None();
        }

        SitDecision TrySnap(SitInput input)
        {
            if (!input.Dragging) return None();
            if (_cooldown > 0f) return None();
            if (_dragHeld < MinDragHoldSec) return None();
            if (Vector2.Distance(input.Cursor, _dragStart) < MinDragPixels) return None();

            var scale = Mathf.Max(0.01f, input.Scale);
            if (_guardActive)
            {
                var guard = GuardRadiusPx * scale;
                if ((input.Probe - _guardCenter).sqrMagnitude < guard * guard) return None();
                _guardActive = false;
            }

            var reach = ProbeRadiusPx * scale;
            var candidates = input.Candidates;
            if (candidates == null) return None();

            for (var i = 0; i < candidates.Count; i++)
            {
                var candidate = candidates[i];
                if (!IsBigEnough(candidate)) continue;

                var rect = candidate.Rect;
                if (input.Probe.x < rect.xMin || input.Probe.x > rect.xMax) continue;
                if (Mathf.Abs(input.Probe.y - rect.yMin) > reach) continue;

                _id = candidate.Id;
                _isTaskbar = candidate.IsTaskbar;
                _fraction = HorizontalFraction(rect, input.Probe.x);
                _latch = Mathf.Max(1, LatchTicks);
                _snapCursorY = input.Cursor.y;
                _guardActive = false;

                return new SitDecision
                {
                    Change = SitChange.Snapped,
                    Id = _id,
                    IsTaskbar = _isTaskbar,
                    Fraction = _fraction,
                };
            }

            return None();
        }

        /// <summary>
        /// 작업표시줄은 세로로 얇아서 <see cref="MinWindowHeight"/> 에 걸린다.
        /// 그래서 크기 조건에서 빼 준다 — 앉을 수 있는 작업표시줄인지는
        /// <see cref="MonitorGeometry.IsSittable"/> 가 이미 판단했다.
        /// </summary>
        bool IsBigEnough(SitCandidate candidate)
        {
            if (candidate.IsTaskbar) return true;
            return candidate.Rect.width >= MinWindowWidth && candidate.Rect.height >= MinWindowHeight;
        }

        bool StillNear(SitInput input, SitCandidate target)
        {
            var band = Mathf.Max(UnsnapBandPx, ProbeRadiusPx * Mathf.Max(0.01f, input.Scale));
            var rect = target.Rect;

            if (input.Probe.x < rect.xMin || input.Probe.x > rect.xMax) return false;
            if (Mathf.Abs(input.Probe.y - rect.yMin) > band) return false;

            // 앉은 뒤로 커서가 세로로 얼마나 갔나. 아바타는 창에 붙잡혀 있어서
            // 위치만 보면 사용자가 아무리 세게 끌어도 "가까이" 로 나온다.
            if (Mathf.Abs(input.Cursor.y - _snapCursorY) > band) return false;

            return true;
        }

        static float HorizontalFraction(Rect rect, float x)
        {
            return Mathf.Clamp01((x - rect.xMin) / Mathf.Max(1f, rect.width));
        }

        static bool TryFind(IReadOnlyList<SitCandidate> candidates, long id, out SitCandidate found)
        {
            if (candidates != null)
            {
                for (var i = 0; i < candidates.Count; i++)
                {
                    if (candidates[i].Id != id) continue;
                    found = candidates[i];
                    return true;
                }
            }
            found = default;
            return false;
        }

        /// <summary>외부에서 강제로 일으킨다 — 잠들었거나, 창이 최대화됐거나, 설정이 꺼졌다.</summary>
        public SitDecision Release() => Release(false);

        SitDecision Release(bool fromDrag, Vector2 guardCenter = default)
        {
            if (!Sitting) return None();

            _id = 0L;
            _isTaskbar = false;
            _latch = 0;

            if (fromDrag)
            {
                _cooldown = Mathf.Max(0f, UnsnapCooldownSec);
                _guardActive = true;
                _guardCenter = guardCenter;
            }

            return new SitDecision { Change = SitChange.Released };
        }

        static SitDecision None() => new SitDecision { Change = SitChange.None };
    }
}
