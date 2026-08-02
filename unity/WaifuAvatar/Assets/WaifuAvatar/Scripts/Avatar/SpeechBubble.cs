using UnityEngine;

namespace WaifuAvatar.Avatar
{
    /// <summary>
    /// 말풍선에 넣을 문구를 정하는 규칙. UI 를 모른다.
    ///
    /// 자르는 규칙을 UI 에서 떼어낸 이유: "긴 답변이 화면을 덮지 않는가" 는 눈으로
    /// 보기 전에 잠글 수 있는 성질이고, 여기가 틀리면 아바타가 화면을 가린다.
    /// </summary>
    public static class SpeechBubble
    {
        /// <summary>
        /// 표시할 문구. 너무 길면 자른다.
        ///
        /// 단어 중간에서 자르지 않는다 — 한국어는 띄어쓰기 단위가 의미 단위라
        /// 중간에서 끊으면 읽는 사람이 한 번 더 생각해야 한다.
        /// </summary>
        public static string Format(string text, int maxChars)
        {
            if (string.IsNullOrEmpty(text)) return string.Empty;

            // 줄바꿈은 말풍선을 세로로 늘린다. 한 줄로 눕힌다.
            var flat = text.Replace("\r", " ").Replace("\n", " ").Trim();
            while (flat.Contains("  ")) flat = flat.Replace("  ", " ");

            if (maxChars <= 0) return string.Empty;
            if (flat.Length <= maxChars) return flat;

            // 말줄임표 자리를 남긴다. 자르고 나서 덧붙이면 상한을 넘는다.
            var budget = Mathf.Max(1, maxChars - 1);
            var cut = flat.Substring(0, budget);

            var lastSpace = cut.LastIndexOf(' ');
            // 공백이 너무 앞이면(한 단어가 통째로 긴 경우) 그냥 글자수로 자른다.
            if (lastSpace > budget / 2) cut = cut.Substring(0, lastSpace);

            return cut.TrimEnd() + "…";
        }

        /// <summary>
        /// 말풍선이 떠 있을 시간(초).
        ///
        /// 글자 수에 비례하되 하한을 둔다. 짧은 대답이 눈에 들어오기 전에 사라지면
        /// 읽을 수가 없다.
        /// </summary>
        public static float DurationSec(string text, float minSec = 2.5f)
        {
            var length = string.IsNullOrEmpty(text) ? 0 : text.Length;
            // 한국어 읽기 속도 대략 초당 8~10자. 여유를 둬 7자로 잡는다.
            return Mathf.Clamp(minSec + length / 7f, minSec, 20f);
        }
    }
}
