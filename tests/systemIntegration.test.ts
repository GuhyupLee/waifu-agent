import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type WaifuConfig } from '@shared/protocol'
import {
  shouldQuitOnClose,
  startedHidden,
  syncLaunchAtLogin,
  trayMenu,
  type LoginItemHost
} from '../src/main/system/integration'

function config(patch: Partial<WaifuConfig['system']> = {}): WaifuConfig {
  return { ...DEFAULT_CONFIG, system: { ...DEFAULT_CONFIG.system, ...patch } }
}

function host(openAtLogin: boolean): LoginItemHost & { setLoginItemSettings: ReturnType<typeof vi.fn> } {
  return {
    getLoginItemSettings: () => ({ openAtLogin }),
    setLoginItemSettings: vi.fn()
  }
}

describe('시작 프로그램 등록', () => {
  it('설정과 이미 같으면 건드리지 않는다', () => {
    const h = host(false)
    expect(syncLaunchAtLogin(h, config({ launchAtLogin: false }), 'win32')).toBe('unchanged')
    expect(h.setLoginItemSettings).not.toHaveBeenCalled()
  })

  it('켜면 --hidden 으로 등록한다', () => {
    // 부팅하자마자 아바타가 화면 가운데 튀어나오면 방해가 된다.
    const h = host(false)
    expect(syncLaunchAtLogin(h, config({ launchAtLogin: true }), 'win32')).toBe('applied')
    expect(h.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      args: ['--hidden']
    })
  })

  it('끄면 등록을 해제한다', () => {
    const h = host(true)
    expect(syncLaunchAtLogin(h, config({ launchAtLogin: false }), 'win32')).toBe('applied')
    expect(h.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false, args: [] })
  })

  it('지원하지 않는 플랫폼에서는 조용히 실패하지 않고 알린다', () => {
    // 조용히 넘어가면 사용자는 등록된 줄 안다.
    const h = host(false)
    expect(syncLaunchAtLogin(h, config({ launchAtLogin: true }), 'linux')).toBe('unsupported')
    expect(h.setLoginItemSettings).not.toHaveBeenCalled()
  })

  it('macOS 는 지원한다', () => {
    const h = host(false)
    expect(syncLaunchAtLogin(h, config({ launchAtLogin: true }), 'darwin')).toBe('applied')
  })
})

describe('숨김 시작', () => {
  it('--hidden 이 있으면 조용히 뜬다', () => {
    expect(startedHidden(['electron.exe', '--hidden'])).toBe(true)
    expect(startedHidden(['electron.exe'])).toBe(false)
  })
})

describe('창을 닫을 때', () => {
  it('트레이가 실제로 있고 closeToTray 면 남는다', () => {
    expect(shouldQuitOnClose(config({ trayIcon: true, closeToTray: true }), true)).toBe(false)
  })

  it('closeToTray 가 꺼져 있으면 종료한다', () => {
    expect(shouldQuitOnClose(config({ trayIcon: true, closeToTray: false }), true)).toBe(true)
  })

  it('트레이 설정이 꺼져 있으면 closeToTray 여도 종료한다', () => {
    expect(shouldQuitOnClose(config({ trayIcon: false, closeToTray: true }), false)).toBe(true)
  })

  /**
   * 실제로 이 상태에 빠졌다. 설정에는 트레이가 켜져 있는데 `resources/tray.png` 가
   * 없어 트레이가 만들어지지 않았고, 창을 닫자 되살릴 입구가 없는 채로 프로세스만
   * 남았다. 설정이 아니라 트레이의 실재를 봐야 하는 이유다.
   */
  it('설정은 켜져 있어도 트레이가 안 만들어졌으면 종료한다', () => {
    expect(shouldQuitOnClose(config({ trayIcon: true, closeToTray: true }), false)).toBe(true)
  })
})

describe('트레이 메뉴', () => {
  it('연결 상태를 보여준다', () => {
    const connected = trayMenu(config(), true)
    expect(connected[0].label).toContain('연결됨')

    const off = trayMenu(config(), false)
    expect(off[0].label).toContain('꺼짐')
  })

  it('종료 항목이 반드시 있다', () => {
    // 창이 트레이로 숨는 앱에서 종료 경로가 없으면 작업 관리자로 죽여야 한다.
    expect(trayMenu(config(), true).some((item) => item.id === 'quit')).toBe(true)
  })

  it('수면 항목이 실제 상태를 따라간다', () => {
    // 재우기만 되고 깨우지 못하던 회귀를 막는다. checked 가 늘 false 라
    // 사용자가 아바타를 깨울 방법이 없었다.
    const awake = trayMenu(config(), true, false).find((item) => item.id === 'toggle-sleep')
    expect(awake?.label).toBe('재우기')
    expect(awake?.checked).toBe(false)

    const asleep = trayMenu(config(), true, true).find((item) => item.id === 'toggle-sleep')
    expect(asleep?.label).toBe('깨우기')
    expect(asleep?.checked).toBe(true)
  })

  it('연결 상태를 수면 상태로 착각하지 않는다', () => {
    // '아바타 보이기' 항목이 unityConnected 를 checked 로 쓰다가, 누르면
    // 오히려 재우는 동작을 했다. 그 항목 자체를 없앴다.
    expect(trayMenu(config(), true).some((item) => item.id === 'toggle-avatar')).toBe(false)
  })

  it('자동 실행 체크 상태가 설정을 따른다', () => {
    const on = trayMenu(config({ launchAtLogin: true }), true)
    expect(on.find((item) => item.id === 'launch-at-login')?.checked).toBe(true)

    const off = trayMenu(config({ launchAtLogin: false }), true)
    expect(off.find((item) => item.id === 'launch-at-login')?.checked).toBe(false)
  })

  it('구분선을 빼면 모든 항목에 id 가 있다', () => {
    // id 없는 항목은 클릭을 처리할 수 없다.
    for (const item of trayMenu(config(), true)) {
      if (item.type === 'separator') continue
      expect(item.id, `${item.label} 에 id 가 없다`).toBeTruthy()
    }
  })
})
