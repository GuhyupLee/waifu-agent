import { StrictMode, useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type {
  Diagnostics,
  PanelEvent,
  PermissionDecision,
  PermissionRequest,
  WaifuApi,
  WaifuConfig
} from '@shared/protocol'
import { Home } from './home/Home'
import {
  enqueuePermission,
  INITIAL_PANEL_STATE,
  reducePanelState,
  removePermission
} from './home/panelState'
import { subscribeBeforeHydrate } from './hydration'
import { Settings } from './settings/Settings'

declare global {
  interface Window {
    waifu: WaifuApi
  }
}

function Panel(): React.JSX.Element {
  const [config, setConfig] = useState<WaifuConfig | null>(null)
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null)
  const [state, dispatch] = useReducer(reducePanelState, INITIAL_PANEL_STATE)
  const [permissionQueue, setPermissionQueue] = useState<PermissionRequest[]>([])
  const [input, setInput] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [choosingWorkspace, setChoosingWorkspace] = useState(false)
  const [choosingModel, setChoosingModel] = useState(false)
  const [restartingApp, setRestartingApp] = useState(false)
  const nextId = useRef(1)
  const showActivity = useRef(true)
  const permissionRevision = useRef(0)
  const permission = permissionQueue[0] ?? null

  const itemId = useCallback((): number => {
    const id = nextId.current
    nextId.current += 1
    return id
  }, [])

  const refreshDiagnostics = useCallback(async (): Promise<void> => {
    try {
      setDiagnostics(await window.waifu.diagnostics())
    } catch (err) {
      dispatch({
        type: 'notice',
        level: 'error',
        message: `현재 상태를 읽지 못했어: ${String(err)}`,
        id: itemId()
      })
    }
  }, [itemId])

  const refreshConfig = useCallback(async (): Promise<WaifuConfig | null> => {
    try {
      const next = await window.waifu.getConfig()
      setConfig(next)
      showActivity.current = next.chat.showActivity
      return next
    } catch (err) {
      dispatch({
        type: 'notice',
        level: 'error',
        message: `설정을 읽지 못했어: ${String(err)}`,
        id: itemId()
      })
      return null
    }
  }, [itemId])

  const refreshPendingPermissions = useCallback(async (): Promise<void> => {
    try {
      const revision = permissionRevision.current
      const pending = await window.waifu.listPendingPermissions()
      // HMR이나 패널 재생성 전에 떠 있던 요청도 다시 보여준다. 조회 도중 새 이벤트가
      // 없었다면 main의 목록을 정답으로 쓰고, 이벤트가 끼었다면 새 요청을 보존해 합친다.
      setPermissionQueue((current) =>
        permissionRevision.current === revision
          ? pending
          : pending.reduce(enqueuePermission, current)
      )
      if (pending.length > 0) setShowSettings(false)
    } catch (err) {
      dispatch({
        type: 'notice',
        level: 'warn',
        message: `대기 중인 권한 요청을 복구하지 못했어: ${String(err)}`,
        id: itemId()
      })
    }
  }, [itemId])

  const refreshAll = useCallback(async (): Promise<void> => {
    await Promise.all([refreshConfig(), refreshDiagnostics(), refreshPendingPermissions()])
  }, [refreshConfig, refreshDiagnostics, refreshPendingPermissions])

  useEffect(() => {
    return subscribeBeforeHydrate(
      () =>
        window.waifu.onPanelEvent((event: PanelEvent) => {
          switch (event.type) {
            case 'notice':
              if (event.level === 'info' && event.message.startsWith('나 · ')) {
                dispatch({ type: 'user-sent', text: event.message.slice(4), id: itemId() })
              } else {
                dispatch({
                  type: 'notice',
                  level: event.level,
                  message: event.message,
                  id: itemId()
                })
              }
              return

            case 'permission-request':
              permissionRevision.current += 1
              setPermissionQueue((current) =>
                enqueuePermission(current, event.request)
              )
              setShowSettings(false)
              return

            case 'permission-resolved':
              permissionRevision.current += 1
              setPermissionQueue((current) => removePermission(current, event.id))
              return

            case 'config':
              setConfig(event.config)
              showActivity.current = event.config.chat.showActivity
              void refreshDiagnostics()
              return

            case 'backend':
              dispatch({
                type: 'backend',
                event: event.event,
                showActivity: showActivity.current,
                id: itemId()
              })
              if (
                event.event.type === 'session' ||
                event.event.type === 'result' ||
                event.event.type === 'error' ||
                event.event.type === 'exit'
              ) {
                void refreshDiagnostics()
              }
          }
        }),
      () => {
        void refreshAll()
      }
    )
  }, [itemId, refreshAll, refreshDiagnostics])

  useEffect(() => {
    dispatch({ type: 'permission-current', id: permission?.id ?? null })
  }, [permission?.id])

  const restartApp = useCallback(async (): Promise<boolean> => {
    if (restartingApp) return false
    setRestartingApp(true)
    try {
      const result = await window.waifu.restartApp()
      if (!result.ok) {
        dispatch({
          type: 'notice',
          level: 'warn',
          message: result.reason ?? '앱을 다시 시작해 새 설정을 적용하지 못했어.',
          id: itemId()
        })
      }
      await refreshDiagnostics()
      return result.ok
    } catch (err) {
      dispatch({
        type: 'notice',
        level: 'error',
        message: `앱을 다시 시작하지 못했어: ${String(err)}`,
        id: itemId()
      })
      await refreshDiagnostics()
      return false
    } finally {
      setRestartingApp(false)
    }
  }, [itemId, refreshDiagnostics, restartingApp])

  const chooseWorkspace = useCallback(async (): Promise<void> => {
    if (choosingWorkspace) return
    setChoosingWorkspace(true)
    try {
      const path = await window.waifu.pickWorkspace()
      if (!path) return
      const current = config ?? (await refreshConfig())
      if (!current) return

      // 홈의 폴더 선택은 "현재 작업 폴더 바꾸기"다. 예전에 고른 추가 폴더를
      // 조용히 유지하면 화면에 보이지 않는 --add-dir 권한이 남는다.
      const workspaces = [path]
      const next = await window.waifu.setConfig({
        permission: { ...current.permission, workspaces }
      })
      setConfig(next)
      showActivity.current = next.chat.showActivity

      dispatch({
        type: 'notice',
        level: 'info',
        message: `작업 폴더를 ${path}(으)로 저장했어. 새 범위로 시작하려면 ‘앱 다시 시작해 적용’을 눌러줘.`,
        id: itemId()
      })
      await refreshDiagnostics()
    } catch (err) {
      dispatch({
        type: 'notice',
        level: 'error',
        message: `작업 폴더를 저장하지 못했어: ${String(err)}`,
        id: itemId()
      })
    } finally {
      setChoosingWorkspace(false)
    }
  }, [choosingWorkspace, config, itemId, refreshConfig, refreshDiagnostics])

  const chooseModel = useCallback(async (): Promise<void> => {
    if (choosingModel) return
    setChoosingModel(true)
    try {
      const path = await window.waifu.pickModel()
      if (!path) return
      const current = config ?? (await refreshConfig())
      if (!current) return
      const next = await window.waifu.setConfig({ avatar: { ...current.avatar, modelPath: path } })
      setConfig(next)
    } catch (err) {
      dispatch({
        type: 'notice',
        level: 'error',
        message: `아바타 모델을 적용하지 못했어: ${String(err)}`,
        id: itemId()
      })
    } finally {
      setChoosingModel(false)
    }
  }, [choosingModel, config, itemId, refreshConfig])

  const send = (): void => {
    const text = input.trim()
    if (
      !text ||
      !diagnostics?.runtime ||
      permission ||
      state.busy ||
      diagnostics.busy ||
      restartingApp
    ) return
    setInput('')
    window.waifu.sendMessage(text)
  }

  const respondPermission = (decision: PermissionDecision): void => {
    if (!permission) return
    const id = permission.id
    permissionRevision.current += 1
    window.waifu.respondPermission(id, decision)
    setPermissionQueue((current) => removePermission(current, id))
  }

  if (showSettings) {
    return (
      <Settings
        onClose={() => {
          setShowSettings(false)
          void refreshAll()
        }}
      />
    )
  }

  return (
    <Home
      config={config}
      diagnostics={diagnostics}
      state={state}
      permission={permission}
      input={input}
      choosingWorkspace={choosingWorkspace}
      choosingModel={choosingModel}
      restartingApp={restartingApp}
      onInput={setInput}
      onSend={send}
      onInterrupt={() => {
        window.waifu.interrupt()
        dispatch({ type: 'interrupted' })
        void refreshDiagnostics()
      }}
      onOpenSettings={() => setShowSettings(true)}
      onChooseWorkspace={() => void chooseWorkspace()}
      onChooseModel={() => void chooseModel()}
      onRestartApp={() => void restartApp()}
      onPermission={respondPermission}
    />
  )
}

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('#root 를 찾을 수 없다')

/** HMR이 모듈을 다시 평가해도 같은 DOM 컨테이너에 React root를 두 번 만들지 않는다. */
interface PanelWindow extends Window {
  __panelRoot?: ReturnType<typeof createRoot>
}

const host = window as PanelWindow
host.__panelRoot ??= createRoot(rootElement)
host.__panelRoot.render(
  <StrictMode>
    <Panel />
  </StrictMode>
)
