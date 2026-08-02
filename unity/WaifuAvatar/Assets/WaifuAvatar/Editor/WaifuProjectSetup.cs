using System.IO;
using Kirurobo;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using WaifuAvatar.Window;

namespace WaifuAvatar.Editor
{
    /// <summary>
    /// 투명 데스크탑 창에 필요한 프로젝트 설정과 기본 씬을 코드로 만든다.
    ///
    /// **왜 GUI 로 안 하는가**: 어떤 설정이 왜 필요한지가 저장소에 남지 않는다.
    /// 아래 값들은 UniWindowController 가 직접 검사하는 항목이며(그 에디터 스크립트의
    /// 경고 목록과 같다), 하나라도 틀리면 창이 불투명해지거나 전체화면으로 튄다.
    ///
    /// 배치 모드에서도 부를 수 있다:
    ///   Unity.exe -batchmode -quit -projectPath unity/WaifuAvatar \
    ///     -executeMethod WaifuAvatar.Editor.WaifuProjectSetup.SetUpAll
    /// </summary>
    public static class WaifuProjectSetup
    {
        const string ScenePath = "Assets/WaifuAvatar/Scenes/AvatarShell.unity";

        [MenuItem("Waifu/프로젝트 설정 적용 + 씬 생성")]
        public static void SetUpAll()
        {
            ApplyPlayerSettings();
            CreateScene();
            AssetDatabase.SaveAssets();
            Debug.Log("[waifu] 프로젝트 설정과 씬 준비 완료");
        }

        [MenuItem("Waifu/프로젝트 설정만 적용")]
        public static void ApplyPlayerSettings()
        {
            // 창이 포커스를 잃어도 계속 그려야 한다. 데스크탑 펫이 다른 창을 쓰는 동안
            // 얼어붙으면 존재 이유가 없다.
            PlayerSettings.runInBackground = true;

            // 크기 조절이 막혀 있으면 창 크기를 코드로 바꿀 수 없다.
            PlayerSettings.resizableWindow = true;

            // 전체화면으로 튀면 투명도 클릭 통과도 의미가 없어진다.
            PlayerSettings.fullScreenMode = FullScreenMode.Windowed;
            PlayerSettings.allowFullscreenSwitch = false;

            // **Windows 투명 창의 핵심.** flip model swapchain 을 쓰면 알파가 무시돼
            // 배경이 검게 찬다.
            PlayerSettings.useFlipModelSwapchain = false;

            // D3D12 는 투명 창을 지원하지 않는다. D3D11 로 고정한다.
            PlayerSettings.SetUseDefaultGraphicsAPIs(BuildTarget.StandaloneWindows64, false);
            PlayerSettings.SetGraphicsAPIs(
                BuildTarget.StandaloneWindows64,
                new[] { GraphicsDeviceType.Direct3D11 });

            // 데스크탑 펫 크기. 기본값(전체화면급)으로 두면 투명한 1920x1080 창이
            // 화면을 덮는다. 알파 히트 테스트 덕에 클릭은 통과하지만, 그만큼을
            // 매 프레임 그리고 합성하는 것은 낭비이고 다른 창의 합성에도 영향을 준다.
            PlayerSettings.defaultScreenWidth = 480;
            PlayerSettings.defaultScreenHeight = 800;
            PlayerSettings.defaultIsNativeResolution = false;

            PlayerSettings.productName = "WaifuAvatar";
            PlayerSettings.companyName = "waifu-agent";

            Debug.Log("[waifu] PlayerSettings 적용 — 투명 창 요구사항 반영됨");
        }

        /// <summary>
        /// Windows 플레이어를 빌드한다. 결과는 `unity/WaifuAvatar/Build/WaifuAvatar.exe`.
        ///
        /// 이 경로를 `waifu.config.json` 의 `unity.playerPath` 에 넣으면 Electron 이 띄운다.
        /// 직접 실행하면 브리지 환경변수가 없어 바로 종료한다 — 의도된 동작이다.
        ///
        /// 배치 모드:
        ///   Unity.exe -batchmode -quit -projectPath unity/WaifuAvatar \
        ///     -executeMethod WaifuAvatar.Editor.WaifuProjectSetup.BuildWindows
        /// </summary>
        [MenuItem("Waifu/Windows 플레이어 빌드")]
        public static void BuildWindows()
        {
            ApplyPlayerSettings();
            if (!File.Exists(ScenePath)) CreateScene();

            var output = Path.Combine(Directory.GetCurrentDirectory(), "Build", "WaifuAvatar.exe");
            Directory.CreateDirectory(Path.GetDirectoryName(output) ?? ".");

            var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
            {
                scenes = new[] { ScenePath },
                locationPathName = output,
                target = BuildTarget.StandaloneWindows64,
                options = BuildOptions.None
            });

            var summary = report.summary;
            Debug.Log($"[waifu] 빌드 {summary.result} — {summary.totalSize} bytes, {output}");
            if (summary.result != UnityEditor.Build.Reporting.BuildResult.Succeeded)
            {
                // 배치 모드에서 조용히 0 으로 끝나면 CI 가 성공으로 읽는다.
                throw new System.Exception($"빌드 실패: {summary.result}");
            }

            CopyMotions(Path.GetDirectoryName(output));
        }

        /// <summary>
        /// VRMA 를 빌드 옆으로 복사한다.
        ///
        /// AssetBundle 로 굽지 않는 이유: 55개를 번들로 만들 이유가 없고, 파일로
        /// 두면 사용자가 자기 모션을 넣을 수 있다. 대신 **복사를 잊으면 셸이 모션
        /// 없이 뜨므로** 빌드 단계에 묶어둔다 — 실측에서 실제로 잊었다.
        /// </summary>
        static void CopyMotions(string buildDirectory)
        {
            if (string.IsNullOrEmpty(buildDirectory)) return;

            // unity/WaifuAvatar/Assets -> 저장소 루트 -> resources/motions
            var source = Path.GetFullPath(Path.Combine(
                Application.dataPath, "..", "..", "..", "resources", "motions"));
            if (!Directory.Exists(source))
            {
                Debug.LogWarning($"[waifu] 모션 원본을 찾지 못했다: {source}");
                return;
            }

            var target = Path.Combine(buildDirectory, "motions");
            Directory.CreateDirectory(target);

            var count = 0;
            foreach (var file in Directory.GetFiles(source, "*.vrma"))
            {
                File.Copy(file, Path.Combine(target, Path.GetFileName(file)), true);
                count++;
            }
            Debug.Log($"[waifu] 모션 {count}개 복사 — {target}");
        }

        [MenuItem("Waifu/기본 씬 생성")]
        public static void CreateScene()
        {
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            var camera = new GameObject("Main Camera").AddComponent<Camera>();
            camera.tag = "MainCamera";
            // 배경을 알파 0 으로 지워야 창이 비어 보인다. Skybox 면 하늘이 찍힌다.
            camera.clearFlags = CameraClearFlags.SolidColor;
            camera.backgroundColor = new Color(0f, 0f, 0f, 0f);
            // MSAA 가 켜져 있으면 가장자리 알파가 뭉개져 투명이 깨진다.
            camera.allowMSAA = false;
            camera.orthographic = false;
            camera.transform.position = new Vector3(0f, 1.2f, -2.2f);
            camera.transform.rotation = Quaternion.identity;

            var light = new GameObject("Directional Light").AddComponent<Light>();
            light.type = LightType.Directional;
            light.transform.rotation = Quaternion.Euler(50f, -30f, 0f);

            // UniWindowController 는 자기 자신을 찾아 붙는 싱글턴이라 한 곳에 둔다.
            var shellObject = new GameObject("AvatarShell");
            shellObject.AddComponent<UniWindowController>();
            shellObject.AddComponent<DesktopWindow>();
            shellObject.AddComponent<AvatarDragger>();
            var shell = shellObject.AddComponent<AvatarShell>();

            // 아바타가 설 자리. 셸이 여기에 모델을 붙인다.
            var root = new GameObject("AvatarRoot");
            root.transform.position = Vector3.zero;

            // 직렬화 필드를 코드로 잇는다. 안 이으면 셸이 자기 transform 을 쓰는데,
            // 거기엔 UniWindowController 가 붙어 있어 모델과 창 제어가 한 오브젝트에 섞인다.
            var serialized = new SerializedObject(shell);
            serialized.FindProperty("_avatarRoot").objectReferenceValue = root.transform;
            serialized.ApplyModifiedPropertiesWithoutUndo();

            Directory.CreateDirectory(Path.GetDirectoryName(ScenePath) ?? ".");
            EditorSceneManager.SaveScene(scene, ScenePath);
            AssetDatabase.Refresh();

            EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
            Debug.Log($"[waifu] 씬 생성 — {ScenePath}");
        }
    }
}
