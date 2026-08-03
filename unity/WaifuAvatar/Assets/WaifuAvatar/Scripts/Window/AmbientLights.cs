using Kirurobo;
using UnityEngine;
using WaifuAvatar.Avatar;

namespace WaifuAvatar.Window
{
    /// <summary>
    /// 데스크탑 색을 아바타 주변 조명 넷에 옮긴다.
    ///
    /// 규칙은 <see cref="AmbientMix"/>, 캡처는 <see cref="DesktopAmbient"/> 가 한다.
    /// 여기는 주기를 재고 조명 컴포넌트에 값을 넣는 일만 한다.
    ///
    /// 조명이 하나도 배치돼 있지 않으면 캡처 자체를 하지 않는다 — 쓸 곳이 없는데
    /// 화면을 읽는 것은 그 자체로 잘못이다.
    /// </summary>
    public class AmbientLights : MonoBehaviour
    {
        [SerializeField] Light _top;
        [SerializeField] Light _bottom;
        [SerializeField] Light _left;
        [SerializeField] Light _right;

        readonly AmbientMix _mix = new AmbientMix();

        UniWindowController _controller;
        float _timer;
        bool _warned;
        AmbientSample _lastSample;
        bool _hasSample;

        /// <summary>설정에서 켰나. 끄면 조명을 원래 값으로 돌려놓는다.</summary>
        public bool Allowed
        {
            get => _allowed;
            set
            {
                if (_allowed == value) return;
                _allowed = value;
                _mix.Reset();
                _hasSample = false;
                if (!value) Restore();
            }
        }

        bool _allowed;

        /// <summary>초당 몇 번 읽나. 높이면 반응이 빠르지만 CPU 를 계속 쓴다.</summary>
        public float SampleHz { get; set; } = 8f;

        public float Smoothing
        {
            set => _mix.Smoothing = Mathf.Clamp01(value);
        }

        Color _restoreColor;
        float _restoreIntensity;
        bool _saved;

        void Awake()
        {
            _controller = UniWindowController.current;
            Save();
        }

        void Save()
        {
            if (_saved || _top == null) return;
            _restoreColor = _top.color;
            _restoreIntensity = _top.intensity;
            _saved = true;
        }

        void Restore()
        {
            if (!_saved) return;
            foreach (var light in new[] { _top, _bottom, _left, _right })
            {
                if (light == null) continue;
                light.color = _restoreColor;
                light.intensity = _restoreIntensity;
            }
        }

        void Update()
        {
            if (!_allowed) return;

            if (_top == null && _bottom == null && _left == null && _right == null)
            {
                if (!_warned)
                {
                    _warned = true;
                    Debug.LogWarning("[waifu] 주변광 조명이 씬에 없다. 화면을 읽지 않고 건너뛴다.");
                }
                return;
            }

            if (!DesktopAmbient.Supported)
            {
                if (!_warned)
                {
                    _warned = true;
                    Debug.Log("[waifu] 주변광은 Windows 전용이다. 이 플랫폼에서는 꺼진 채로 돈다.");
                }
                return;
            }

            var delta = Time.deltaTime;
            _timer -= delta;
            if (_timer <= 0f)
            {
                _timer = 1f / Mathf.Max(1f, SampleHz);
                // 아바타 자신이 있는 자리는 뺀다. 자기 색으로 자기를 비추면 되먹임이 생긴다.
                var self = _controller != null
                    ? new Rect(_controller.windowPosition, _controller.windowSize)
                    : new Rect(0f, 0f, 0f, 0f);
                if (DesktopAmbient.TrySample(self, out var sample))
                {
                    _lastSample = sample;
                    _hasSample = true;
                }
            }

            // 캡처는 초당 몇 번이지만 감쇠는 **매 프레임** 돌아야 한다. 캡처한
            // 프레임에만 섞으면 조명이 초당 8번 계단식으로 튄다.
            //
            // 샘플이 한 번도 성공하지 않았으면 아무것도 하지 않는다 — 여기서 빈 값을
            // 넣으면 첫 샘플의 기준이 검정이 되어 켜자마자 한 번 어두워진다.
            if (!_hasSample) return;
            _mix.Update(_lastSample, delta);

            Apply(_top, _mix.Top);
            Apply(_bottom, _mix.Bottom);
            Apply(_left, _mix.Left);
            Apply(_right, _mix.Right);
        }

        static void Apply(Light light, AmbientLight value)
        {
            if (light == null) return;
            light.color = value.Color;
            light.intensity = value.Intensity;
        }
    }
}
