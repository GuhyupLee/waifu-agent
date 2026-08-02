using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using UniVRM10;
using UnityEngine;

namespace WaifuAvatar.Avatar
{
    /// <summary>불러온 모델과 에이전트에게 알려줄 능력 정보.</summary>
    public class LoadedModel
    {
        public Vrm10Instance Instance;
        public bool HasExpressions;
        public bool HasLookAt;
        public string[] Presets = Array.Empty<string>();
    }

    /// <summary>
    /// VRM 0.x / 1.0 로더.
    ///
    /// <c>Vrm10.LoadPathAsync(canLoadVrm0X: true)</c> 하나로 두 버전을 다 받는다 —
    /// UniVRM 이 0.x 를 1.0 으로 마이그레이션해 주기 때문이다. 버전별로 importer 를
    /// 갈라 쓰면 이후 모든 코드가 두 타입을 다뤄야 해서 표정·시선 처리가 두 벌이 된다.
    /// </summary>
    public static class VrmModelLoader
    {
        public static async Task<LoadedModel> LoadAsync(string path)
        {
            if (string.IsNullOrWhiteSpace(path))
                throw new ArgumentException("모델 경로가 비어 있다");

            // 없는 파일을 로더에 넘기면 안쪽 깊은 곳에서 알아보기 힘든 예외가 난다.
            // 여기서 걸러야 사용자에게 쓸모 있는 메시지를 준다.
            if (!File.Exists(path))
                throw new FileNotFoundException($"VRM 파일을 찾을 수 없다: {path}", path);

            var instance = await Vrm10.LoadPathAsync(path, canLoadVrm0X: true);
            if (instance == null)
                throw new InvalidOperationException("VRM 을 해석하지 못했다 (형식이 맞는지 확인)");

            var expression = instance.Runtime?.Expression;
            var presets = expression?.ExpressionKeys?
                .Select(key => key.ToString())
                .ToArray() ?? Array.Empty<string>();

            return new LoadedModel
            {
                Instance = instance,
                // 프리셋이 없는 모델에 표정을 넣으면 아무 일도 없이 조용히 무시된다.
                // 표정이 안 먹을 때 제일 먼저 확인해야 할 정보라 에이전트에게 올린다.
                HasExpressions = presets.Length > 0,
                // `Vrm.LookAt` 은 항상 non-null 로 초기화되므로 그걸 검사하면 늘 true 다.
                // 시선이 실제로 도는지는 눈 본이 있는지에 달렸다 — 없는 모델은
                // LookAtType 이 무엇이든 고개만 돌거나 아무 일도 안 일어난다.
                HasLookAt = HasEyeBones(instance),
                Presets = presets
            };
        }

        /// <summary>
        /// 눈 본이 있는가. Animator 의 휴머노이드 매핑으로 본다 — VRM 로더가 채워준다.
        /// </summary>
        static bool HasEyeBones(Vrm10Instance instance)
        {
            var animator = instance.GetComponent<Animator>();
            if (animator == null || animator.avatar == null || !animator.avatar.isHuman) return false;
            return animator.GetBoneTransform(HumanBodyBones.LeftEye) != null
                   || animator.GetBoneTransform(HumanBodyBones.RightEye) != null;
        }

        /// <summary>모델을 화면 안에 세운다. 크기는 셸이 따로 적용한다.</summary>
        public static void Place(Vrm10Instance instance, Transform parent)
        {
            if (instance == null) return;
            var t = instance.transform;
            if (parent != null) t.SetParent(parent, false);
            t.localPosition = Vector3.zero;
            // VRM 은 +Z 를 바라본다. 카메라가 -Z 에서 보므로 돌려세워야 얼굴이 보인다.
            t.localRotation = Quaternion.Euler(0f, 180f, 0f);
        }
    }
}
