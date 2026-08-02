using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using UniGLTF;
using UniVRM10;
using UnityEngine;

namespace WaifuAvatar.Avatar
{
    /// <summary>
    /// .vrma 모션 라이브러리.
    ///
    /// 이 프로젝트가 직접 만든 VRMA 를 쓴다 (`resources/motions`). Mate-Engine 의
    /// 애니메이션은 가져오지 않는다 — 자산 조항이 animations 를 명시적으로 저작권
    /// 대상으로 두고 재배포를 금지한다.
    ///
    /// 로드는 비싸다(파일마다 glb 파싱 + 씬 생성). 그래서 한 번 읽고 들고 있는다.
    /// 55개를 전부 미리 읽으면 시작이 눈에 띄게 느려지므로 **요청받은 것만** 읽는다.
    /// </summary>
    public class VrmaLibrary : IDisposable
    {
        readonly Dictionary<string, Vrm10AnimationInstance> _loaded =
            new Dictionary<string, Vrm10AnimationInstance>();
        readonly Dictionary<string, string> _paths = new Dictionary<string, string>();

        /// <summary>불러올 수 있는 모션 이름들. 파일 이름에서 확장자를 뗀 것이다.</summary>
        public IReadOnlyCollection<string> Names => _paths.Keys;

        /// <summary>디렉터리를 훑어 이름만 등록한다. 파일은 아직 읽지 않는다.</summary>
        public void Scan(string directory)
        {
            _paths.Clear();
            if (string.IsNullOrEmpty(directory) || !Directory.Exists(directory))
            {
                Debug.LogWarning($"[waifu] 모션 폴더가 없다: {directory}");
                return;
            }

            foreach (var path in Directory.GetFiles(directory, "*.vrma", SearchOption.TopDirectoryOnly))
            {
                _paths[Path.GetFileNameWithoutExtension(path)] = path;
            }
            Debug.Log($"[waifu] 모션 {_paths.Count}개 발견 — {directory}");
        }

        /// <summary>
        /// 모션 하나를 읽는다. 실패하면 null 을 돌려주고 이름을 목록에서 지운다 —
        /// 깨진 파일을 매번 다시 읽으려 들면 전환할 때마다 끊긴다.
        /// </summary>
        public async Task<Vrm10AnimationInstance> LoadAsync(string name)
        {
            if (_loaded.TryGetValue(name, out var cached)) return cached;
            if (!_paths.TryGetValue(name, out var path)) return null;

            try
            {
                using var data = new GlbFileParser(path).Parse();
                var vrmaData = new VrmAnimationData(data);
                using var loader = new VrmAnimationImporter(vrmaData);
                var gltf = await loader.LoadAsync(new ImmediateCaller());
                var instance = gltf.GetComponent<Vrm10AnimationInstance>();
                if (instance == null)
                {
                    Debug.LogWarning($"[waifu] {name} 에 VRMA 확장이 없다");
                    _paths.Remove(name);
                    return null;
                }

                // 박스맨은 디버그용 대역 메시다. 켜두면 아바타 옆에 상자 인형이 선다.
                instance.ShowBoxMan(false);
                instance.gameObject.SetActive(true);
                _loaded[name] = instance;
                return instance;
            }
            catch (Exception e)
            {
                // 파일은 있는데 재생이 안 되는 .vrma 가 실제로 있다. 목록에서 빼야
                // 에이전트에게 알려주는 이름이 "실제로 되는 것" 만 남는다.
                Debug.LogWarning($"[waifu] 모션 로드 실패 {name}: {e.Message}");
                _paths.Remove(name);
                return null;
            }
        }

        /// <summary>이름이 접두사로 시작하는 것들. idle_* 같은 묶음을 고를 때 쓴다.</summary>
        public string[] WithPrefix(string prefix)
        {
            return _paths.Keys.Where(n => n.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                .OrderBy(n => n, StringComparer.Ordinal)
                .ToArray();
        }

        public void Dispose()
        {
            foreach (var instance in _loaded.Values)
            {
                if (instance != null) UnityEngine.Object.Destroy(instance.gameObject);
            }
            _loaded.Clear();
            _paths.Clear();
        }
    }

    /// <summary>
    /// 두 모션을 섞어 하나처럼 보이게 한다.
    ///
    /// UniVRM 의 `Vrm10Runtime.VrmAnimation` 은 슬롯이 하나뿐이라 그냥 갈아끼우면
    /// **자세가 튄다.** idle 이 8~40초마다 바뀌는데 매번 튀면 그게 제일 먼저 눈에 띈다.
    /// 그래서 우리가 IVrm10Animation 을 하나 더 만들어 두 소스를 slerp 로 섞는다.
    ///
    /// 표정 맵도 같이 섞는다 — 모션에 표정 트랙이 있는 클립에서 몸만 섞이면
    /// 얼굴이 먼저 바뀌어 어긋나 보인다.
    /// </summary>
    public class CrossFadeAnimation : IVrm10Animation
    {
        class BlendProvider : INormalizedPoseProvider
        {
            internal IVrm10Animation From;
            internal IVrm10Animation To;
            internal float Weight;

            public Vector3 GetRawHipsPosition()
            {
                var a = From?.ControlRig.Item1?.GetRawHipsPosition() ?? Vector3.zero;
                if (To?.ControlRig.Item1 == null) return a;
                return Vector3.Lerp(a, To.ControlRig.Item1.GetRawHipsPosition(), Weight);
            }

            public Quaternion GetNormalizedLocalRotation(HumanBodyBones bone, HumanBodyBones parentBone)
            {
                var fromRig = From?.ControlRig.Item1;
                var toRig = To?.ControlRig.Item1;
                if (fromRig == null) return toRig?.GetNormalizedLocalRotation(bone, parentBone) ?? Quaternion.identity;
                if (toRig == null) return fromRig.GetNormalizedLocalRotation(bone, parentBone);

                return Quaternion.Slerp(
                    fromRig.GetNormalizedLocalRotation(bone, parentBone),
                    toRig.GetNormalizedLocalRotation(bone, parentBone),
                    Weight);
            }
        }

        readonly BlendProvider _provider = new BlendProvider();
        readonly Dictionary<ExpressionKey, Func<float>> _expressions =
            new Dictionary<ExpressionKey, Func<float>>();

        public (INormalizedPoseProvider, ITPoseProvider) ControlRig =>
            (_provider, (_provider.To ?? _provider.From)?.ControlRig.Item2);

        public IReadOnlyDictionary<ExpressionKey, Func<float>> ExpressionMap => _expressions;

        /// <summary>시선은 섞지 않는다. 우리 쪽 마우스 추적이 따로 쥐고 있다.</summary>
        public LookAtInput? LookAt => null;

        public void Set(IVrm10Animation from, IVrm10Animation to, float weight)
        {
            _provider.From = from;
            _provider.To = to;
            _provider.Weight = Mathf.Clamp01(weight);
            RebuildExpressions();
        }

        void RebuildExpressions()
        {
            _expressions.Clear();
            var from = _provider.From;
            var to = _provider.To;
            var weight = _provider.Weight;

            var keys = new HashSet<ExpressionKey>();
            if (from != null) foreach (var k in from.ExpressionMap.Keys) keys.Add(k);
            if (to != null) foreach (var k in to.ExpressionMap.Keys) keys.Add(k);

            foreach (var key in keys)
            {
                Func<float> readFrom = null;
                Func<float> readTo = null;
                from?.ExpressionMap.TryGetValue(key, out readFrom);
                to?.ExpressionMap.TryGetValue(key, out readTo);

                // 한쪽에만 있는 표정은 없는 쪽을 0 으로 본다. 그래야 그 표정이
                // 페이드 인/아웃 되고, 갑자기 나타났다 사라지지 않는다.
                var a = readFrom;
                var b = readTo;
                _expressions[key] = () => Mathf.Lerp(a?.Invoke() ?? 0f, b?.Invoke() ?? 0f, weight);
            }
        }

        public void ShowBoxMan(bool enable) { }
        public void SetBoxManMaterial(Material material) { }

        // 소스의 수명은 라이브러리가 쥔다. 여기서 지우면 캐시가 깨진다.
        public void Dispose() { }
    }
}
