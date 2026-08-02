using System;
using System.Collections;
using System.Globalization;
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
    public class AvatarShell : MonoBehaviour
    {
        [SerializeField] DesktopWindow _window;
        [SerializeField] AvatarDragger _dragger;
        [SerializeField] Transform _avatarRoot;

        readonly AvatarStateMachine _state = new AvatarStateMachine();
        readonly VrmaLibrary _motions = new VrmaLibrary();
        readonly PoseOverlay _overlay = new PoseOverlay();
        PresenceDirector _presence;

        AvatarBridgeClient _bridge;
        Vrm10Instance _model;
        Coroutine _speaking;
        string _speakingId;
        float _scale = 1f;
        float _elapsed;
        PresenceSettingsDto _settings = new PresenceSettingsDto();

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
            if (_avatarRoot == null) _avatarRoot = transform;

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
                    if (_settings.dragMotion) _presence?.RequestClip("drag", this);
                };
                _dragger.DragEnded += () =>
                {
                    _presence?.Poke();
                    // 놓으면 idle 로 돌아간다. 드래그 자세로 굳으면 매달린 것처럼 보인다.
                    if (_settings.dragMotion) _presence?.Interrupt();
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
            _presence?.Update(delta, CursorDirection(), this, _speaking != null);
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
            if (!_settings.tracking.enabled) return;

            var animator = _model.GetComponent<Animator>();
            if (animator == null || animator.avatar == null || !animator.avatar.isHuman) return;

            var rotations = OverlayMath.Compute(new OverlayInput
            {
                Elapsed = _elapsed,
                // 자는 동안에는 호흡만 남기고 추적을 끈다.
                Weight = 1f,
                Yaw = _presence.HeadYaw,
                Pitch = _presence.HeadPitch,
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
                    break;

                case "set-presence":
                    _presence?.SetAsleep(command.asleep, this);
                    break;

                case "wake":
                    // 절전 복귀. 몇 시간치 delta 를 한 번에 적분하면 스프링이 발산한다.
                    _presence?.Wake();
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
                var message = task.Exception?.GetBaseException().Message ?? "알 수 없는 실패";
                Debug.LogError($"[waifu] 모델 로드 실패: {message}");
                _bridge?.SendEvent(new ModelLoadedEvent { ok = false, error = message });
                yield break;
            }

            // 이전 모델을 지우지 않으면 겹쳐 선다.
            if (_model != null) Destroy(_model.gameObject);

            var loaded = task.Result;
            _model = loaded.Instance;
            VrmModelLoader.Place(_model, _avatarRoot);
            ApplyScale();
            _state.Bind(_model);
            // 모델이 바뀌면 본이 통째로 사라진다. 남은 오버레이 상태로 없는 본을
            // 걷어내려 들면 안 된다.
            _overlay.Clear();
            _presence?.Bind(_model);

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
            Debug.Log($"[waifu] say({command.id}): {command.text}");

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
            _bridge?.SendEvent(new SpeechEndEvent { id = id });
        }

        void StopSpeaking()
        {
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
            if (_model != null) _model.transform.localScale = Vector3.one * _scale;
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
