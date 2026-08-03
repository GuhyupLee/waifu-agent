using System;
using System.Linq;
using UnityEngine;

namespace WaifuAvatar.Avatar
{
    /// <summary>
    /// 아바타 창 안에 직접 그리는 말풍선. 별도 채팅 창이 아니라 캐릭터가 말하는 곳에
    /// 답이 떠야 데스크톱 동반자처럼 느껴진다.
    ///
    /// IMGUI를 쓰는 이유는 런타임 생성 UI를 위해 씬/프리팹 계약을 하나 더 만들지 않고,
    /// 투명 Unity 창의 픽셀 안에서만 그리기 위해서다.
    /// </summary>
    public sealed class SpeechBubbleView : MonoBehaviour
    {
        const float FadeInPerSecond = 8f;
        const float FadeOutPerSecond = 4f;

        string _text = string.Empty;
        float _hideAt;
        float _alpha;
        GUIStyle _background;
        GUIStyle _label;
        Texture2D _bubbleTexture;
        Font _font;

        public bool Visible => _alpha > 0.001f || !string.IsNullOrEmpty(_text);

        public void Show(string text, float seconds)
        {
            _text = text ?? string.Empty;
            if (_text.Length == 0)
            {
                Hide();
                return;
            }

            _hideAt = Time.unscaledTime + Mathf.Max(0.1f, seconds);
            enabled = true;
        }

        public void Hide()
        {
            _hideAt = 0f;
        }

        void Update()
        {
            var showing = !string.IsNullOrEmpty(_text) && Time.unscaledTime < _hideAt;
            _alpha = Mathf.MoveTowards(
                _alpha,
                showing ? 1f : 0f,
                (showing ? FadeInPerSecond : FadeOutPerSecond) * Time.unscaledDeltaTime);
            if (_alpha <= 0f && !showing)
            {
                _text = string.Empty;
                enabled = false;
            }
        }

        void OnGUI()
        {
            if (_alpha <= 0f || string.IsNullOrEmpty(_text)) return;
            EnsureStyles();

            var width = Mathf.Min(420f, Mathf.Max(220f, Screen.width - 32f));
            var contentWidth = width - 48f;
            var contentHeight = Mathf.Clamp(
                _label.CalcHeight(new GUIContent(_text), contentWidth),
                34f,
                132f);
            var height = contentHeight + 34f;
            var rect = new Rect((Screen.width - width) * 0.5f, 18f, width, height);

            var oldColor = GUI.color;
            GUI.color = new Color(1f, 1f, 1f, _alpha);
            GUI.Box(rect, GUIContent.none, _background);
            GUI.Label(
                new Rect(rect.x + 24f, rect.y + 15f, contentWidth, contentHeight),
                _text,
                _label);

            // 말풍선 꼬리. 작은 마름모를 겹치면 배경과 이어져 캐릭터 쪽을 가리킨다.
            var pivot = new Vector2(rect.center.x, rect.yMax + 3f);
            var oldMatrix = GUI.matrix;
            GUIUtility.RotateAroundPivot(45f, pivot);
            GUI.DrawTexture(new Rect(pivot.x - 8f, pivot.y - 8f, 16f, 16f), _bubbleTexture);
            GUI.matrix = oldMatrix;
            GUI.color = oldColor;
        }

        void EnsureStyles()
        {
            if (_background != null) return;

            _bubbleTexture = RoundedTexture(64, 14, new Color32(24, 18, 42, 242));
            _background = new GUIStyle(GUI.skin.box)
            {
                normal = { background = _bubbleTexture },
                border = new RectOffset(18, 18, 18, 18)
            };

            _font = KoreanFont(22);
            _label = new GUIStyle(GUI.skin.label)
            {
                font = _font,
                fontSize = 22,
                fontStyle = FontStyle.Normal,
                alignment = TextAnchor.MiddleCenter,
                wordWrap = true,
                clipping = TextClipping.Clip,
                normal = { textColor = new Color(1f, 0.93f, 0.98f, 1f) }
            };
        }

        static Font KoreanFont(int size)
        {
            var installed = Font.GetOSInstalledFontNames();
            foreach (var candidate in new[] { "Malgun Gothic", "맑은 고딕", "Noto Sans CJK KR", "Arial" })
            {
                var match = installed.FirstOrDefault(name =>
                    name.Equals(candidate, StringComparison.OrdinalIgnoreCase));
                if (!string.IsNullOrEmpty(match)) return Font.CreateDynamicFontFromOSFont(match, size);
            }
            return Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
        }

        static Texture2D RoundedTexture(int size, int radius, Color32 color)
        {
            var texture = new Texture2D(size, size, TextureFormat.RGBA32, false)
            {
                name = "Waifu Speech Bubble",
                wrapMode = TextureWrapMode.Clamp,
                filterMode = FilterMode.Bilinear,
                hideFlags = HideFlags.HideAndDontSave
            };
            var pixels = new Color32[size * size];
            var r = radius - 0.5f;
            for (var y = 0; y < size; y++)
            for (var x = 0; x < size; x++)
            {
                var dx = Mathf.Max(radius - x, 0f, x - (size - radius - 1));
                var dy = Mathf.Max(radius - y, 0f, y - (size - radius - 1));
                var distance = Mathf.Sqrt(dx * dx + dy * dy);
                var alpha = Mathf.Clamp01(r + 1f - distance);
                pixels[y * size + x] = new Color32(color.r, color.g, color.b, (byte)(color.a * alpha));
            }
            texture.SetPixels32(pixels);
            texture.Apply(false, true);
            return texture;
        }

        void OnDestroy()
        {
            if (_bubbleTexture != null) Destroy(_bubbleTexture);
        }
    }
}
