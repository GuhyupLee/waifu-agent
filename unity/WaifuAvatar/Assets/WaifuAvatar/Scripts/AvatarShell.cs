using System;
using System.Collections;
using System.Globalization;
using System.Linq;
using UnityEngine;
using UniVRM10;
using WaifuAvatar.Avatar;
using WaifuAvatar.Bridge;
using WaifuAvatar.Window;

namespace WaifuAvatar
{
    /// <summary>
    /// 셸의 진입점. 브리지에 붙고, 명령을 갈라 보내고, 이벤트를 올린다.
    ///
    /// **이 셸은 판단하지 않는다.** 무엇을 말할지·어떤 표정을 지을지는 전부 Electron 쪽
    /// 에이전트가 정한다. 여기 있는 것은 그리는 일과, 사용자가 아바타를 만졌다는 사실을
    /// 되돌려 보내는 일뿐이다. 모델 제공자 인증 정보도 Discord 토큰도 이쪽에 없다.
    /// </summary>
    [DefaultExecutionOrder(12000)]
    public class AvatarShell : MonoBehaviour
    {
        [SerializeField] DesktopWindow _window;
        [SerializeField] AvatarDragger _dragger;
        [SerializeField] WindowSitter _sitter;
        [SerializeField] Roamer _roamer;
        [SerializeField] AmbientLights _ambient;
        [SerializeField] Transform _avatarRoot;
        [SerializeField] Camera _camera;

        readonly AvatarStateMachine _state = new AvatarStateMachine();
        readonly VrmaLibrary _motions = new VrmaLibrary();
        readonly PoseOverlay _overlay = new PoseOverlay();
        readonly SwayModel _sway = new SwayModel();
        PresenceDirector _presence;

        Vector2 _lastWindowPosition;
        bool _hasWindowPosition;
        float _monitorCheck;
        float _appliedMonitorFactor = 1f;
        long _selfWindow;

        AvatarBridgeClient _bridge;
        Vrm10Instance _model;
        SpeechBubbleView _bubbleView;
        Coroutine _speaking;
        string _speakingId;
        float _scale = 1f;
        float _elapsed;
        PresenceSettingsDto _settings = new PresenceSettingsDto();

        const string DragMotion = "mouse-tether-right";
        const float DragReleaseSeconds = 0.32f;
        Transform _dragGrip;
        bool _dragTetherActive;
        float _dragReleaseRemaining;
        Vector3 _dragReleaseStart;
        Vector3 _avatarRestLocalPosition;

        float _fpsTimer;
        int _fpsFrames;

        /// <summary>
        /// 브리지가 끊겼다는 사실. **백그라운드 스레드가 쓰고 Update 가 읽는다.**
        ///
        /// 수신 루프는 Task 위에서 돌기 때문에 거기서 바로 <c>Application.Quit()</c> 을
        /// 부르면 안 된다 — Unity API 는 메인 스레드 전용이고, 조용히 무시되면
        /// **고아 방지 장치가 통째로 죽는다.** 플래그만 세우고 종료는 Update 가 한다.
        /// </summary>
        volatile bool _closed;
        string _closedReason;

        void Awake()
        {
            // 창이 없으면 아바타를 띄울 자리가 없다. 조용히 반쯤 도는 것보다 낫다.
            if (_window == null) _window = FindAnyObjectByType<DesktopWindow>();
            if (_dragger == null) _dragger = FindAnyObjectByType<AvatarDragger>();
            if (_sitter == null) _sitter = FindAnyObjectByType<WindowSitter>();
            if (_roamer == null) _roamer = FindAnyObjectByType<Roamer>();
            if (_ambient == null) _ambient = FindAnyObjectByType<AmbientLights>();
            if (_camera == null) _camera = Camera.main;
            _selfWindow = System.Diagnostics.Process.GetCurrentProcess().MainWindowHandle.ToInt64();
            if (_avatarRoot == null) _avatarRoot = transform;
            _avatarRestLocalPosition = _avatarRoot.localPosition;
            _bubbleView = GetComponent<SpeechBubbleView>();
            if (_bubbleView == null) _bubbleView = gameObject.AddComponent<SpeechBubbleView>();

            // 모션은 플레이어 옆의 motions 폴더에서 읽는다. 빌드에 굽지 않는 이유는
            // 55개를 전부 AssetBundle 로 만들 이유가 없고, 사용자가 자기 것을 넣을
            // 여지를 남기기 위해서다.
            _motions.Scan(ResolveMotionDirectory());
            _presence = new PresenceDirector(_motions);
            _presence.SleepChanged += asleep =>
            {
                Debug.Log($"[waifu] 수면 상태 {(asleep ? "잠듦" : "깨어남")}");
                _bridge?.SendEvent(new PresenceEvent { asleep = asleep });
            };

            ConfigureWindow();
        }

        /// <summary>
        /// 개발 중에는 에디터의 프로젝트 루트 기준, 빌드에서는 실행 파일 옆을 본다.
        /// 못 찾으면 빈 문자열 — 라이브러리가 경고를 남기고 모션 없이 돈다.
        /// </summary>
        static string ResolveMotionDirectory()
        {
            var beside = System.IO.Path.Combine(Application.dataPath, "..", "motions");
            if (System.IO.Directory.Exists(beside)) return beside;

            // 저장소 안에서 에디터로 돌릴 때: unity/WaifuAvatar/Assets -> 저장소 루트
            var repo = System.IO.Path.Combine(Application.dataPath, "..", "..", "..", "resources", "motions");
            return System.IO.Directory.Exists(repo) ? repo : string.Empty;
        }

        void ConfigureWindow()
        {
            var anchorX = ReadFloat(Protocol.AnchorXEnv, 0.85f);
            var anchorY = ReadFloat(Protocol.AnchorYEnv, 0f);
            var topmost = ReadBool(Protocol.TopmostEnv, true);
            var hitAlpha = (int)ReadFloat(Protocol.HitAlphaEnv, 8f);
            _scale = ReadFloat(Protocol.ScaleEnv, 1f);

            if (_window == null)
            {
                Debug.LogError("[waifu] DesktopWindow 를 찾지 못했다. 투명 창을 세울 수 없다.");
                return;
            }

            _window.Configure(topmost, hitAlpha);
            _window.Place(new Vector2(anchorX, anchorY));
            _window.HoverChanged += over => _bridge?.SendEvent(new HoverEvent { over = over });
        }

        IEnumerator Start()
        {
            if (_dragger != null)
            {
                _dragger.Clicked += () =>
                {
                    // 만지면 깬다. 자는 아바타를 눌렀는데 아무 일도 없으면 고장으로 보인다.
                    _presence?.Poke();
                    _bridge?.SendEvent(new ClickedEvent());
                    if (_settings.touch) ReactToTouch();
                };
                _dragger.DragStarted += () =>
                {
                    _presence?.Poke();
                    if (!_settings.dragMotion) return;

                    _presence?.RequestClip(DragMotion, this);
                    BeginDragTether();
                };
                _dragger.DragEnded += () =>
                {
                    _presence?.Poke();
                    EndDragTether();
                    // 창에 앉은 채로 놓았으면 앉기 자세를 유지해야 한다. 여기서
                    // Interrupt 를 부르면 앉자마자 idle 로 튕겨 서 버린다.
                    if (_sitter != null && _sitter.Sitting) return;
                    // 모션 복귀는 루트 위치가 0.32초 동안 원래 자리로 돌아간 뒤 한다.
                    // 손은 먼저 놓이고 몸은 조금 늦게 내려와야 물체처럼 끌려오지 않는다.
                };
            }

            if (_sitter != null)
            {
                _sitter.SittingChanged += sitting =>
                {
                    _presence?.Poke();
                    if (sitting) _presence?.RequestSit(this);
                    else _presence?.Interrupt();
                };
            }

            if (_roamer != null)
            {
                _roamer.MovingChanged += (moving, _) =>
                {
                    // 걷는 동안 걷기 모션을 튼다. 창만 미끄러지고 다리가 가만히 있으면
                    // 아바타가 얼음판 위를 밀려가는 것처럼 보인다.
                    if (moving) _presence?.RequestClip("walk", this);
                    else _presence?.Interrupt();
                };
            }

            if (!AvatarBridgeClient.TryReadEnvironment(out var url, out var token, out var error))
            {
                Debug.LogError($"[waifu] {error}");
                Quit();
                yield break;
            }

            _bridge = new AvatarBridgeClient();
            _bridge.Closed += OnBridgeClosed;
            Debug.Log($"[waifu] 브리지 연결 시도: {url}");

            var connect = _bridge.ConnectAsync(url, token);
            while (!connect.IsCompleted) yield return null;

            if (connect.IsFaulted || !connect.Result)
            {
                Debug.LogError("[waifu] 브리지 인증 실패. 셸을 종료한다.");
                Quit();
                yield break;
            }

            Debug.Log("[waifu] 브리지 연결됨. 명령 대기.");
            // 에이전트가 waifu_motion을 안전하게 고를 수 있게 실제 셸 옆에서 발견한 이름을
            // 올린다. mouse-tether는 손-커서 제약과 함께만 의미가 있어 일반 명령에서 숨긴다.
            _bridge.SendEvent(new MotionsEvent
            {
                names = _presence.AvailableMotions
                    .Where(name => !name.StartsWith("mouse-tether-", StringComparison.OrdinalIgnoreCase))
                    .OrderBy(name => name, StringComparer.Ordinal)
                    .ToArray()
            });

            // 환경변수로 모델 경로를 받았으면 먼저 띄운다. 명령을 기다리면
            // 붙는 순간까지 빈 창이 떠 있게 된다.
            var initial = Environment.GetEnvironmentVariable(Protocol.ModelPathEnv);
            if (!string.IsNullOrEmpty(initial)) StartCoroutine(LoadModel(initial));
        }

        void Update()
        {
            if (_closed)
            {
                // **고아 방지의 핵심.** Electron 이 크래시하면 저쪽 정리 코드는 돌지 않는다.
                // 연결이 끊긴 셸은 아무도 조종할 수 없는 투명한 창일 뿐이라 살려둘 이유가 없다.
                _closed = false;
                Debug.LogWarning($"[waifu] 브리지 종료 — {_closedReason}. 셸을 끝낸다.");
                Quit();
                return;
            }

            _bridge?.Drain(Dispatch);

            var delta = Time.deltaTime;
            _elapsed += delta;
            // 말하는 중에는 idle 이 끼어들면 안 된다. 발화 모션을 잘라먹는다.
            // 앉아 있는 동안도 마찬가지다 — idle 이 들어오면 앉은 자세가 풀려
            // 창 위에 선 채로 떠 있게 된다.
            var sitting = _sitter != null && _sitter.Sitting;
            var roaming = _roamer != null && _roamer.Moving;
            var dragging = _dragger != null && _dragger.IsDragging;
            if (_presence != null) _presence.Sitting = sitting;
            // 말하는 동안에는 걸어가지 않는다. 자막과 아바타가 따로 놀고, 자는 중에
            // 걸어 다니면 자는 게 아니다.
            if (_roamer != null) _roamer.Busy = _speaking != null || (_presence?.Asleep ?? false);
            // 드래그 중 idle 전환이 끼면 mouse-tether 손 자세가 풀려 커서에 다른 본이
            // 매달린다. 드래그가 끝날 때까지 자동 모션 전환을 멈춘다.
            _presence?.Update(
                delta,
                CursorDirection(),
                this,
                _speaking != null || sitting || roaming || dragging);
            TrackMonitorScale();
            ReportFps();
        }

        /// <summary>
        /// 커서가 아바타 기준 어느 쪽에 있는지(-1..1).
        ///
        /// Unity 입력이 아니라 OS 커서를 쓴다 — **클릭 통과 중에는 Unity 가 마우스
        /// 이벤트를 받지 못하므로**, 그 상태에서 어디를 보고 있는지 알 방법이 그것뿐이다.
        /// </summary>
        Vector2 CursorDirection()
        {
            var controller = Kirurobo.UniWindowController.current;
            if (controller == null) return Vector2.zero;

            var cursor = Kirurobo.UniWindowController.GetCursorPosition();
            var size = controller.windowSize;
            var center = controller.windowPosition + size * 0.5f;
            if (size.x <= 0f || size.y <= 0f) return Vector2.zero;

            // 창 크기의 2배 범위를 ±1 로 본다. 창 안에서만 반응하면 데스크탑을
            // 가로지르는 커서를 따라보지 못해 남처럼 보인다.
            var x = Mathf.Clamp((cursor.x - center.x) / size.x, -1f, 1f);
            // 화면 y 는 아래로 증가한다. 위를 볼 때 +가 되도록 뒤집는다.
            var y = Mathf.Clamp(-(cursor.y - center.y) / size.y, -1f, 1f);
            return new Vector2(x, y);
        }

        /// <summary>
        /// 오버레이는 애니메이션이 본을 쓴 **뒤에** 얹어야 한다.
        /// LateUpdate 여야 그 순서가 보장된다.
        /// </summary>
        void LateUpdate()
        {
            if (_model == null || _presence == null) return;

            var animator = _model.GetComponent<Animator>();
            if (animator == null || animator.avatar == null || !animator.avatar.isHuman) return;

            UpdateSway();

            var rotations = OverlayMath.Compute(new OverlayInput
            {
                Elapsed = _elapsed,
                // 호흡은 추적 설정과 무관하게 항상 얹는다. **여기서 일찍 빠져나가면
                // 안 된다** — AddRotation 을 안 부르면 지난 프레임 오프셋이 걷히지
                // 않아 마지막 자세가 그대로 굳는다. 추적을 끄는 것은 각도를 0 으로
                // 두는 것이지 오버레이를 멈추는 것이 아니다.
                Weight = 1f,
                Yaw = _settings.tracking.enabled ? _presence.HeadYaw : 0f,
                Pitch = _settings.tracking.enabled ? _presence.HeadPitch : 0f,
                BodyYaw = _settings.tracking.enabled ? _presence.BodyYaw : 0f,
                MotionPlaying = true
            });

            // **값이 0 이어도 반드시 매 프레임 전부 부른다.** 지난 프레임에 얹은
            // 오프셋을 걷어내는 것도 AddRotation 의 일이라, 건너뛰면 자세가 굳는다.
            Add(animator, HumanBodyBones.Spine, rotations.Spine);
            Add(animator, HumanBodyBones.Chest, rotations.Chest);
            Add(animator, HumanBodyBones.LeftShoulder, rotations.LeftShoulder);
            Add(animator, HumanBodyBones.RightShoulder, rotations.RightShoulder);
            Add(animator, HumanBodyBones.Neck, rotations.Neck);
            Add(animator, HumanBodyBones.Head, rotations.Head);

            // 스웨이는 몸통 아래로 얹는다. 위 오버레이가 쓰는 본과 겹치지 않는다 —
            // 같은 본에 두 번 AddRotation 하면 뒤엣것이 앞엣것을 지난 프레임 값으로
            // 오인해 걷어낸다.
            Add(animator, HumanBodyBones.Hips, _sway.Hips);
            Add(animator, HumanBodyBones.LeftUpperArm, _sway.Arms);
            Add(animator, HumanBodyBones.RightUpperArm, _sway.Arms);
            Add(animator, HumanBodyBones.LeftUpperLeg, _sway.Legs);
            Add(animator, HumanBodyBones.RightUpperLeg, _sway.Legs);

            UpdateDragTether();
        }

        void BeginDragTether()
        {
            if (_model == null || _avatarRoot == null || _camera == null) return;

            var animator = _model.GetComponent<Animator>();
            if (animator == null || animator.avatar == null || !animator.avatar.isHuman) return;

            _dragGrip = animator.GetBoneTransform(HumanBodyBones.RightMiddleDistal)
                        ?? animator.GetBoneTransform(HumanBodyBones.RightMiddleIntermediate)
                        ?? animator.GetBoneTransform(HumanBodyBones.RightMiddleProximal)
                        ?? animator.GetBoneTransform(HumanBodyBones.RightHand);
            if (_dragGrip == null) return;

            _dragReleaseRemaining = 0f;
            _dragTetherActive = true;
        }

        void EndDragTether()
        {
            _dragTetherActive = false;
            _dragGrip = null;
            if (_avatarRoot == null) return;

            _dragReleaseStart = _avatarRoot.localPosition;
            _dragReleaseRemaining = DragReleaseSeconds;
        }

        /// <summary>
        /// 전용 VRMA가 만든 손 자세 위에서 오른손 끝을 OS 커서에 고정한다.
        /// 창 자체도 커서를 따라 움직이므로 데스크톱 좌표를 현재 창의 좌표로 다시
        /// 환산해야 손과 커서가 DPI/다중 모니터에서도 갈라지지 않는다.
        /// </summary>
        void UpdateDragTether()
        {
            if (_avatarRoot == null) return;

            if (_dragTetherActive && _dragger != null && _dragger.IsDragging && _dragGrip != null)
            {
                var controller = Kirurobo.UniWindowController.current;
                if (controller == null || _camera == null) return;

                if (!DragTetherMath.TryCameraPixel(
                        Kirurobo.UniWindowController.GetCursorPosition(),
                        controller.windowPosition,
                        controller.windowSize,
                        _camera.pixelWidth,
                        _camera.pixelHeight,
                        out var pixel)) return;

                var handScreen = _camera.WorldToScreenPoint(_dragGrip.position);
                if (handScreen.z <= 0f || float.IsNaN(handScreen.z) || float.IsInfinity(handScreen.z)) return;

                var target = _camera.ScreenToWorldPoint(new Vector3(pixel.x, pixel.y, handScreen.z));
                _avatarRoot.position += DragTetherMath.RootOffset(_dragGrip.position, target);
                return;
            }

            if (_dragReleaseRemaining <= 0f) return;

            _dragReleaseRemaining = Mathf.Max(0f, _dragReleaseRemaining - Time.deltaTime);
            var progress = 1f - _dragReleaseRemaining / DragReleaseSeconds;
            _avatarRoot.localPosition = Vector3.Lerp(
                _dragReleaseStart,
                _avatarRestLocalPosition,
                DragTetherMath.SmoothReturn(progress));

            if (_dragReleaseRemaining > 0f) return;
            _avatarRoot.localPosition = _avatarRestLocalPosition;
            if (_sitter == null || !_sitter.Sitting) _presence?.Interrupt();
        }

        /// <summary>
        /// 창이 움직인 속도를 재서 스웨이에 먹인다.
        ///
        /// 마우스가 아니라 **창 위치**의 변화를 쓴다. 클릭 통과 중에는 Unity 가 마우스
        /// 이벤트를 못 받고, 창에 앉아 붙어 있는 동안에는 커서와 아바타가 따로 논다.
        /// 창이 실제로 간 거리가 몸이 받아야 할 관성이다.
        /// </summary>
        void UpdateSway()
        {
            var controller = Kirurobo.UniWindowController.current;
            var delta = Time.deltaTime;
            if (controller == null || delta <= 0f) return;

            var position = controller.windowPosition;
            var velocity = _hasWindowPosition ? (position - _lastWindowPosition) / delta : Vector2.zero;
            _lastWindowPosition = position;
            _hasWindowPosition = true;

            // 앉아 있는 동안은 흔들지 않는다. 창에 걸터앉은 몸이 관성으로 휘청이면
            // 붙어 있는 것처럼 보이지 않는다.
            var dragging = _dragger != null && _dragger.IsDragging;
            var sitting = _sitter != null && _sitter.Sitting;
            _sway.Strength = _settings.dragSway.strength;
            _sway.Update(velocity, _settings.dragSway.enabled && dragging && !sitting, delta);
        }

        void Add(Animator animator, HumanBodyBones bone, Vector3 rotation)
        {
            _overlay.AddRotation(animator.GetBoneTransform(bone), rotation);
        }

        // ───────────────────────── 명령 ─────────────────────────

        void Dispatch(AvatarCommandDto command)
        {
            switch (command.type)
            {
                case "load-model":
                    StartCoroutine(LoadModel(ToLocalPath(command.url)));
                    break;

                case "status":
                    if (AvatarStateMachine.TryParse(command.state, out var state)) _state.SetState(state);
                    else Debug.LogWarning($"[waifu] 알 수 없는 상태: {command.state}");
                    break;

                case "express":
                    _state.SetEmotion(command.emotion, command.intensity);
                    break;

                case "say":
                    Say(command);
                    break;

                case "stop-speaking":
                    StopSpeaking();
                    break;

                case "set-scale":
                    SetScale(command.scale);
                    break;

                case "presence-config":
                    _settings = command.settings ?? new PresenceSettingsDto();
                    _presence?.Apply(_settings);
                    if (!(_settings.bubble?.enabled ?? false)) _bubbleView?.Hide();
                    // 창을 화면 안에 붙잡을지. 예전에는 이 값을 받아만 두고 아무도 읽지
                    // 않아서, 설정 화면의 체크박스가 무엇도 바꾸지 못했다.
                    if (_dragger != null) _dragger.ClampToScreen = _settings.clampToScreen;
                    ApplySitSettings();
                    ApplyRoamSettings();
                    ApplyAmbientSettings();
                    // 자동 배율 설정이 바뀌었을 수 있다.
                    ApplyScale();
                    break;

                /**
                 * 에이전트가 고른 모션. `waifu_motion` 툴과 유휴 행동이 이걸 보낸다.
                 *
                 * 이 case 가 없어서 명령이 default 로 떨어져 "Phase 1 이 다루지 않는
                 * 명령" 으로 로그만 남고 버려졌다. 렌더러 쪽은 처리하고 있었으므로
                 * 같은 에이전트가 렌더러에서는 움직이고 Unity 셸에서는 안 움직였다.
                 */
                case "motion":
                    if (string.IsNullOrEmpty(command.name)) Debug.LogWarning("[waifu] 이름 없는 모션 명령");
                    else _presence?.RequestClip(command.name, this);
                    break;

                case "set-presence":
                    _presence?.SetAsleep(command.asleep, this);
                    break;

                case "wake":
                    // 절전 복귀. 몇 시간치 delta 를 한 번에 적분하면 스프링이 발산한다.
                    _presence?.Wake();
                    _sway.Snap();
                    // 자는 동안 창이 옮겨졌을 수 있다. 그 차이를 속도로 읽으면
                    // 한 프레임에 수천 px/s 가 되어 몸이 접힌다.
                    _hasWindowPosition = false;
                    break;

                default:
                    // 알 수 없는 명령으로 셸이 죽지 않는다. 계약이 늘어날 때
                    // 옛 셸이 새 main 을 만나면 여기로 온다.
                    Debug.Log($"[waifu] Phase 1 이 다루지 않는 명령: {command.type}");
                    break;
            }
        }

        IEnumerator LoadModel(string path)
        {
            Debug.Log($"[waifu] 모델 로드 시작: {path}");
            var task = VrmModelLoader.LoadAsync(path);
            while (!task.IsCompleted) yield return null;

            if (task.IsFaulted || task.Result == null)
            {
                var failure = task.Exception?.GetBaseException();
                var message = failure?.Message ?? "알 수 없는 실패";
                if (failure != null) Debug.LogException(failure);
                Debug.LogError($"[waifu] 모델 로드 실패: {message}");
                _bridge?.SendEvent(new ModelLoadedEvent { ok = false, error = message });
                yield break;
            }

            // 이전 모델을 지우지 않으면 겹쳐 선다.
            if (_model != null) Destroy(_model.gameObject);

            var loaded = task.Result;
            _model = loaded.Instance;
            _dragTetherActive = false;
            _dragReleaseRemaining = 0f;
            _dragGrip = null;
            _avatarRoot.localPosition = _avatarRestLocalPosition;
            VrmModelLoader.Place(_model, _avatarRoot);
            ApplyScale();
            _state.Bind(_model);
            // 모델이 바뀌면 본이 통째로 사라진다. 남은 오버레이 상태로 없는 본을
            // 걷어내려 들면 안 된다.
            _overlay.Clear();
            _presence?.Bind(_model);
            // 좌석 점은 골반·허벅지·발 위치로 잡는다. 모델이 바뀌면 그 본들이
            // 통째로 사라지므로 다시 물려야 한다.
            _sitter?.Bind(_model.GetComponent<Animator>());
            // 배회는 아바타 실루엣의 가로 폭으로 벽을 잰다. 모델이 바뀌면 그 렌더러가
            // 통째로 사라진다.
            _roamer?.Bind(_model.gameObject);

            Debug.Log($"[waifu] 모델 로드 완료 — 표정 {loaded.Presets.Length}종, " +
                      $"시선 {(loaded.HasLookAt ? "있음" : "없음")}");

            _bridge?.SendEvent(new ModelLoadedEvent
            {
                ok = true,
                hasExpressions = loaded.HasExpressions,
                hasLookAt = loaded.HasLookAt,
                presets = loaded.Presets
            });
        }

        void Say(AvatarCommandDto command)
        {
            StopSpeaking();

            // 말을 걸었으면 자고 있을 이유가 없다. 자는 아바타가 말만 하면 이상하다.
            _presence?.Poke();
            // 발화 중 표정은 say 가 실어 보낸 emotion 이 쥔다. 상태 placeholder 로
            // 덮어쓰면 에이전트가 지정한 감정이 사라진다.
            if (!string.IsNullOrEmpty(command.emotion)) _state.SetEmotion(command.emotion, 1f);
            if (!string.IsNullOrEmpty(command.motion)) _presence?.RequestClip(command.motion, this);

            // 말풍선은 별도 채팅창이 아니라 투명 아바타 창 안에 직접 그린다.
            var bubble = _settings.bubble ?? new BubbleDto();
            if (bubble.enabled)
            {
                var line = SpeechBubble.Format(command.text, bubble.maxChars);
                var duration = Mathf.Max(EstimateSeconds(command.text), SpeechBubble.DurationSec(line));
                _bubbleView?.Show(line, duration);
                Debug.Log($"[waifu] say({command.id}) 말풍선({duration:F1}초): {line}");
            }
            else
            {
                Debug.Log($"[waifu] say({command.id}): {command.text}");
            }

            _speakingId = command.id;
            _speaking = StartCoroutine(SpeakFor(EstimateSeconds(command.text)));
        }

        /// <summary>
        /// Phase 1 에는 Unity 쪽 오디오가 없다 — 재생은 Electron 이 한다.
        /// 그래서 발화 길이를 글자 수로 어림한다. **립싱크가 붙으면 이 함수는 사라진다.**
        /// </summary>
        static float EstimateSeconds(string text)
        {
            var length = string.IsNullOrEmpty(text) ? 0 : text.Length;
            return Mathf.Clamp(0.4f + length * 0.09f, 0.6f, 30f);
        }

        IEnumerator SpeakFor(float seconds)
        {
            yield return new WaitForSeconds(seconds);
            var id = _speakingId;
            _speaking = null;
            _speakingId = null;
            _bubbleView?.Hide();
            _bridge?.SendEvent(new SpeechEndEvent { id = id });
        }

        void StopSpeaking()
        {
            _bubbleView?.Hide();
            if (_speaking == null) return;
            StopCoroutine(_speaking);
            _speaking = null;

            // 중단이어도 speech-end 는 보낸다. 안 보내면 저쪽이 이 발화가 끝났는지
            // 모른 채로 다음 말을 못 하고 멈춘다.
            var id = _speakingId;
            _speakingId = null;
            _bridge?.SendEvent(new SpeechEndEvent { id = id });
        }

        /// <summary>
        /// 만진 자리에 따라 표정을 바꾸고 main 에 알린다.
        ///
        /// **여기서 LLM 을 부르지 않는다.** 쓰다듬을 때마다 모델을 태우면 구독 한도가
        /// 순식간에 사라지고, 반응이 1초 뒤에 오면 만진 것과 이어지지 않는다.
        /// </summary>
        void ReactToTouch()
        {
            var region = TouchRegions.Classify(CursorInAvatar());
            if (region == TouchRegion.None) return;

            var emotion = TouchRegions.EmotionFor(region);
            if (emotion != null) _state.SetEmotion(emotion, 1f);

            _bridge?.SendEvent(new TouchedEvent
            {
                bone = TouchRegions.BoneNameFor(region),
                kind = "click"
            });
        }

        /// <summary>커서가 창 안에서 어디인지. x 0..1(좌->우), y 0..1(발->머리).</summary>
        Vector2 CursorInAvatar()
        {
            var controller = Kirurobo.UniWindowController.current;
            if (controller == null) return new Vector2(-1f, -1f);

            var size = controller.windowSize;
            if (size.x <= 0f || size.y <= 0f) return new Vector2(-1f, -1f);

            var cursor = Kirurobo.UniWindowController.GetCursorPosition();
            var offset = cursor - controller.windowPosition;
            // 창 좌표는 위에서 아래로 증가한다. 부위 판정은 발이 0 이라 뒤집는다.
            return new Vector2(offset.x / size.x, 1f - offset.y / size.y);
        }

        void SetScale(float scale)
        {
            if (scale <= 0f)
            {
                Debug.LogWarning($"[waifu] 잘못된 배율 무시: {scale}");
                return;
            }
            _scale = scale;
            ApplyScale();
        }

        void ApplyScale()
        {
            var effective = _scale * MonitorFactor();
            if (_model != null) _model.transform.localScale = Vector3.one * effective;
            // 배율이 바뀌면 판정 반경도, 창 안에서 엉덩이가 있는 자리도 달라진다.
            _sitter?.SetScale(effective);
        }

        /// <summary>
        /// 지금 서 있는 모니터의 해상도 보정.
        ///
        /// 모니터가 바뀌면 값이 달라지므로 <see cref="Update"/> 가 주기적으로 확인한다 —
        /// 한 번만 계산하면 보조 모니터로 옮겼을 때 크기가 그대로 남는다.
        /// </summary>
        float MonitorFactor()
        {
            var auto = _settings.autoScale;
            if (auto == null || !auto.enabled) return 1f;

            var controller = Kirurobo.UniWindowController.current;
            if (controller == null) return 1f;

            var height = 0f;
            if (DesktopWindows.Supported
                && DesktopWindows.TryGetMonitor(_selfWindow, out var monitor, out _)
                && monitor.height > 0f)
            {
                height = monitor.height;
            }
            else
            {
                var count = Kirurobo.UniWindowController.GetMonitorCount();
                for (var i = 0; i < count; i++)
                {
                    var rect = Kirurobo.UniWindowController.GetMonitorRect(i);
                    if (!rect.Contains(controller.windowPosition)) continue;
                    height = rect.height;
                    break;
                }
            }

            return MonitorScale.Factor(height, auto.referenceHeight, auto.min, auto.max);
        }

        /// <summary>
        /// 모니터를 옮겼는지 가끔 확인한다. 매 프레임 Win32 를 두드릴 이유는 없고,
        /// 모니터를 옮기는 것은 사람 손으로 하는 일이라 1초면 충분히 빠르다.
        /// </summary>
        void TrackMonitorScale()
        {
            _monitorCheck -= Time.deltaTime;
            if (_monitorCheck > 0f) return;
            _monitorCheck = 1f;

            var factor = MonitorFactor();
            if (Mathf.Approximately(factor, _appliedMonitorFactor)) return;

            Debug.Log($"[waifu] 모니터 배율 보정 {_appliedMonitorFactor:F2} -> {factor:F2}");
            _appliedMonitorFactor = factor;
            ApplyScale();
        }

        /// <summary>
        /// 창 앉기 설정을 셸에 반영한다.
        ///
        /// Windows 밖에서는 <see cref="WindowSitter"/> 가 스스로 아무것도 하지 않는다.
        /// 여기서 플랫폼을 분기하지 않는 이유다 — 분기가 두 군데 있으면 한쪽만 고친다.
        /// </summary>
        void ApplySitSettings()
        {
            if (_sitter == null) return;

            var sit = _settings.windowSit ?? new WindowSitDto();
            _sitter.AllowTaskbar = sit.taskbar;
            _sitter.Allowed = sit.enabled;
            if (!sit.enabled) _sitter.Release();
        }

        void ApplyRoamSettings()
        {
            if (_roamer == null) return;

            var roam = _settings.roam ?? new RoamDto();
            _roamer.MeanDwellMinutes = roam.meanDwellMin;
            _roamer.Allowed = roam.enabled;
        }

        void ApplyAmbientSettings()
        {
            if (_ambient == null) return;

            var ambient = _settings.ambientLight ?? new AmbientLightDto();
            _ambient.SampleHz = ambient.sampleHz;
            _ambient.Smoothing = ambient.smoothing;
            _ambient.Allowed = ambient.enabled;
        }

        // ───────────────────────── 이벤트 ─────────────────────────

        void ReportFps()
        {
            _fpsFrames++;
            _fpsTimer += Time.unscaledDeltaTime;
            if (_fpsTimer < 1f) return;

            _bridge?.SendEvent(new FpsEvent { value = _fpsFrames / _fpsTimer });
            _fpsFrames = 0;
            _fpsTimer = 0f;
        }

        /// <summary>백그라운드 스레드에서 불릴 수 있다. 여기서 Unity API 를 만지지 마라.</summary>
        void OnBridgeClosed(string reason)
        {
            _closedReason = reason;
            _closed = true;
        }

        void OnDestroy()
        {
            _bridge?.Dispose();
            _bridge = null;
            // 라이브러리는 로드한 VRMA 인스턴스를 GameObject 로 캐시해 둔다. 놓지 않으면
            // 58개 클립이 프로세스가 끝날 때까지 살아 있는다.
            _motions.Dispose();
        }

        // ───────────────────────── 도구 ─────────────────────────

        /// <summary>main 은 경로를 그대로 주기도 하고 file:// URL 로 주기도 한다.</summary>
        static string ToLocalPath(string url)
        {
            if (string.IsNullOrEmpty(url)) return url;
            if (!url.StartsWith("file://", StringComparison.OrdinalIgnoreCase)) return url;
            try
            {
                return new Uri(url).LocalPath;
            }
            catch (UriFormatException)
            {
                return url;
            }
        }

        static float ReadFloat(string name, float fallback)
        {
            var raw = Environment.GetEnvironmentVariable(name);
            return float.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var value)
                ? value
                : fallback;
        }

        static bool ReadBool(string name, bool fallback)
        {
            var raw = Environment.GetEnvironmentVariable(name);
            if (string.IsNullOrEmpty(raw)) return fallback;
            return raw == "1" || raw.Equals("true", StringComparison.OrdinalIgnoreCase);
        }

        static void Quit()
        {
#if UNITY_EDITOR
            UnityEditor.EditorApplication.isPlaying = false;
#else
            Application.Quit();
#endif
        }
    }
}
