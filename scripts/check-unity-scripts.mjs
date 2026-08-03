#!/usr/bin/env node
/**
 * Unity C# 스크립트를 **Editor 라이선스 없이** 컴파일 검증한다.
 *
 * 왜 필요한가: 이 저장소의 Unity 라이선스는 아직 활성화되지 않았고
 * (`No valid Unity Editor license found`), 배치 모드 빌드가 막혀 있다. 그동안
 * C# 쪽 검증 수단이 "눈으로 읽기" 뿐이었다 — 오타 하나가 다음 세션까지 살아남는다.
 *
 * Unity 는 자기 Roslyn(`Editor/Data/DotNetSdkRoslyn/csc.dll`)과 엔진 참조
 * 어셈블리를 라이선스와 무관하게 디스크에 깔아 둔다. 그래서 csc 를 직접 불러
 * 컴파일만 돌릴 수 있다. **컴파일이지 실행이 아니다** — 테스트가 통과한다는
 * 뜻이 아니라 코드가 빌드된다는 뜻이다.
 *
 * 서드파티 어셈블리(UniVRM·UniGLTF·UniWindowController)는 소스가 아니라
 * `Library/ScriptAssemblies/*.dll` 를 참조한다. 875개 파일을 재컴파일하려면
 * Burst·Collections 까지 끌고 와야 하는데, 우리가 검증하려는 건 우리 코드다.
 * 그 DLL 은 gitignore 대상이라 갓 클론한 저장소에는 없다 — 그때는 실패가
 * 아니라 "Editor 를 한 번 열어라" 로 안내한다.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const unityProject = join(repoRoot, 'unity', 'WaifuAvatar')
const scriptAssemblies = join(unityProject, 'Library', 'ScriptAssemblies')
const outDir = join(unityProject, 'Temp', 'ScriptCheck')

/** Unity 설치 위치. 버전이 바뀌어도 되게 env 로 덮어쓸 수 있다. */
function findEditorData() {
  if (process.env.UNITY_EDITOR_DATA) return process.env.UNITY_EDITOR_DATA
  const hub = 'C:/Program Files/Unity/Hub/Editor'
  if (!existsSync(hub)) return null
  // 여러 버전이 깔려 있으면 최신을 쓴다. 우리 프로젝트는 6000.3 계열이다.
  const versions = readdirSync(hub)
    .filter((v) => existsSync(join(hub, v, 'Editor', 'Data', 'DotNetSdkRoslyn', 'csc.dll')))
    .sort()
  const latest = versions[versions.length - 1]
  return latest ? join(hub, latest, 'Editor', 'Data') : null
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (name.endsWith('.cs')) out.push(path)
  }
  return out
}

const editorData = findEditorData()
if (!editorData) {
  console.error('Unity Editor 를 찾지 못했다. UNITY_EDITOR_DATA 로 …/Editor/Data 경로를 지정해라.')
  process.exit(2)
}

const csc = join(editorData, 'DotNetSdkRoslyn', 'csc.dll')
const engineDir = join(editorData, 'Managed', 'UnityEngine')

/**
 * netstandard 참조 + netfx 심.
 *
 * 심이 필요한 이유: nunit.framework.dll 이 net40 빌드라 `mscorlib 4.0.0.0` 를
 * 가리킨다. netstandard.dll 만 주면 `[Test]` 하나마다 CS0012 가 뜬다.
 * Unity 도 같은 심 폴더를 .csproj 에 넣는다.
 */
const coreRefs = [
  join(editorData, 'NetStandard', 'ref', '2.1.0', 'netstandard.dll'),
  ...(existsSync(join(editorData, 'NetStandard', 'compat', '2.1.0', 'shims', 'netfx'))
    ? readdirSync(join(editorData, 'NetStandard', 'compat', '2.1.0', 'shims', 'netfx'))
        .filter((f) => f.endsWith('.dll'))
        .map((f) => join(editorData, 'NetStandard', 'compat', '2.1.0', 'shims', 'netfx', f))
    : []),
]

if (!existsSync(scriptAssemblies)) {
  console.error(
    `${scriptAssemblies} 가 없다.\n` +
      'Unity Editor 로 프로젝트를 한 번 열어 서드파티 어셈블리를 빌드해야 한다.\n' +
      '(UniVRM·UniGLTF 소스를 여기서 다시 컴파일하지는 않는다 — 검증 대상은 우리 코드다.)'
  )
  process.exit(2)
}

/** 엔진 모듈은 전부 참조한다. 어느 모듈이 필요한지 미리 알 방법이 없다. */
const engineRefs = readdirSync(engineDir)
  .filter((f) => f.startsWith('UnityEngine') && f.endsWith('.dll'))
  .map((f) => join(engineDir, f))

const dep = (name) => join(scriptAssemblies, `${name}.dll`)

const nunit = join(
  editorData,
  'Resources/PackageManager/BuiltInPackages/com.unity.ext.nunit/net40/unity-custom/nunit.framework.dll'
)

/**
 * asmdef 3개를 각각의 실제 구성으로 컴파일한다.
 *
 * 런타임 어셈블리에 `UNITY_EDITOR` 를 주지 않는 것이 중요하다 — 셸은 플레이어로
 * 빌드되므로, 에디터에서만 컴파일되는 코드는 여기서 걸려야 한다.
 */
const targets = [
  {
    name: 'WaifuAvatar',
    sources: walk(join(unityProject, 'Assets/WaifuAvatar/Scripts')),
    refs: [
      dep('UniGLTF'),
      dep('UniGLTF.Utils'),
      dep('VRM10'),
      dep('VrmLib'),
      dep('Kirurobo.UniWindowController'),
      dep('Unity.Timeline'),
      dep('Unity.Mathematics'),
    ],
    defines: ['UNITY_STANDALONE_WIN', 'UNITY_STANDALONE', 'UNITY_64'],
  },
  {
    name: 'WaifuAvatar.Editor',
    sources: walk(join(unityProject, 'Assets/WaifuAvatar/Editor')),
    refs: [
      join(editorData, 'Managed', 'UnityEditor.dll'),
      dep('UniGLTF'),
      dep('VRM10'),
      dep('Kirurobo.UniWindowController'),
    ],
    defines: ['UNITY_EDITOR', 'UNITY_STANDALONE_WIN', 'UNITY_64'],
    self: true,
  },
  {
    name: 'WaifuAvatar.Tests',
    sources: walk(join(unityProject, 'Assets/WaifuAvatar/Tests')),
    refs: [
      join(editorData, 'Managed', 'UnityEditor.dll'),
      dep('VRM10'),
      dep('UniGLTF'),
      dep('VrmLib'),
      dep('Kirurobo.UniWindowController'),
      dep('Unity.Timeline'),
      dep('Unity.Mathematics'),
      dep('UnityEngine.TestRunner'),
      dep('UnityEditor.TestRunner'),
      nunit,
    ],
    defines: ['UNITY_EDITOR', 'UNITY_INCLUDE_TESTS', 'UNITY_STANDALONE_WIN', 'UNITY_64'],
    self: true,
  },
]

mkdirSync(outDir, { recursive: true })

const runTests = process.argv.includes('--run')
let failed = false
for (const target of targets) {
  if (target.sources.length === 0) {
    console.log(`- ${target.name}: 소스 없음, 건너뜀`)
    continue
  }

  // 앞 단계에서 우리가 방금 만든 산출물을 쓴다. Library 의 것은 Editor 가
  // 마지막으로 열렸을 때의 낡은 코드라, 그걸 참조하면 방금 고친 시그니처
  // 불일치를 놓친다.
  const ours = target.self ? [join(outDir, 'WaifuAvatar.dll')] : []
  const refs = [...coreRefs, ...engineRefs, ...ours, ...target.refs].filter((r) => existsSync(r))

  const args = [
    csc,
    '-nologo',
    '-noconfig',
    '-nostdlib',
    '-target:library',
    '-langversion:9',
    // 경고는 경고로 둔다. `-warnaserror+` 를 걸면 Unity 가 멀쩡히 빌드하는 코드를
    // 이 스크립트만 거부하게 되고, 그러면 아무도 이 스크립트를 믿지 않는다.
    // 경고는 출력에 남으니 눈에는 보인다.
    // 한국어 로캘에서 csc 가 뱉는 진단이 콘솔 인코딩과 어긋나 깨진다.
    // 읽을 수 없는 오류 메시지는 없는 것과 같다.
    '-preferreduilang:en',
    // Unity 가 생성하는 .csproj 와 같은 억제 목록. 0169(미사용 필드)는
    // [SerializeField] 가 코드에서 안 읽히는 정상 패턴을 오탐한다.
    '-nowarn:0169,0649,0414,1701,1702',
    `-out:${join(outDir, `${target.name}.dll`)}`,
    ...target.defines.map((d) => `-define:${d}`),
    ...refs.map((r) => `-r:${r}`),
    ...target.sources,
  ]

  const result = spawnSync('dotnet', args, { encoding: 'utf8' })
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim()

  if (result.status === 0) {
    console.log(`✓ ${target.name} (${target.sources.length} 파일)`)
    if (output) console.log(output)
  } else {
    failed = true
    console.error(`✗ ${target.name}`)
    console.error(output)
  }
}

if (failed || !runTests) process.exit(failed ? 1 : 0)

// ─────────────────────── EditMode 테스트 실행 ───────────────────────
//
// Unity Test Runner 없이 EditMode 테스트를 **실제로 돌린다.**
//
// 되는 이유: `Mathf`·`Vector2`·`Rect` 는 UnityEngine.CoreModule.dll 안의 평범한
// 관리 코드라 네이티브 엔진 없이도 동작한다. 우리 순수 규칙 클래스들은 그 셋
// 말고는 엔진을 건드리지 않게 만들어 뒀다 — 그래서 여기서 통째로 돌아간다.
//
// 반대로 `GameObject`·`Animator` 를 만드는 테스트는 네이티브가 필요해서 여기서
// 돌지 않는다. **건너뛴 것을 이름으로 찍는다** — 조용히 빼면 "전부 통과" 로 읽힌다.
// 건너뛰기는 기본적으로 **테스트 단위**로 판정한다. 예전에는 클래스 통째로 뺐는데,
// 그러면 같은 파일에 있는 순수 계산 테스트까지 같이 사라진다 —
// PoseOverlayTests 에는 GameObject 가 필요한 것과 OverlayMath 만 쓰는 것이 섞여 있다.
// 네이티브가 필요해 **던진** 것은 실패가 아니라 건너뜀으로 센다.
//
// 예외 하나: JsonUtility 는 네이티브가 없으면 던지지 않고 **조용히 null 을
// 돌려준다.** 그래서 예외로는 구분할 수 없고, 통째로 빼는 수밖에 없다.
const silentlyNativeSuites = new Map([
  ['WaifuAvatar.Tests.BridgeContractTests', 'JsonUtility 가 예외 대신 null 을 돌려준다'],
])

const runnerSource = join(outDir, 'WaifuTestRunner.cs')
writeFileSync(
  runnerSource,
  `using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;

public static class WaifuTestRunner
{
    public static int Main(string[] args)
    {
        // 한국어 테스트 이름과 실패 메시지가 콘솔 코드페이지에서 깨진다.
        Console.OutputEncoding = System.Text.Encoding.UTF8;

        var probes = args.Skip(2).ToArray();
        AssemblyLoadContext.Default.Resolving += (context, name) =>
        {
            foreach (var dir in probes)
            {
                var path = Path.Combine(dir, name.Name + ".dll");
                if (File.Exists(path)) return context.LoadFromAssemblyPath(path);
            }
            return null;
        };

        // Debug.Log 는 네이티브 ECall 이라 엔진 없이 부르면 SecurityException 이 난다.
        // 우리 규칙 클래스들은 로그를 남기므로, 로그를 끄지 않으면 "로그 한 줄 때문에"
        // 순수 로직 테스트가 실패한다. Logger.logEnabled 를 내리면 핸들러까지 가지 않는다.
        try
        {
            var core = Assembly.Load("UnityEngine.CoreModule");
            var logger = core.GetType("UnityEngine.Debug")
                .GetProperty("unityLogger", BindingFlags.Public | BindingFlags.Static)
                .GetValue(null);
            logger.GetType().GetProperty("logEnabled").SetValue(logger, false);
            Console.WriteLine("- Debug.Log 는 꺼진 채로 돈다 (엔진 네이티브 호출).");
        }
        catch (Exception error)
        {
            Console.WriteLine($"- Debug.Log 를 끄지 못했다: {error.Message}");
        }

        var assembly = Assembly.LoadFrom(args[0]);
        var forcedSkips = args[1].Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries)
            .Select(entry => entry.Split(new[] { '=' }, 2))
            .ToDictionary(parts => parts[0], parts => parts[1]);
        int passed = 0, failedCount = 0, skippedCount = 0;
        var skippedSuites = new SortedDictionary<string, int>();

        foreach (var type in assembly.GetTypes().OrderBy(t => t.FullName))
        {
            var tests = type.GetMethods(BindingFlags.Public | BindingFlags.Instance)
                .Where(m => m.GetCustomAttributes().Any(a =>
                    a.GetType().Name == "TestAttribute" || a.GetType().Name == "TestCaseAttribute"))
                .ToArray();
            if (tests.Length == 0) continue;

            if (forcedSkips.TryGetValue(type.FullName, out var forcedReason))
            {
                skippedCount += tests.Length;
                Console.WriteLine($"- 건너뜀 {type.Name} ({tests.Length}개) — {forcedReason}. Unity Test Runner 로 돌려야 한다.");
                continue;
            }

            var setUp = type.GetMethods(BindingFlags.Public | BindingFlags.Instance)
                .FirstOrDefault(m => m.GetCustomAttributes().Any(a => a.GetType().Name == "SetUpAttribute"));

            foreach (var test in tests)
            {
                // [TestCase(...)] 는 인자 묶음마다 한 번씩 돈다. [Test] 는 인자 없이 한 번.
                var cases = test.GetCustomAttributes()
                    .Where(a => a.GetType().Name == "TestCaseAttribute")
                    .Select(a => (object[])a.GetType().GetProperty("Arguments").GetValue(a))
                    .ToArray();
                if (cases.Length == 0) cases = new[] { Array.Empty<object>() };

                foreach (var arguments in cases)
                {
                    var label = arguments.Length == 0
                        ? $"{type.Name}.{test.Name}"
                        : $"{type.Name}.{test.Name}({string.Join(", ", arguments)})";
                    try
                    {
                        var instance = Activator.CreateInstance(type);
                        setUp?.Invoke(instance, null);
                        test.Invoke(instance, arguments);
                        passed++;
                    }
                    catch (Exception error)
                    {
                        var root = error;
                        while (root.InnerException != null) root = root.InnerException;

                        // 엔진 네이티브가 필요한 테스트. 여기서는 돌릴 수 없을 뿐
                        // 코드가 틀린 것이 아니라 실패로 세지 않는다.
                        if (root is System.Security.SecurityException || root.Message.Contains("ECall"))
                        {
                            skippedCount++;
                            skippedSuites.TryGetValue(type.Name, out var n);
                            skippedSuites[type.Name] = n + 1;
                            continue;
                        }

                        failedCount++;
                        Console.WriteLine($"  FAIL {label}");
                        Console.WriteLine($"       {root.Message.Replace("\\n", "\\n       ")}");
                    }
                }
            }
        }

        foreach (var entry in skippedSuites)
        {
            Console.WriteLine($"- 건너뜀 {entry.Key} ({entry.Value}개) — 엔진 네이티브가 필요하다. Unity Test Runner 로 돌려야 한다.");
        }
        Console.WriteLine($"테스트 {passed}개 통과, {failedCount}개 실패, {skippedCount}개 건너뜀");
        return failedCount == 0 ? 0 : 1;
    }
}
`,
  'utf8'
)

// 러너는 Unity 코드가 아니라 평범한 .NET 콘솔 앱이다. `System.Runtime.Loader` 가
// netstandard 2.1 에 없으므로 설치된 .NET SDK 의 참조 어셈블리로 컴파일한다.
const refPackRoot = 'C:/Program Files/dotnet/packs/Microsoft.NETCore.App.Ref'
const refPackVersion = existsSync(refPackRoot) ? readdirSync(refPackRoot).sort().pop() : null
if (!refPackVersion) {
  console.error('.NET 참조 팩을 찾지 못했다. .NET SDK 가 필요하다.')
  process.exit(2)
}
const refPack = join(refPackRoot, refPackVersion, 'ref', `net${refPackVersion.split('.')[0]}.0`)

const runnerExe = join(outDir, 'WaifuTestRunner.dll')
const runnerBuild = spawnSync(
  'dotnet',
  [
    csc,
    '-nologo',
    '-noconfig',
    '-nostdlib',
    '-target:exe',
    '-langversion:9',
    '-preferreduilang:en',
    `-out:${runnerExe}`,
    ...readdirSync(refPack)
      .filter((f) => f.endsWith('.dll'))
      .map((f) => `-r:${join(refPack, f)}`),
    runnerSource,
  ],
  { encoding: 'utf8' }
)
if (runnerBuild.status !== 0) {
  console.error('✗ 테스트 러너 빌드 실패')
  console.error(`${runnerBuild.stdout || ''}${runnerBuild.stderr || ''}`)
  process.exit(1)
}

// .NET 은 exe 옆이나 deps.json 으로만 어셈블리를 찾는다. Unity 의 Managed 폴더를
// 통째로 복사하지 않으려고 러너가 직접 probe 경로에서 로드한다.
writeFileSync(
  join(outDir, 'WaifuTestRunner.runtimeconfig.json'),
  JSON.stringify({
    runtimeOptions: { tfm: 'net9.0', framework: { name: 'Microsoft.NETCore.App', version: '9.0.0' } },
  }),
  'utf8'
)

const run = spawnSync(
  'dotnet',
  [
    runnerExe,
    join(outDir, 'WaifuAvatar.Tests.dll'),
    [...silentlyNativeSuites].map(([suite, reason]) => `${suite}=${reason}`).join(';'),
    outDir,
    engineDir,
    scriptAssemblies,
    dirname(nunit),
    join(editorData, 'Managed'),
  ],
  { encoding: 'utf8' }
)
process.stdout.write(`${run.stdout || ''}`)
if (run.stderr) process.stderr.write(run.stderr)
process.exit(run.status === 0 ? 0 : 1)
