import type { WaifuConfig } from '@shared/protocol'

/**
 * OS 통합 — 시작 프로그램 등록과 시스템 트레이.
 *
 * **다른 플랫폼에서 기능만 꺼지고 앱은 계속 돌아야 한다.** Windows 전용 동작을
 * 여기 가둬서, 호출부가 `process.platform` 을 흩뿌리지 않게 한다.
 *
 * Electron 을 직접 import 하지 않는다. 필요한 것만 인터페이스로 받아서 테스트에서
 * Electron 런타임 없이 돌린다 — 트레이 하나 때문에 테스트가 무거워질 이유가 없다.
 */

export interface LoginItemHost {
  setLoginItemSettings(settings: { openAtLogin: boolean; args?: string[] }): void
  getLoginItemSettings(): { openAtLogin: boolean }
}

/** 로그인 시 자동 실행을 설정과 맞춘다. 이미 맞으면 건드리지 않는다. */
export function syncLaunchAtLogin(
  host: LoginItemHost,
  config: WaifuConfig,
  platform: NodeJS.Platform = process.platform
): 'applied' | 'unchanged' | 'unsupported' {
  // linux 는 Electron 이 이 API 를 지원하지 않는다. 조용히 실패하는 대신 알린다.
  if (platform !== 'win32' && platform !== 'darwin') return 'unsupported'

  const wanted = config.system.launchAtLogin
  if (host.getLoginItemSettings().openAtLogin === wanted) return 'unchanged'

  // 자동 실행일 때는 창을 띄우지 않고 트레이로만 시작한다. 부팅하자마자 아바타가
  // 화면 가운데 튀어나오면 방해가 된다.
  host.setLoginItemSettings({ openAtLogin: wanted, args: wanted ? ['--hidden'] : [] })
  return 'applied'
}

/** 이번 실행이 로그인 자동 시작인가. 그렇다면 조용히 뜬다. */
export function startedHidden(argv: readonly string[]): boolean {
  return argv.includes('--hidden')
}

export interface TrayMenuItem {
  label: string
  /** 'separator' 는 클릭할 수 없는 구분선이다. */
  type?: 'normal' | 'separator' | 'checkbox'
  checked?: boolean
  id?: string
}

/**
 * 트레이 메뉴 구성.
 *
 * 메뉴 항목을 만드는 것과 Electron 에 붙이는 것을 나눈다 — 구성이 설정에 따라
 * 갈리는데, 그걸 Tray 객체와 엮으면 테스트할 수 없다.
 */
export function trayMenu(config: WaifuConfig, unityConnected: boolean, asleep = false): TrayMenuItem[] {
  return [
    { id: 'status', label: unityConnected ? '아바타: 연결됨' : '아바타: 꺼짐', type: 'normal' },
    { type: 'separator', label: '' },
    { id: 'show-panel', label: '관리·기록 열기', type: 'normal' },
    /**
     * 재우기/깨우기 하나로 합쳤다.
     *
     * 예전에는 '아바타 보이기' 와 '재우기' 두 항목이 있었는데 둘 다 고장나 있었다 —
     * 앞엣것은 연결 여부를 수면 상태로 착각해 눌면 오히려 재웠고, 뒤엣것은
     * checked 가 늘 false 라 재우기만 되고 깨우지 못했다. 상태는 셸이 올려주는
     * 것을 그대로 쓴다.
     */
    {
      id: 'toggle-sleep',
      label: asleep ? '깨우기' : '재우기',
      type: 'checkbox',
      checked: asleep
    },
    { type: 'separator', label: '' },
    {
      id: 'launch-at-login',
      label: '로그인할 때 자동 실행',
      type: 'checkbox',
      checked: config.system.launchAtLogin
    },
    { type: 'separator', label: '' },
    { id: 'quit', label: '종료', type: 'normal' }
  ]
}

/**
 * 창을 닫을 때 앱을 끝낼지 트레이로 보낼지.
 *
 * 트레이가 **없는데** 트레이로 보내면 앱을 되살릴 방법이 없다 — 작업 관리자로
 * 죽이는 것 말고는. 창은 사라졌는데 프로세스는 살아 있고, 다시 실행해도
 * 아무 일도 일어나지 않는 것처럼 보인다.
 *
 * **설정이 아니라 실제로 트레이가 만들어졌는지를 본다.** 예전에는
 * `config.system.trayIcon` 만 봤는데, 그 설정이 켜져 있어도 아이콘 파일이 없으면
 * 트레이는 만들어지지 않는다. 실제로 `resources/tray.png` 가 없는 환경에서
 * 정확히 그 상태가 됐다 — 설정상으로는 트레이가 있고, 화면에는 없었다.
 *
 * @param trayExists 트레이 인스턴스가 실제로 만들어졌는지.
 */
export function shouldQuitOnClose(config: WaifuConfig, trayExists: boolean): boolean {
  if (!trayExists) return true
  return !config.system.closeToTray
}
