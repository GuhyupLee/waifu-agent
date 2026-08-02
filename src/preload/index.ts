import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/protocol'
import type {
  AvatarCommand,
  AvatarEvent,
  Diagnostics,
  FileChange,
  PanelEvent,
  StoredMemory,
  StoredReminder,
  StoredRoutine,
  PermissionDecision,
  WaifuApi,
  WaifuConfig
} from '@shared/protocol'

/**
 * 구독을 걸고 해제 함수를 돌려준다. 해제를 빼먹으면 HMR 로 렌더러가 다시 붙을 때마다
 * 리스너가 쌓여서 같은 명령이 여러 번 실행된다.
 */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api: WaifuApi = {
  onAvatarCommand: (cb: (cmd: AvatarCommand) => void) => subscribe(IPC.avatarCommand, cb),
  sendAvatarEvent: (event: AvatarEvent) => ipcRenderer.send(IPC.avatarEvent, event),

  onPanelEvent: (cb: (event: PanelEvent) => void) => subscribe(IPC.panelEvent, cb),
  sendMessage: (text: string) => ipcRenderer.send(IPC.sendMessage, text),
  interrupt: () => ipcRenderer.send(IPC.interrupt),
  respondPermission: (id: string, decision: PermissionDecision) =>
    ipcRenderer.send(IPC.permissionRespond, { id, decision }),

  getConfig: () => ipcRenderer.invoke(IPC.configGet) as Promise<WaifuConfig>,
  setConfig: (patch: Partial<WaifuConfig>) =>
    ipcRenderer.invoke(IPC.configSet, patch) as Promise<WaifuConfig>,
  pickModel: () => ipcRenderer.invoke(IPC.pickModel) as Promise<string | null>,

  listChanges: () => ipcRenderer.invoke(IPC.changesList) as Promise<FileChange[]>,
  undoChange: (id: string) =>
    ipcRenderer.invoke(IPC.changesUndo, id) as Promise<{ ok: boolean; reason?: string }>,

  listMemories: () => ipcRenderer.invoke(IPC.memoryList) as Promise<StoredMemory[]>,
  forgetMemory: (key: string) => ipcRenderer.invoke(IPC.memoryForget, key) as Promise<boolean>,
  listRoutines: () => ipcRenderer.invoke(IPC.routineList) as Promise<StoredRoutine[]>,
  removeRoutine: (name: string) => ipcRenderer.invoke(IPC.routineRemove, name) as Promise<boolean>,
  listReminders: () => ipcRenderer.invoke(IPC.reminderList) as Promise<StoredReminder[]>,
  cancelReminder: (id: string) => ipcRenderer.invoke(IPC.reminderCancel, id) as Promise<boolean>,

  diagnostics: () => ipcRenderer.invoke(IPC.diagnostics) as Promise<Diagnostics>,
  pingVoice: (url: string) => ipcRenderer.invoke(IPC.pingVoice, url) as Promise<string | null>
}

contextBridge.exposeInMainWorld('waifu', api)
