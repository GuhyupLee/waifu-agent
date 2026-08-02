# Unity Avatar Shell

데스크탑에 뜨는 투명 아바타 창. **셸이지 두뇌가 아니다** — 그리는 일만 하고,
무엇을 말할지·어떤 표정을 지을지는 전부 Electron 쪽 에이전트가 정한다.

Unity 에는 모델 제공자 인증 정보도, Discord 토큰도, 에이전트 권한도 없다.
Electron 이 넘기는 것은 브리지 포트·토큰과 창 배치값뿐이다.

## 준비물

- **Unity 6000.3.x** (`ProjectSettings/ProjectVersion.txt` 가 `6000.3.11f1`)
- **활성화된 Unity 라이선스.** Unity Hub 에 로그인해 Personal 라이선스를 받아두지
  않으면 에디터가 배치 모드에서 `No valid Unity Editor license found` 로 멈춘다.

## 의존성 — 전부 MIT, 상류 릴리스에서 받았다

Mate-Engine 사본에서 복사하지 않았다. 같은 코드지만 상류가 출처가 깨끗하고,
로컬 개조가 섞였는지 확인할 필요가 없다.

| 위치 | 패키지 | 버전 | 라이선스 |
|---|---|---|---|
| `Packages/com.vrmc.gltf` | UniGLTF | 0.131.2 | MIT © ousttrue |
| `Packages/com.vrmc.univrm` | VRM **0.x** | 0.131.2 | MIT © VRM Consortium |
| `Packages/com.vrmc.vrm` | VRM **1.0** | 0.131.2 | MIT © VRM Consortium |
| `Assets/Kirurobo/UniWindowController` | UniWindowController | 0.9.8 | MIT © Kirurobo |

각 패키지의 `LICENSE.md` 는 그대로 두었다. 지우지 마라 — MIT 는 저작권 표시 유지가
유일한 조건이다.

**릴리스 파일 이름이 직관과 반대다.** vrm-c/UniVRM 릴리스에서
`UniVRM-<ver>.unitypackage` 가 VRM **0.x**, `VRM-<ver>.unitypackage` 가 VRM **1.0** 이다.
이름만 보고 하나만 받으면 한쪽 지원이 조용히 빠진다.

다시 받아 넣으려면:

```bash
node scripts/import-unitypackage.mjs <패키지.unitypackage> unity/WaifuAvatar
```

## 첫 설정

프로젝트를 열고 메뉴에서 **Waifu → 프로젝트 설정 적용 + 씬 생성** 을 누른다.
배치 모드로도 같은 일을 할 수 있다:

```bash
Unity.exe -batchmode -quit -projectPath unity/WaifuAvatar -executeMethod WaifuAvatar.Editor.WaifuProjectSetup.SetUpAll -logFile setup.log
```

이 스크립트가 박는 설정들은 **하나라도 틀리면 창이 불투명해지거나 전체화면으로 튄다.**
UniWindowController 가 직접 검사하는 항목과 같다:

| 설정 | 값 | 이유 |
|---|---|---|
| `runInBackground` | true | 포커스를 잃어도 계속 그린다 |
| `resizableWindow` | true | 창 크기를 코드로 못 바꾸게 된다 |
| `fullScreenMode` | Windowed | 전체화면이면 투명도 클릭통과도 무의미 |
| `allowFullscreenSwitch` | false | 실수로 전체화면 전환되는 것을 막는다 |
| `useFlipModelSwapchain` | **false** | Windows 투명 창의 핵심. 켜면 배경이 검게 찬다 |
| Graphics API | Direct3D11 | D3D12 는 투명 창을 지원하지 않는다 |
| Camera `allowMSAA` | false | 가장자리 알파가 뭉개져 투명이 깨진다 |
| Camera clear | 알파 0 단색 | Skybox 면 하늘이 찍힌다 |

## 실행

이 플레이어는 **Electron 이 띄운다.** 직접 실행하면 환경변수가 없어서
연결할 곳을 모르고 바로 종료한다 (의도된 동작이다).

`waifu.config.json` 에서:

```json
{
  "avatar": { "renderer": "unity" },
  "unity": { "playerPath": "C:/.../WaifuAvatar.exe" }
}
```

`renderer` 가 `"renderer"` 면 기존 three-vrm 렌더러를 쓴다. 이관 기간 동안
둘을 병행시키기 위한 스위치다.

## 브리지

`src/shared/protocol.ts` 가 계약의 단일 진실 원천이고,
`Scripts/Bridge/BridgeMessages.cs` 는 그것의 미러다. **저쪽이 원본이다.**

- 127.0.0.1 의 임의 포트, 연결마다 무작위 토큰
- **첫 메시지는 반드시 인증 핸드셰이크.** 인증 전 명령과 `protocolVersion` 불일치는 거절
- 한 메시지는 JSON 객체 하나
- `Protocol.Version` 은 protocol.ts 의 `AVATAR_PROTOCOL_VERSION` 과 같아야 한다.
  한쪽만 올리면 핸드셰이크에서 끊긴다 — 그게 의도된 동작이다

**연결이 끊기면 셸은 스스로 종료한다.** 이게 고아 프로세스에 대한 진짜 안전망이다 —
Electron 이 크래시하면 저쪽 정리 코드는 실행될 기회조차 없고, 투명하고 클릭이 통과하는
창이 남으면 사용자는 그것을 닫을 방법이 없다.

## 테스트

에디터에서 **Window → General → Test Runner → EditMode**.
계약 미러(JSON 모양, 상태 파싱)를 잠근다. 실제 렌더링 품질은 눈으로 봐야 한다.
