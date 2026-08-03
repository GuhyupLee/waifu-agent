using System;
using System.Collections;
using UniVRM10;
using UnityEngine;
using UnityEngine.Timeline;
using WaifuAvatar.Bridge;

namespace WaifuAvatar.Avatar
{
    /// <summary>
    /// 자동 idle 전환이 지금 재생 중인 동작을 덮어도 되는지 판단한다.
    /// 씬과 클립 타입을 모르도록 값만 받아 EditMode에서 전환 경계를 고정한다.
    /// </summary>
    public static class MotionIdlePolicy
    {
        public static bool BlocksIdle(
            bool busy,
            bool hasCurrentClip,
            bool currentLoops,
            bool oneShotReturnRequested)
        {
            if (busy) return true;
            return hasCurrentClip && !currentLoops && !oneShotReturnRequested;
        }
    }

    /// <summary>
    /// "거기 살고 있다" 를 만드는 층. idle 전환, 마우스 추적, 깜빡임, 호흡, 수면.
    ///
    /// **여기서 LLM 을 부르지 않는다.** 전부 프레임 단위 규칙이다. 모델을 태우면
    /// 구독 한도를 태우고 반응이 눈에 띄게 늦는다.
    ///
    /// 규칙 자체(<see cref="IdleDirector"/>, <see cref="SleepPolicy"/>,
    /// <see cref="Liveliness"/>)는 씬을 모르는 순수 클래스로 따로 빼서 테스트한다.
    /// 이 파일은 그것들을 VRM 에 **붙이는** 일만 한다.
    /// </summary>
    public class PresenceDirector
    {
        readonly VrmaLibrary _library;
        readonly IdleDirector _idle = new IdleDirector();
        readonly SleepPolicy _sleep = new SleepPolicy();
        readonly BlinkModel _blink = new BlinkModel();
        readonly SaccadeModel _saccade = new SaccadeModel();
        readonly CrossFadeAnimation _blend = new CrossFadeAnimation();

        // 머리와 상체는 스프링, 눈은 도약. 같은 곡선으로 움직이면 눈이 머리에 붙어 보인다.
        readonly Spring _headYaw = new Spring(0f, 2.2f, 0.78f);
        readonly Spring _headPitch = new Spring(0f, 2.2f, 0.78f);
        readonly Spring _bodyYaw = new Spring(0f, 1.1f, 0.9f);

        Vrm10Instance _model;
        Vrm10AnimationInstance _currentClip;
        Vrm10AnimationInstance _previousClip;
        string _currentName;
        float _fadeElapsed;
        float _fadeDuration;
        float _currentTime;
        float _previousTime;
        float _currentTimeScale = 1f;
        float _previousTimeScale = 1f;
        bool _currentLoops = true;
        bool _previousLoops = true;
        bool _oneShotReturnRequested;
        /// <summary>가장 최근에 요청한 클립. 늦게 도착한 로드가 순서를 뒤집지 않게 한다.</summary>
        string _wanted;

        PresenceSettingsDto _settings = new PresenceSettingsDto();

        /// <summary>수면 상태가 바뀌었다. main 에 올려야 한다.</summary>
        public event Action<bool> SleepChanged;

        public bool Asleep => _sleep.Asleep;

        /// <summary>모션 이름들. 로드에 실패한 것은 라이브러리가 이미 걸러냈다.</summary>
        public string[] AvailableMotions => _library == null ? Array.Empty<string>() : System.Linq.Enumerable.ToArray(_library.Names);

        public PresenceDirector(VrmaLibrary library)
        {
            _library = library;
        }

        public void Bind(Vrm10Instance model)
        {
            _model = model;
            _currentClip = null;
            _previousClip = null;
            _currentName = null;
            _currentTime = 0f;
            _previousTime = 0f;
            _fadeElapsed = 0f;
            _fadeDuration = 0f;
            _wanted = null;
            _currentLoops = true;
            _previousLoops = true;
            _oneShotReturnRequested = false;
            // 소스가 하나도 없는 CrossFadeAnimation을 Runtime에 먼저 꽂으면
            // UniVRM retarget가 null T-pose provider를 읽고 매 프레임 NRE가 난다.
            if (_model != null) _model.Runtime.VrmAnimation = null;
            ApplyIdleClips();
        }

        public void Apply(PresenceSettingsDto settings)
        {
            _settings = settings ?? new PresenceSettingsDto();

            _idle.MinHoldSec = Mathf.Max(1f, _settings.idle.minHoldSec);
            _idle.MaxHoldSec = Mathf.Max(_idle.MinHoldSec, _settings.idle.maxHoldSec);

            _sleep.Enabled = _settings.sleep.enabled;
            _sleep.AfterIdleMin = Mathf.Max(0.1f, _settings.sleep.afterIdleMin);
            _sleep.ByClock = _settings.sleep.byClock;
            _sleep.FromHour = _settings.sleep.fromHour;
            _sleep.ToHour = _settings.sleep.toHour;

            ApplyIdleClips();
            Debug.Log($"[waifu] 존재감 설정 적용 — idle={_settings.idle.enabled} " +
                      $"추적={_settings.tracking.enabled} 수면={_settings.sleep.enabled}");
        }

        void ApplyIdleClips()
        {
            if (_library == null) return;
            // idle_ 접두사가 붙은 것만 자동 전환 대상이다. 나머지는 에이전트가
            // 명시적으로 부를 때만 쓴다 — 작업 모션이 유휴 중에 튀어나오면 이상하다.
            var clips = _library.WithPrefix("idle");
            if (clips.Length == 0) clips = _library.WithPrefix("Idle");
            _idle.SetClips(clips);
        }

        /// <summary>사용자 활동. 만졌거나 끌었거나 에이전트가 말했다.</summary>
        public void Poke()
        {
            var wasAsleep = _sleep.Asleep;
            _sleep.Poke();
            if (wasAsleep)
            {
                // 깨어나면 자던 자세에 머무르지 않고 바로 다음 idle 로 넘어간다.
                _idle.Interrupt();
                SleepChanged?.Invoke(false);
            }
        }

        /// <summary>main 이 명시적으로 재우거나 깨운다.</summary>
        public void SetAsleep(bool asleep, MonoBehaviour host)
        {
            if (asleep == _sleep.Asleep) return;
            if (asleep)
            {
                // 유휴 시간을 강제로 채워 다음 Update 에서 자게 만든다.
                _sleep.Update(_sleep.AfterIdleMin * 60f + 1f, 12);
                SleepChanged?.Invoke(true);
                RequestClip(PickSleepClip(), host);
            }
            else
            {
                Poke();
            }
        }

        /// <summary>
        /// 지금 창에 걸터앉아 있나 (Phase 4). <see cref="AvatarShell"/> 가 매 프레임 넣는다.
        ///
        /// 자세를 고르는 쪽이 이걸 알아야 한다 — 앉은 채로 잠들면 눕는 모션으로
        /// 갈아타는데, 창 윗변에 걸터앉은 아바타가 갑자기 누우면 허공에 뜬다.
        /// </summary>
        public bool Sitting { get; set; }

        string PickSleepClip()
        {
            if (_library == null) return null;
            // 앉은 채로 자면 자세는 그대로 두고 눈만 감는다. 눈 감기는
            // UpdateFace 가 이미 수면 상태에서 강제한다.
            if (Sitting) return null;
            var sleeping = _library.WithPrefix("sleep");
            return sleeping.Length > 0 ? sleeping[0] : null;
        }

        /// <summary>
        /// 창에 걸터앉는 모션을 하나 고른다 (Phase 4).
        ///
        /// 앉기 클립이 하나도 없으면 <c>relax</c> 로 떨어지되 **그 사실을 로그로
        /// 남긴다.** 조용히 idle 로 떨어지면 "앉기가 동작하는데 모션이 없는 것"과
        /// "앉기 자체가 안 되는 것"을 구분할 수 없다.
        /// </summary>
        public void RequestSit(MonoBehaviour host)
        {
            if (_library == null) return;

            var clips = _library.WithPrefix("sit");
            if (clips.Length == 0)
            {
                Debug.LogWarning("[waifu] 앉기 모션(sit*)이 없다. relax 로 대체한다 — placeholder 다.");
                RequestClip("relax", host);
                return;
            }

            RequestClip(clips[UnityEngine.Random.Range(0, clips.Length)], host);
        }

        /// <param name="gaze">아바타 기준 정규화 커서 방향(-1..1). 추적이 꺼지면 무시된다.</param>
        public void Update(float delta, Vector2 gaze, MonoBehaviour host, bool busy)
        {
            if (_model == null) return;

            UpdateSleep(delta, host);
            UpdateIdle(delta, host, busy);
            UpdatePlayback(delta, host);
            UpdateFade(delta);
            UpdateFace(delta, gaze);
        }

        void UpdateSleep(float delta, MonoBehaviour host)
        {
            if (!_sleep.Update(delta, DateTime.Now.Hour)) return;

            SleepChanged?.Invoke(_sleep.Asleep);
            if (_sleep.Asleep)
            {
                Debug.Log("[waifu] 잠든다");
                RequestClip(PickSleepClip(), host);
            }
            else
            {
                Debug.Log("[waifu] 깨어난다");
                _idle.Interrupt();
            }
        }

        void UpdateIdle(float delta, MonoBehaviour host, bool busy)
        {
            // 자는 중이거나 에이전트가 말하는 중에는 idle 이 끼어들면 안 된다.
            // 원샷 도중에도 타이머가 만료됐다는 이유로 idle 을 넣으면 고개 끄덕임이나
            // 인사가 끝나기 전에 잘린다. 끝까지 샘플한 뒤의 복귀는 UpdatePlayback이 맡는다.
            if (!_settings.idle.enabled
                || _sleep.Asleep
                || MotionIdlePolicy.BlocksIdle(
                    busy,
                    _currentClip != null,
                    _currentLoops,
                    _oneShotReturnRequested)) return;

            var next = _idle.Update(delta);
            if (next != null) RequestClip(next, host);
            else if (_currentClip == null && _idle.Current != null) RequestClip(_idle.Current, host);
        }

        /// <summary>클립을 요청한다. 로드는 비동기라 도착 순서가 뒤집힐 수 있다.</summary>
        public void RequestClip(string name, MonoBehaviour host)
        {
            if (string.IsNullOrEmpty(name) || _library == null || host == null) return;
            _wanted = name;
            host.StartCoroutine(LoadAndSwap(name));
        }

        IEnumerator LoadAndSwap(string name)
        {
            var task = _library.LoadAsync(name);
            while (!task.IsCompleted) yield return null;
            if (task.IsFaulted || task.Result == null) yield break;

            // 로드 도중 다른 클립이 요청됐으면 이건 버린다. 그러지 않으면 늦게 끝난
            // 로드가 최신 클립을 덮어써서 "가끔 엉뚱한 모션이 나온다" 가 된다.
            if (_wanted != name) yield break;

            // A→B가 섞이는 0.35초 안에 C가 와도 현재 A/B 혼합 자세를 버리고 순수 B에서
            // 다시 시작하지 않는다. 최신 요청 하나만 짧게 대기시켜 전환을 직렬화한다.
            while (_fadeDuration > 0f)
            {
                if (_wanted != name) yield break;
                yield return null;
            }

            var nextClip = task.Result;
            var nextLoops = _library.IsLooping(name);

            // 라이브러리는 이름마다 인스턴스를 하나만 캐시한다. 같은 객체를 from/to 양쪽에
            // 넣으면 한 프레임에서 서로 다른 시각으로 두 번 샘플되어 전환 끝에 튄다.
            // 루프는 이미 재생 중이면 유지하고, 원샷 재요청은 0초에서 깨끗하게 재시작한다.
            if (ReferenceEquals(_currentClip, nextClip))
            {
                if (_currentLoops) yield break;
                _previousClip = null;
                _currentName = name;
                _currentLoops = false;
                _currentTime = 0f;
                _currentTimeScale = 1f;
                _oneShotReturnRequested = false;
                _fadeDuration = 0f;
                ((ITimeControl)_currentClip).SetTime(0f);
                _blend.Set(null, _currentClip, 1f);
                if (_model != null) _model.Runtime.VrmAnimation = _blend;
                yield break;
            }

            _previousClip = _currentClip;
            _previousTime = _currentTime;
            _previousTimeScale = _currentTimeScale;
            _previousLoops = _currentLoops;
            _currentClip = nextClip;
            _currentName = name;
            _currentLoops = nextLoops;
            _oneShotReturnRequested = false;

            // 같은 클립을 늘 같은 위상에서 틀면 몇 번만 봐도 루프가 보인다.
            // SetTime 은 ITimeControl 의 명시적 구현이라 캐스팅해야 닿는다.
            var (timeScale, phase) = Liveliness.LoopVariation(UnityEngine.Random.value);
            _currentTimeScale = nextLoops ? timeScale : 1f;
            _currentTime = nextLoops ? phase * ClipDuration(_currentClip) : 0f;
            ((ITimeControl)_currentClip).SetTime(_currentTime);
            _fadeElapsed = 0f;
            // 첫 클립은 섞을 상대가 없다. 즉시 붙인다.
            _fadeDuration = _previousClip == null ? 0f : 0.35f / Mathf.Max(0.1f, timeScale);
            _blend.Set(_previousClip, _currentClip, _previousClip == null ? 1f : 0f);
            if (_model != null) _model.Runtime.VrmAnimation = _blend;
        }

        void UpdatePlayback(float delta, MonoBehaviour host)
        {
            if (_currentClip != null)
            {
                var duration = ClipDuration(_currentClip);
                if (_currentLoops)
                {
                    _currentTime = Liveliness.LoopTime(
                        _currentTime, delta, _currentTimeScale, duration);
                }
                else
                {
                    _currentTime = Liveliness.OneShotTime(
                        _currentTime, delta, _currentTimeScale, duration, out var finished);
                    if (finished && !_oneShotReturnRequested)
                    {
                        _oneShotReturnRequested = true;
                        var fallback = PickIdleFallback();
                        Debug.Log($"[waifu] 원샷 모션 종료 {_currentName} -> {fallback ?? "정지"}");
                        if (!string.IsNullOrEmpty(fallback)) RequestClip(fallback, host);
                    }
                }
                ((ITimeControl)_currentClip).SetTime(_currentTime);
            }

            if (_previousClip != null && _fadeDuration > 0f)
            {
                var duration = ClipDuration(_previousClip);
                if (_previousLoops)
                    _previousTime = Liveliness.LoopTime(
                        _previousTime, delta, _previousTimeScale, duration);
                else
                    _previousTime = Liveliness.OneShotTime(
                        _previousTime, delta, _previousTimeScale, duration, out _);
                ((ITimeControl)_previousClip).SetTime(_previousTime);
            }
        }

        string PickIdleFallback()
        {
            if (_library == null) return null;
            var preferred = _idle.Current;
            if (!string.IsNullOrEmpty(preferred) && preferred != _currentName) return preferred;

            var clips = _library.WithPrefix("idle");
            foreach (var clip in clips)
                if (clip != _currentName) return clip;

            return System.Linq.Enumerable.Contains(_library.Names, "relax") && _currentName != "relax"
                ? "relax"
                : null;
        }

        static float ClipDuration(Vrm10AnimationInstance instance)
        {
            var clip = instance == null ? null : instance.GetComponent<Animation>()?.clip;
            return clip == null ? 0f : clip.length;
        }

        void UpdateFade(float delta)
        {
            if (_currentClip == null) return;

            var weight = 1f;
            if (_fadeDuration > 0f)
            {
                _fadeElapsed += delta;
                var p = Mathf.Clamp01(_fadeElapsed / _fadeDuration);
                // 양 끝을 둥글려야 이음새가 보이지 않는다.
                weight = p * p * (3f - 2f * p);
                if (p >= 1f)
                {
                    _fadeDuration = 0f;
                    _previousClip = null;
                }
            }
            _blend.Set(_previousClip, _currentClip, weight);
        }

        /// <summary>
        /// 얼굴과 상체. 클립이 무엇이든 그 위에 얹는다 —
        /// 사람은 걸으면서도 숨을 쉬고 눈을 깜빡인다.
        /// </summary>
        void UpdateFace(float delta, Vector2 gaze)
        {
            var expression = _model.Runtime?.Expression;
            if (expression == null) return;

            // 잘 때는 눈을 감고 있는다. 깜빡임 모델을 그대로 돌리면 자면서 눈을 뜬다.
            if (_sleep.Asleep)
            {
                expression.SetWeight(ExpressionKey.Blink, 1f);
                return;
            }

            var blink = _blink.Update(delta);
            expression.SetWeight(ExpressionKey.Blink, blink);

            if (!_settings.tracking.enabled) return;

            var saccade = _saccade.Update(delta, gaze);
            if (saccade.Jumped) _blink.OnGazeShift();

            var lookAt = _model.Runtime?.LookAt;
            if (lookAt != null)
            {
                // 시선은 도약한 값을 그대로 쓴다. 스프링을 태우면 다시 미끄러진다.
                // 좌우가 상하보다 넓은 것은 눈의 실제 가동 범위가 그렇기 때문이다.
                var eye = _settings.tracking.eye;
                lookAt.SetYawPitchManually(saccade.Gaze.x * 30f * eye, saccade.Gaze.y * 20f * eye);
            }

            // 머리와 상체는 스프링으로 끌려온다. 목표는 눈보다 작은 각도다 —
            // 사람은 눈으로 먼저 보고 머리는 덜 돌린다.
            _headYaw.Update(gaze.x * _settings.tracking.head, delta);
            _headPitch.Update(gaze.y * _settings.tracking.head, delta);
            _bodyYaw.Update(gaze.x * _settings.tracking.body, delta);

            HeadYaw = _headYaw.Value;
            HeadPitch = _headPitch.Value;
            BodyYaw = _bodyYaw.Value;
        }

        /// <summary>
        /// 이번 프레임의 오버레이 값들. <see cref="PoseOverlay"/> 가 읽는다.
        ///
        /// 호흡은 여기 없다. <see cref="OverlayMath"/> 가 경과 시간에서 직접 만든다 —
        /// 예전에는 이쪽에도 <c>Breath</c> 가 있었지만 아무도 읽지 않아, 위상만
        /// 쌓아 올리고 버리는 값이었다.
        /// </summary>
        public float HeadYaw { get; private set; }
        public float HeadPitch { get; private set; }
        public float BodyYaw { get; private set; }

        /// <summary>지금 클립을 즉시 끝내고 다음 idle 로 넘긴다. 드래그를 놓을 때 쓴다.</summary>
        public void Interrupt() => _idle.Interrupt();

        /// <summary>절전 복귀. 몇 시간치 delta 를 한 번에 적분하면 머리카락이 날아간다.</summary>
        public void Wake()
        {
            _headYaw.Snap(0f);
            _headPitch.Snap(0f);
            _bodyYaw.Snap(0f);
            _saccade.Snap(Vector2.zero);
        }
    }
}
