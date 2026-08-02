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
        AvatarBridgeClient _bridge;
        Vrm10Instance _model;
        Coroutine _speaking;
        string _speakingId;
        float _scale = 1f;

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

            ConfigureWindow();
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
            if (_dragger != null) _dragger.Clicked += () => _bridge?.SendEvent(new ClickedEvent());

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
            ReportFps();
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

            if (!string.IsNullOrEmpty(command.emotion)) _state.SetEmotion(command.emotion, 1f);
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
