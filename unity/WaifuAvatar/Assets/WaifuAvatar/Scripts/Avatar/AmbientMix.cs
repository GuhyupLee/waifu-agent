using UnityEngine;

namespace WaifuAvatar.Avatar
{
    /// <summary>화면 네 변에서 뽑은 색. 아바타를 둘러싼 조명 넷에 대응한다.</summary>
    public struct AmbientSample
    {
        public Color Top;
        public Color Bottom;
        public Color Left;
        public Color Right;
    }

    /// <summary>조명 하나에 넣을 값.</summary>
    public struct AmbientLight
    {
        public Color Color;
        public float Intensity;
    }

    /// <summary>
    /// 데스크탑 가장자리 색을 아바타 조명으로 옮기는 계산.
    ///
    /// Mate-Engine X3.3.0 의 <c>DesktopAmbientProbe</c> 에서 색 처리 두 가지를
    /// 가져왔다. 둘 다 없으면 결과가 눈에 띄게 나빠진다:
    ///
    ///  1. **명도를 버리고 채도로 세기를 만든다.** 샘플한 RGB 를 그대로 조명 색으로
    ///     쓰면 어두운 배경에서 조명이 검게 죽어 아바타가 안 보인다. 대신 색상만
    ///     쓰고(명도는 1로 고정), 채도가 낮으면 약한 중립광, 높으면 강한 색광으로
    ///     만든다. 회색 배경 = 은은한 백색광, 붉은 배경 = 또렷한 붉은 조명이 된다.
    ///  2. **색상은 원을 따라 짧은 쪽으로 감쇠한다.** 색상은 0 과 1 이 같은 값이라
    ///     그냥 Lerp 하면 빨강(0.98)에서 주황(0.02)으로 갈 때 색환 전체를 거꾸로
    ///     돌아 초록·파랑을 훑고 온다. 화면 한 번 바뀔 때마다 무지개가 지나간다.
    ///
    /// 캡처는 <see cref="WaifuAvatar.Window.DesktopAmbient"/> 가 한다. 여기는
    /// 색만 다루므로 씬 없이 테스트한다.
    /// </summary>
    public class AmbientMix
    {
        /// <summary>채도 0 일 때의 세기. 어두운 화면에서도 이만큼은 보인다.</summary>
        public float MinIntensity = 0.3f;

        /// <summary>채도 1 일 때의 세기.</summary>
        public float MaxIntensity = 0.8f;

        /// <summary>채도 -> 세기 곡선. 1 보다 크면 어지간히 짙어야 세진다.</summary>
        public float SaturationGamma = 1.3f;

        /// <summary>0..1. 클수록 천천히 따라간다. 화면 전환마다 조명이 번쩍이면 산만하다.</summary>
        public float Smoothing = 0.85f;

        Vector3 _top, _bottom, _left, _right;
        bool _seeded;

        public AmbientLight Top => ToLight(_top);
        public AmbientLight Bottom => ToLight(_bottom);
        public AmbientLight Left => ToLight(_left);
        public AmbientLight Right => ToLight(_right);

        public void Update(AmbientSample sample, float delta)
        {
            var top = ToHsv(sample.Top);
            var bottom = ToHsv(sample.Bottom);
            var left = ToHsv(sample.Left);
            var right = ToHsv(sample.Right);

            // 첫 샘플은 섞을 상대가 없다. 검정에서 출발시키면 켜자마자 한 번 어두워진다.
            if (!_seeded)
            {
                _top = top;
                _bottom = bottom;
                _left = left;
                _right = right;
                _seeded = true;
                return;
            }

            var tau = 0.05f + 1.5f * Mathf.Clamp01(Smoothing);
            var a = 1f - Mathf.Exp(-Mathf.Max(0f, delta) / Mathf.Max(1e-4f, tau));

            _top = Damp(_top, top, a);
            _bottom = Damp(_bottom, bottom, a);
            _left = Damp(_left, left, a);
            _right = Damp(_right, right, a);
        }

        /// <summary>절전 복귀나 기능을 껐다 켤 때. 다음 샘플을 그대로 받는다.</summary>
        public void Reset() => _seeded = false;

        static Vector3 ToHsv(Color color)
        {
            Color.RGBToHSV(color, out var h, out var s, out var v);
            return new Vector3(h, s, v);
        }

        /// <summary>색상은 색환의 짧은 쪽으로, 채도·명도는 선형으로.</summary>
        public static Vector3 Damp(Vector3 current, Vector3 target, float a)
        {
            var dh = Mathf.DeltaAngle(current.x * 360f, target.x * 360f) / 360f;
            return new Vector3(
                Mathf.Repeat(current.x + a * dh, 1f),
                Mathf.Lerp(current.y, target.y, a),
                Mathf.Lerp(current.z, target.z, a));
        }

        AmbientLight ToLight(Vector3 hsv)
        {
            var saturation = Mathf.Clamp01(hsv.y);
            return new AmbientLight
            {
                // 명도는 1 로 고정한다. 세기는 아래에서 따로 만든다.
                Color = Color.HSVToRGB(hsv.x, saturation, 1f),
                Intensity = Mathf.Lerp(MinIntensity, MaxIntensity,
                    Mathf.Pow(saturation, Mathf.Max(0.01f, SaturationGamma)))
            };
        }
    }
}
