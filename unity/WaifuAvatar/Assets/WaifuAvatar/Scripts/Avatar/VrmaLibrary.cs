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
        readonly Dictionary<string, bool> _loops = new Dictionary<string, bool>();
        readonly Dictionary<string, Task<Vrm10AnimationInstance>> _loading =
            new Dictionary<string, Task<Vrm10AnimationInstance>>();
        bool _disposed;

        [Serializable]
        class MotionManifest
        {
            public MotionManifestEntry[] files;
        }

        [Serializable]
        class MotionManifestEntry
        {
            public string name;
            public bool loop;
        }

        /// <summary>불러올 수 있는 모션 이름들. 파일 이름에서 확장자를 뗀 것이다.</summary>
        public IReadOnlyCollection<string> Names => _paths.Keys;

        /// <summary>디렉터리를 훑어 이름만 등록한다. 파일은 아직 읽지 않는다.</summary>
        public void Scan(string directory)
        {
            _paths.Clear();
            _loops.Clear();
            if (string.IsNullOrEmpty(directory) || !Directory.Exists(directory))
            {
                Debug.LogWarning($"[waifu] 모션 폴더가 없다: {directory}");
                return;
            }

            foreach (var path in Directory.GetFiles(directory, "*.vrma", SearchOption.TopDirectoryOnly))
            {
                _paths[Path.GetFileNameWithoutExtension(path)] = path;
            }
            LoadManifest(Path.Combine(directory, "manifest.json"));
            Debug.Log($"[waifu] 모션 {_paths.Count}개 발견 — {directory}");
        }

        void LoadManifest(string path)
        {
            if (!File.Exists(path)) return;
            try
            {
                var manifest = JsonUtility.FromJson<MotionManifest>(File.ReadAllText(path));
                if (manifest?.files == null) return;
                var loaded = 0;
                foreach (var entry in manifest.files)
                {
                    if (entry == null || string.IsNullOrEmpty(entry.name) || !_paths.ContainsKey(entry.name))
                        continue;
                    _loops[entry.name] = entry.loop;
                    loaded++;
                }
                Debug.Log($"[waifu] 모션 반복 메타데이터 {loaded}개 적용");
            }
            catch (Exception e)
            {
                Debug.LogWarning($"[waifu] 모션 manifest를 읽지 못했다: {e.Message}");
            }
        }

        /// <summary>메타데이터가 없는 사용자 모션은 이전 동작과 호환되도록 루프로 본다.</summary>
        public bool IsLooping(string name) =>
            string.IsNullOrEmpty(name) || !_loops.TryGetValue(name, out var loop) || loop;

        /// <summary>
        /// 모션 하나를 읽는다. 실패하면 null 을 돌려주고 이름을 목록에서 지운다 —
        /// 깨진 파일을 매번 다시 읽으려 들면 전환할 때마다 끊긴다.
        /// </summary>
        public Task<Vrm10AnimationInstance> LoadAsync(string name)
        {
            if (_disposed) return Task.FromResult<Vrm10AnimationInstance>(null);
            if (_loaded.TryGetValue(name, out var cached))
                return Task.FromResult(cached);
            if (_loading.TryGetValue(name, out var pending)) return pending;
            if (!_paths.TryGetValue(name, out var path))
                return Task.FromResult<Vrm10AnimationInstance>(null);

            var task = LoadCoreAsync(name, path);
            _loading[name] = task;
            return task;
        }

        async Task<Vrm10AnimationInstance> LoadCoreAsync(string name, string path)
        {
            GameObject importedRoot = null;

            try
            {
                using var data = new GlbFileParser(path).Parse();
                var vrmaData = new VrmAnimationData(data);
                using var loader = new VrmAnimationImporter(vrmaData);
                var gltf = await loader.LoadAsync(new ImmediateCaller());
                importedRoot = gltf.gameObject;
                if (_disposed)
                {
                    UnityEngine.Object.Destroy(gltf.gameObject);
                    return null;
                }
                var instance = gltf.GetComponent<Vrm10AnimationInstance>();
                if (instance == null)
                {
                    Debug.LogWarning($"[waifu] {name} 에 VRMA 확장이 없다");
                    _paths.Remove(name);
                    UnityEngine.Object.Destroy(gltf.gameObject);
                    return null;
                }

                // 박스맨은 디버그용 대역 메시다. 켜두면 아바타 옆에 상자 인형이 선다.
                instance.ShowBoxMan(false);
                instance.gameObject.SetActive(true);
                var animation = instance.GetComponent<Animation>();
                if (animation == null || animation.clip == null)
                    throw new InvalidDataException($"{name} 에 재생할 AnimationClip 이 없다");
                var rig = ((IVrm10Animation)instance).ControlRig;
                if (rig.Item1 == null || rig.Item2 == null)
                    throw new InvalidDataException($"{name} 의 humanoid/T-pose 매핑이 불완전하다");

                // SetTime만 먼저 부르면 UniVRM 내부 m_state가 null이라 NRE가 난다.
                // 한 번 시작해 speed=0으로 만든 뒤 PresenceDirector가 매 프레임 시간을 샘플한다.
                ((UnityEngine.Timeline.ITimeControl)instance).OnControlTimeStart();
                _loaded[name] = instance;
                importedRoot = null;
                return instance;
            }
            catch (Exception e)
            {
                // 파일은 있는데 재생이 안 되는 .vrma 가 실제로 있다. 목록에서 빼야
                // 에이전트에게 알려주는 이름이 "실제로 되는 것" 만 남는다.
                Debug.LogWarning($"[waifu] 모션 로드 실패 {name}: {e.Message}");
                _paths.Remove(name);
                if (importedRoot != null) UnityEngine.Object.Destroy(importedRoot);
                return null;
            }
            finally
            {
                _loading.Remove(name);
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
            _disposed = true;
            foreach (var instance in _loaded.Values)
            {
                if (instance == null) continue;
                try
                {
                    ((UnityEngine.Timeline.ITimeControl)instance).OnControlTimeStop();
                }
                catch (Exception e)
                {
                    Debug.LogWarning($"[waifu] VRMA 종료 실패: {e.Message}");
                }
                UnityEngine.Object.Destroy(instance.gameObject);
            }
            _loaded.Clear();
            _loading.Clear();
            _paths.Clear();
            _loops.Clear();
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
        readonly HashSet<ExpressionKey> _knownExpressionKeys = new HashSet<ExpressionKey>();

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

            if (from != null) foreach (var k in from.ExpressionMap.Keys) _knownExpressionKeys.Add(k);
            if (to != null) foreach (var k in to.ExpressionMap.Keys) _knownExpressionKeys.Add(k);

            foreach (var key in _knownExpressionKeys)
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
