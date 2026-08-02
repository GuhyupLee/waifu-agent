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

            PlayerSettings.productName = "WaifuAvatar";
            PlayerSettings.companyName = "waifu-agent";

            Debug.Log("[waifu] PlayerSettings 적용 — 투명 창 요구사항 반영됨");
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
