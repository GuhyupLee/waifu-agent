using UnityEngine;

namespace WaifuAvatar.Avatar
{
    /// <summary>어디를 만졌는가. 반응을 고르는 근거다.</summary>
    public enum TouchRegion
    {
        None,
        Head,
        Face,
        Body,
        Hand
    }

    /// <summary>
    /// 만진 자리 -> 부위.
    ///
    /// 콜라이더를 본마다 붙이지 않는다. VRM 은 모델마다 본 구성이 달라서 콜라이더를
    /// 자동 배치하면 어떤 모델에서는 판정이 통째로 어긋난다. 대신 **아바타 화면
    /// 바운딩 박스 안의 상대 높이**로 나눈다 — 모델 비율이 달라도 머리는 위, 손은
    /// 옆이라는 사실은 변하지 않는다.
    ///
    /// 씬을 모르는 순수 함수라 EditMode 에서 테스트한다.
    /// </summary>
    public static class TouchRegions
    {
        /// <param name="local">
        /// 아바타 바운딩 박스 기준 정규화 좌표. x 는 0(왼쪽)..1(오른쪽),
        /// y 는 0(발)..1(정수리).
        /// </param>
        public static TouchRegion Classify(Vector2 local)
        {
            if (local.x < 0f || local.x > 1f || local.y < 0f || local.y > 1f) return TouchRegion.None;

            // 사람 비율에서 머리는 전신의 위 약 12%, 얼굴은 그 아래 6% 쯤이다.
            if (local.y >= 0.88f) return TouchRegion.Head;
            if (local.y >= 0.82f) return TouchRegion.Face;

            // 손은 몸통 옆으로 내려온 자리다. 가운데는 몸통으로 본다 —
            // 팔이 몸에 붙은 자세에서 옆쪽을 전부 손으로 치면 배를 못 만진다.
            if (local.y >= 0.35f && local.y <= 0.62f && (local.x < 0.28f || local.x > 0.72f))
            {
                return TouchRegion.Hand;
            }

            return TouchRegion.Body;
        }

        /// <summary>부위별 반응. protocol.ts 의 Emotion 이름과 맞춰야 한다.</summary>
        public static string EmotionFor(TouchRegion region)
        {
            switch (region)
            {
                case TouchRegion.Head: return "happy";
                case TouchRegion.Face: return "surprised";
                case TouchRegion.Hand: return "relaxed";
                case TouchRegion.Body: return "surprised";
                default: return null;
            }
        }

        /// <summary>main 으로 올릴 때 쓰는 이름. AvatarEvent.touched.bone 에 실린다.</summary>
        public static string BoneNameFor(TouchRegion region)
        {
            switch (region)
            {
                case TouchRegion.Head: return "head";
                case TouchRegion.Face: return "face";
                case TouchRegion.Hand: return "hand";
                case TouchRegion.Body: return "body";
                default: return "none";
            }
        }
    }
}
