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
    save: (apiKey) => ipcRenderer.invoke('setup:save', apiKey),
    clear: () => ipcRenderer.invoke('setup:clear')
  },
  backup: {
    list: () => ipcRenderer.invoke('backup:list'),
    create: (name) => ipcRenderer.invoke('backup:create', name),
    restore: (id, entries) => ipcRenderer.invoke('backup:restore', id, entries),
    delete: (id) => ipcRenderer.invoke('backup:delete', id)
  },
  plugins: {
    catalog: (query) => ipcRenderer.invoke('plugins:catalog', query),
    installed: () => ipcRenderer.invoke('plugins:installed'),
    install: (pkg) => ipcRenderer.invoke('plugins:install', pkg),
    uninstall: (pkg) => ipcRenderer.invoke('plugins:uninstall', pkg),
    checkUpdate: () => ipcRenderer.invoke('plugins:checkUpdate'),
    upgrade: (name, latest) => ipcRenderer.invoke('plugins:upgrade', name, latest),
    recommend: (name) => ipcRenderer.invoke('plugins:recommend', name),
    unrecommend: (name) => ipcRenderer.invoke('plugins:unrecommend', name)
  },
  kernels: {
    installed: () => ipcRenderer.invoke('kernels:installed'),
    available: () => ipcRenderer.invoke('kernels:available'),
    install: (version, registry) => ipcRenderer.invoke('kernels:install', version, registry),
    uninstall: (version) => ipcRenderer.invoke('kernels:uninstall', version),
    setDefault: (version) => ipcRenderer.invoke('kernels:setDefault', version),
    setMode: (mode) => ipcRenderer.invoke('kernels:setMode', mode),
    trial: (version) => ipcRenderer.invoke('kernels:trial', version),
    checkUpdate: () => ipcRenderer.invoke('kernels:checkUpdate'),
    quota: () => ipcRenderer.invoke('kernels:quota'),
    onProgress: (callback) => subscribe('kernels:progress', callback)
  },
  runtime: {
    status: () => ipcRenderer.invoke('runtime:status'),
    download: () => ipcRenderer.invoke('runtime:download'),
    remove: () => ipcRenderer.invoke('runtime:remove'),
    onProgress: (callback) => subscribe('runtime:progress', callback)
  },
  profiles: {
    list: () => ipcRenderer.invoke('profiles:list'),
    create: (name) => ipcRenderer.invoke('profiles:create', name),
    delete: (id) => ipcRenderer.invoke('profiles:delete', id),
    activate: (id) => ipcRenderer.invoke('profiles:activate', id),
    setKernel: (id, version) => ipcRenderer.invoke('profiles:setKernel', id, version)
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
    onMaximizeChange: (callback) => subscribe('window:maximizeChange', callback),
    setAdminPanelVisible: (visible) => ipcRenderer.invoke('window:setAdminPanelVisible', visible)
  },
  updater: {
    check: () => ipcRenderer.invoke('updater:check'),
    install: () => ipcRenderer.invoke('updater:install'),
    onStatus: (callback) => subscribe('updater:status', callback)
  },
  sessions: {
    list: (limit) => ipcRenderer.invoke('sessions:list', limit),
    open: (uuid) => ipcRenderer.invoke('sessions:open', uuid),
    remove: (uuid) => ipcRenderer.invoke('sessions:remove', uuid),
    export: (uuid) => ipcRenderer.invoke('sessions:export', uuid),
    show: (uuid) => ipcRenderer.invoke('sessions:show', uuid)
  },
  notify: {
    test: () => ipcRenderer.invoke('notify:test')
  },
  logs: {
    list: (limit) => ipcRenderer.invoke('logs:list', limit),
    openDir: () => ipcRenderer.invoke('logs:openDir')
  },
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    getDshHome: () => ipcRenderer.invoke('app:getDshHome'),
    openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
    copyText: (text) => ipcRenderer.invoke('app:copyText', text)
  }
}

contextBridge.exposeInMainWorld('dshDesktop', api)