/**
 * preload：contextBridge 类型化桥接（文档 §6.1）
 * 以 sandbox + contextIsolation 模式运行，仅暴露白名单 API
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopApi } from '../shared/types'

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: DesktopApi = {
  dsh: {
    start: () => ipcRenderer.invoke('dsh:start'),
    stop: () => ipcRenderer.invoke('dsh:stop'),
    restart: () => ipcRenderer.invoke('dsh:restart'),
    getState: () => ipcRenderer.invoke('dsh:getState'),
    onStateChange: (callback) => subscribe('dsh:statusChange', callback)
  },
  setup: {
    check: () => ipcRenderer.invoke('setup:check'),
    save: (apiKey) => ipcRenderer.invoke('setup:save', apiKey)
  },
  backup: {
    list: () => ipcRenderer.invoke('backup:list'),
    create: (name) => ipcRenderer.invoke('backup:create', name),
    restore: (id) => ipcRenderer.invoke('backup:restore', id),
    delete: (id) => ipcRenderer.invoke('backup:delete', id)
  },
  plugins: {
    catalog: (query) => ipcRenderer.invoke('plugins:catalog', query),
    installed: () => ipcRenderer.invoke('plugins:installed'),
    install: (pkg) => ipcRenderer.invoke('plugins:install', pkg),
    uninstall: (pkg) => ipcRenderer.invoke('plugins:uninstall', pkg)
  },
  kernels: {
    installed: () => ipcRenderer.invoke('kernels:installed'),
    available: () => ipcRenderer.invoke('kernels:available'),
    install: (version) => ipcRenderer.invoke('kernels:install', version),
    uninstall: (version) => ipcRenderer.invoke('kernels:uninstall', version),
    setDefault: (version) => ipcRenderer.invoke('kernels:setDefault', version),
    setMode: (mode) => ipcRenderer.invoke('kernels:setMode', mode),
    onProgress: (callback) => subscribe('kernels:progress', callback)
  },
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (patch) => ipcRenderer.invoke('config:set', patch)
  },
  tray: {
    show: () => ipcRenderer.invoke('tray:show'),
    hide: () => ipcRenderer.invoke('tray:hide')
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    onMaximizeChange: (callback) => subscribe('window:maximizeChange', callback)
  },
  updater: {
    check: () => ipcRenderer.invoke('updater:check'),
    install: () => ipcRenderer.invoke('updater:install'),
    onStatus: (callback) => subscribe('updater:status', callback)
  },
  logs: {
    list: (limit) => ipcRenderer.invoke('logs:list', limit),
    openDir: () => ipcRenderer.invoke('logs:openDir')
  },
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    getDshHome: () => ipcRenderer.invoke('app:getDshHome'),
    openExternal: (url) => ipcRenderer.invoke('app:openExternal', url)
  }
}

contextBridge.exposeInMainWorld('dshDesktop', api)