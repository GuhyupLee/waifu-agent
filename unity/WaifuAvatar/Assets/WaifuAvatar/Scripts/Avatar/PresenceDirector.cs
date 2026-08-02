using System;
using System.Collections;
using UniVRM10;
using UnityEngine;
using UnityEngine.Timeline;
using WaifuAvatar.Bridge;

namespace WaifuAvatar.Avatar
{
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
        float _fadeElapsed;
        float _fadeDuration;
        float _breathPhase;
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
            if (_model != null) _model.Runtime.VrmAnimation = _blend;
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

        string PickSleepClip()
        {
            if (_library == null) return null;
            var sleeping = _library.WithPrefix("sleep");
            return sleeping.Length > 0 ? sleeping[0] : null;
        }

        /// <param name="gaze">아바타 기준 정규화 커서 방향(-1..1). 추적이 꺼지면 무시된다.</param>
        public void Update(float delta, Vector2 gaze, MonoBehaviour host, bool busy)
        {
            if (_model == null) return;

            UpdateSleep(delta, host);
            UpdateIdle(delta, host, busy);
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
            if (!_settings.idle.enabled || _sleep.Asleep || busy) return;

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

            _previousClip = _currentClip;
            _currentClip = task.Result;

            // 같은 클립을 늘 같은 위상에서 틀면 몇 번만 봐도 루프가 보인다.
            // SetTime 은 ITimeControl 의 명시적 구현이라 캐스팅해야 닿는다.
            var (timeScale, phase) = Liveliness.LoopVariation(UnityEngine.Random.value);
            ((ITimeControl)_currentClip).SetTime(phase);
            _fadeElapsed = 0f;
            // 첫 클립은 섞을 상대가 없다. 즉시 붙인다.
            _fadeDuration = _previousClip == null ? 0f : 0.35f / Mathf.Max(0.1f, timeScale);
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
                lookAt.SetLookAtYawPitch(saccade.Gaze.x * 30f * eye, saccade.Gaze.y * 20f * eye);
            }

            // 머리와 상체는 스프링으로 끌려온다. 목표는 눈보다 작은 각도다 —
            // 사람은 눈으로 먼저 보고 머리는 덜 돌린다.
            _headYaw.Update(gaze.x * _settings.tracking.head, delta);
            _headPitch.Update(gaze.y * _settings.tracking.head, delta);
            _bodyYaw.Update(gaze.x * _settings.tracking.body, delta);

            _breathPhase += delta / 3.6f;
            // 호흡은 여기서 값만 만들어 둔다. 실제 본 회전은 PoseOverlay 가 얹는다 —
            // rotation.set 으로 넣으면 믹서 결과를 통째로 덮어쓴다.
            Breath = Liveliness.BreathCurve(_breathPhase);
            HeadYaw = _headYaw.Value;
            HeadPitch = _headPitch.Value;
            BodyYaw = _bodyYaw.Value;
        }

        /// <summary>이번 프레임의 오버레이 값들. <see cref="PoseOverlay"/> 가 읽는다.</summary>
        public float Breath { get; private set; }
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
