using NUnit.Framework;
using UnityEngine;
using WaifuAvatar.Avatar;

namespace WaifuAvatar.Tests
{
    /// <summary>
    /// 오버레이 누적 방어.
    ///
    /// TypeScript 쪽 실측에서 이 방어가 없을 때 **1분에 척추가 1.96 rad(112°)** 까지
    /// 갔다. 몸이 접힌다. 애니메이션이 트랙을 갖고 있지 않은 본(어깨는 VRMA 에 트랙이
    /// 없는 경우가 흔하다)에서 매 프레임 오프셋이 쌓이기 때문이다.
    /// </summary>
    public class PoseOverlayTests
    {
        static Transform NewBone()
        {
            var go = new GameObject("bone");
            go.transform.localRotation = Quaternion.identity;
            return go.transform;
        }

        static void Destroy(Transform bone)
        {
            if (bone != null) Object.DestroyImmediate(bone.gameObject);
        }

        [Test]
        public void 아무도_안_건드리면_누적되지_않는다()
        {
            var bone = NewBone();
            try
            {
                var overlay = new PoseOverlay();
                var offset = new Vector3(0.1f, 0f, 0f);

                overlay.AddRotation(bone, offset);
                var afterFirst = bone.localRotation;

                // 애니메이션이 이 본을 안 건드리는 상황을 600프레임(10초) 흉내낸다.
                for (var i = 0; i < 600; i++) overlay.AddRotation(bone, offset);

                Assert.IsTrue(PoseOverlay.Approximately(afterFirst, bone.localRotation, 1e-4f),
                    $"오프셋이 누적됐다: {afterFirst.eulerAngles} -> {bone.localRotation.eulerAngles}");
            }
            finally { Destroy(bone); }
        }

        [Test]
        public void 오래_돌려도_각도가_폭주하지_않는다()
        {
            var bone = NewBone();
            try
            {
                var overlay = new PoseOverlay();
                // 60fps 로 1분. 방어가 없으면 여기서 112도까지 간다.
                for (var i = 0; i < 3600; i++) overlay.AddRotation(bone, new Vector3(0.02f, 0f, 0f));

                var angle = Quaternion.Angle(Quaternion.identity, bone.localRotation);
                Assert.Less(angle, 5f, $"1분 뒤 {angle}도 — 누적되고 있다");
            }
            finally { Destroy(bone); }
        }

        [Test]
        public void 애니메이션이_덮어쓰면_그것을_기준으로_삼는다()
        {
            var bone = NewBone();
            try
            {
                var overlay = new PoseOverlay();
                overlay.AddRotation(bone, new Vector3(0.1f, 0f, 0f));

                // 믹서가 이 본에 새 값을 썼다.
                var fromAnimation = Quaternion.Euler(30f, 0f, 0f);
                bone.localRotation = fromAnimation;

                overlay.AddRotation(bone, new Vector3(0.1f, 0f, 0f));

                // 애니메이션 값이 살아 있어야 한다 — 우리 오프셋만큼만 더 돌아간다.
                var angle = Quaternion.Angle(fromAnimation, bone.localRotation);
                Assert.That(angle, Is.EqualTo(0.1f * Mathf.Rad2Deg).Within(0.5f));
            }
            finally { Destroy(bone); }
        }

        [Test]
        public void 오프셋이_0_이면_애니메이션_값이_그대로_남는다()
        {
            var bone = NewBone();
            try
            {
                var overlay = new PoseOverlay();
                var fromAnimation = Quaternion.Euler(0f, 45f, 0f);
                bone.localRotation = fromAnimation;

                overlay.AddRotation(bone, Vector3.zero);

                Assert.IsTrue(PoseOverlay.Approximately(fromAnimation, bone.localRotation, 1e-4f));
            }
            finally { Destroy(bone); }
        }

        [Test]
        public void null_본은_조용히_무시한다()
        {
            // 모델마다 없는 본이 있다. 어깨가 없는 VRM 도 실제로 존재한다.
            var overlay = new PoseOverlay();
            Assert.DoesNotThrow(() => overlay.AddRotation(null, Vector3.one));
        }

        [Test]
        public void Clear_뒤에는_현재_값을_기준으로_다시_시작한다()
        {
            var bone = NewBone();
            try
            {
                var overlay = new PoseOverlay();
                overlay.AddRotation(bone, new Vector3(0.1f, 0f, 0f));
                var afterFirst = bone.localRotation;

                // 모델 교체. 남은 상태로 이전 본을 걷어내려 들면 안 된다.
                overlay.Clear();
                overlay.AddRotation(bone, Vector3.zero);

                Assert.IsTrue(PoseOverlay.Approximately(afterFirst, bone.localRotation, 1e-4f));
            }
            finally { Destroy(bone); }
        }
    }

    public class OverlayMathTests
    {
        [Test]
        public void weight_가_0_이면_전부_0_이다()
        {
            var r = OverlayMath.Compute(new OverlayInput { Elapsed = 3f, Weight = 0f, Yaw = 1f, Pitch = 1f });
            Assert.That(r.Spine.magnitude, Is.EqualTo(0f).Within(1e-6f));
            Assert.That(r.Chest.magnitude, Is.EqualTo(0f).Within(1e-6f));
            Assert.That(r.LeftShoulder.magnitude, Is.EqualTo(0f).Within(1e-6f));
        }

        [Test]
        public void 어깨는_좌우_대칭으로_움직인다()
        {
            // 한쪽만 올라가면 숨이 아니라 어깨를 으쓱하는 것으로 보인다.
            var r = OverlayMath.Compute(new OverlayInput { Elapsed = 1.3f, Weight = 1f });
            Assert.That(r.LeftShoulder.z, Is.EqualTo(-r.RightShoulder.z).Within(1e-6f));
        }

        [Test]
        public void 모션이_없으면_머리_추적을_얹지_않는다()
        {
            // 모션이 없을 때는 기본 자세 쪽이 전량을 넣는다. 여기서 또 넣으면 두 번 들어간다.
            var r = OverlayMath.Compute(new OverlayInput
            {
                Elapsed = 1f, Weight = 1f, Yaw = 1f, Pitch = 1f, MotionPlaying = false
            });
            Assert.That(r.Neck.y, Is.EqualTo(0f).Within(1e-6f));
        }

        [Test]
        public void 모션_중에도_머리를_조금은_돌린다()
        {
            // 0 으로 두면 모션 중에는 커서를 완전히 무시해서 남처럼 보인다.
            var r = OverlayMath.Compute(new OverlayInput
            {
                Elapsed = 1f, Weight = 1f, Yaw = 1f, Pitch = 1f, MotionPlaying = true
            });
            Assert.Greater(Mathf.Abs(r.Neck.y), 0f);
            Assert.Greater(Mathf.Abs(r.Head.y), Mathf.Abs(r.Neck.y));
        }

        [Test]
        public void 호흡이_시간에_따라_실제로_변한다()
        {
            // 값이 고정이면 "숨을 쉬지 않는 캐릭터" 다.
            var a = OverlayMath.Compute(new OverlayInput { Elapsed = 0f, Weight = 1f }).Spine.x;
            var b = OverlayMath.Compute(new OverlayInput { Elapsed = 2.1f, Weight = 1f }).Spine.x;
            Assert.Greater(Mathf.Abs(a - b), 1e-4f);
        }
    }
}
