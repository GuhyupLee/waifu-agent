using Kirurobo;
using UnityEngine;

namespace WaifuAvatar.Window
{
    /// <summary>
    /// <see cref="RoamPlanner"/> 의 결정을 실제 창 이동으로 옮긴다.
    ///
    /// 아바타 실루엣의 가로 범위를 매 프레임 실측해 계획기에 준다 — 투명 창은
    /// 아바타보다 훨씬 넓어서 창 사각형으로 재면 화면 끝에서 한참 떨어진 곳에서
    /// 멈춘다. 상류가 avatar bounds blocking 을 따로 만든 이유가 이것이다.
    /// </summary>
    public class Roamer : MonoBehaviour
    {
        [SerializeField] Camera _camera;
        [SerializeField] AvatarDragger _dragger;
        [SerializeField] WindowSitter _sitter;

        readonly RoamPlanner _planner = new RoamPlanner();

        UniWindowController _controller;
        Renderer[] _renderers;
        long _self;

        /// <summary>설정에서 켰나.</summary>
        public bool Allowed { get; set; }

        /// <summary>한 자리에 머무는 평균 시간(분).</summary>
        public float MeanDwellMinutes
        {
            set => _planner.MeanDwellSec = Mathf.Max(1f, value * 60f);
        }

        /// <summary>말하는 중처럼 셸 바깥 사정으로 멈춰야 할 때. AvatarShell 이 넣는다.</summary>
        public bool Busy { get; set; }

        /// <summary>지금 이동 중인가. 걷기 모션을 틀지 정할 때 쓴다.</summary>
        public bool Moving => _planner.Moving;

        /// <summary>이동 상태가 바뀌었다. (이동 중, 방향)</summary>
        public event System.Action<bool, int> MovingChanged;

        bool _wasMoving;

        void Awake()
        {
            _controller = UniWindowController.current;
            if (_camera == null) _camera = Camera.main;
            if (_dragger == null) _dragger = FindAnyObjectByType<AvatarDragger>();
            if (_sitter == null) _sitter = FindAnyObjectByType<WindowSitter>();
            _self = System.Diagnostics.Process.GetCurrentProcess().MainWindowHandle.ToInt64();
        }

        /// <summary>모델이 바뀌면 실루엣을 재는 렌더러가 통째로 바뀐다.</summary>
        public void Bind(GameObject model)
        {
            _renderers = model == null ? null : model.GetComponentsInChildren<Renderer>(true);
        }

        /// <summary>
        /// <c>LateUpdate</c> 인 이유는 <see cref="WindowSitter"/> 와 같다 — 본이 최종
        /// 위치를 잡은 뒤라야 실루엣을 제대로 재고, 드래그가 창을 옮긴 뒤여야 한다.
        /// </summary>
        void LateUpdate()
        {
            if (_controller == null) _controller = UniWindowController.current;
            if (_controller == null || _camera == null) return;

            var delta = Time.deltaTime;
            if (delta <= 0f) return;

            var bounds = WalkableBounds();
            var silhouette = SilhouetteX();

            var plan = _planner.Update(delta, new RoamInput
            {
                Enabled = Allowed && bounds.width > 0f,
                Busy = Busy
                       || (_dragger != null && _dragger.IsDragging)
                       || (_sitter != null && _sitter.Sitting),
                AvatarLeft = silhouette.x,
                AvatarRight = silhouette.y,
                Bounds = bounds,
                Cursor = UniWindowController.GetCursorPosition(),
            });

            if (plan.Moving)
            {
                var step = _planner.SpeedPxPerSec * delta * plan.Direction;
                var position = _controller.windowPosition;
                _controller.windowPosition = new Vector2(position.x + step, position.y);
            }

            if (plan.Moving != _wasMoving)
            {
                _wasMoving = plan.Moving;
                MovingChanged?.Invoke(plan.Moving, plan.Direction);
            }
        }

        /// <summary>
        /// 걸어 다닐 수 있는 영역. 작업표시줄을 뺀 작업 영역이다.
        ///
        /// 작업표시줄 위로 걸어가면 시계와 트레이 아이콘을 가린다. 앉는 것은
        /// 사용자가 직접 끌어다 놓은 결과지만, 배회는 아바타가 혼자 정하는 것이라
        /// 남의 자리를 침범하지 않는 편이 낫다.
        /// </summary>
        Rect WalkableBounds()
        {
            if (DesktopWindows.Supported && DesktopWindows.TryGetMonitor(_self, out _, out var work)) return work;

            // Windows 가 아니거나 모니터를 못 읽으면 UniWinC 가 주는 모니터 사각형을 쓴다.
            // 작업표시줄을 빼지 못하므로 그만큼 덜 정확하지만, 기능이 죽지는 않는다.
            var count = UniWindowController.GetMonitorCount();
            for (var i = 0; i < count; i++)
            {
                var rect = UniWindowController.GetMonitorRect(i);
                if (rect.Contains(_controller.windowPosition)) return rect;
            }
            return count > 0 ? UniWindowController.GetMonitorRect(0) : new Rect(0f, 0f, 0f, 0f);
        }

        /// <summary>
        /// 아바타 실루엣의 데스크탑 X 범위.
        ///
        /// 월드 경계 상자를 카메라로 투영해 잰다. 렌더러가 없으면(모델 로드 전)
        /// 창 전체를 실루엣으로 본다 — 그러면 배회가 보수적으로 동작한다.
        /// </summary>
        Vector2 SilhouetteX()
        {
            var origin = _controller.windowPosition;
            var size = _controller.windowSize;

            if (_renderers == null || _renderers.Length == 0) return new Vector2(origin.x, origin.x + size.x);

            var has = false;
            var world = new Bounds();
            foreach (var renderer in _renderers)
            {
                if (renderer == null || !renderer.enabled) continue;
                if (!has)
                {
                    world = renderer.bounds;
                    has = true;
                }
                else
                {
                    world.Encapsulate(renderer.bounds);
                }
            }
            if (!has) return new Vector2(origin.x, origin.x + size.x);

            var min = _camera.WorldToScreenPoint(new Vector3(world.min.x, world.center.y, world.center.z)).x;
            var max = _camera.WorldToScreenPoint(new Vector3(world.max.x, world.center.y, world.center.z)).x;
            if (max < min) (min, max) = (max, min);

            var scale = size.x > 0f ? size.x / Mathf.Max(1, _camera.pixelWidth) : 1f;
            return new Vector2(origin.x + min * scale, origin.x + max * scale);
        }
    }
}
