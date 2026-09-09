import { contextBridge, ipcRenderer } from 'electron'

/** Minimal IPC surface: shell status and the restart affordance. */
contextBridge.exposeInMainWorld('electronAPI', {
  getStatus: () => ipcRenderer.invoke('dsh-status'),
  restartDsh: () => ipcRenderer.invoke('dsh-restart'),
})
