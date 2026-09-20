/**
 * UI 探针专用 preload 桩：把 window.dshDesktop 逐命名空间补全。
 * 刻意从源码清单（window.dshDesktop.*.*，见 scripts/probe/probe-update-ui.cjs 注释）
 * 一次性补齐而不是遇到一个补一个——缺方法会让页面抛 TypeError，
 * 而「页面无 JS 错误」的断言（带自检）会把它抓出来，反复补桩很浪费轮次。
 */
const { contextBridge } = require('electron')

const calls = []
const cfg = { autoCheckUpdate: true, autoDownloadUpdate: true }

const noop = () => () => {}
const record = (label, ret) => async (...args) => {
  calls.push([label, ...args])
  return typeof ret === 'function' ? ret(...args) : ret
}

let info = {
  current: '0.9.5',
  latest: '0.9.9',
  available: true,
  url: 'https://example.invalid/rel',
  checkedAt: Date.now(),
  error: null,
  progress: null,
  downloaded: false,
  installing: false,
  autoUpdateSupported: true
}

contextBridge.exposeInMainWorld('dshDesktop', {
  app: {
    openExternal: record('app.openExternal', null),
    getVersion: record('app.getVersion', '0.9.5'),
    getDshHome: record('app.getDshHome', ''),
    copyText: record('app.copyText', null)
  },
  config: {
    get: record('config.get', () => ({ ...cfg })),
    set: async (patch) => {
      calls.push(['config.set', patch])
      Object.assign(cfg, patch)
      return { ...cfg }
    }
  },
  updater: {
    check: record('updater.check', () => info),
    download: record('updater.download', { ok: true }),
    install: record('updater.install', null),
    onStatus: noop
  },
  setup: {
    check: record('setup.check', { configured: true, file: '', refs: [], malformed: false }),
    save: record('setup.save', { ok: true }),
    clear: record('setup.clear', { ok: true })
  },
  dsh: {
    getState: record('dsh.getState', {
      status: 'stopped',
      port: 0,
      version: null,
      pid: null,
      restartCount: 0,
      lastError: null
    }),
    getPort: record('dsh.getPort', 0),
    start: record('dsh.start', null),
    stop: record('dsh.stop', null),
    restart: record('dsh.restart', null),
    onStateChange: noop
  },
  window: {
    onOpenPanel: noop,
    setAdminPanelVisible: record('window.setAdminPanelVisible', null)
  },
  tray: { show: record('tray.show', null), hide: record('tray.hide', null) },
  sessions: {
    list: record('sessions.list', []),
    count: record('sessions.count', 0),
    open: record('sessions.open', null),
    remove: record('sessions.remove', null),
    export: record('sessions.export', null),
    show: record('sessions.show', null)
  },
  logs: {
    list: record('logs.list', []),
    openDir: record('logs.openDir', null),
    clear: record('logs.clear', null)
  },
  kernels: {
    installed: record('kernels.installed', []),
    available: record('kernels.available', []),
    // 字段必须齐全：OverviewTab 会直接 quota.diskFreeMB.toFixed(0)，
    // 缺字段会让整个 React 树崩掉（实测：页面直接白屏、后续断言全挂）
    quota: record('kernels.quota', { quotaMB: 1024, usedMB: 0, runtimeMB: 0, diskFreeMB: 50000, pendingRemovalMB: 0 }),
    checkUpdate: record('kernels.checkUpdate', {
      current: null,
      latest: null,
      latestTag: null,
      rc: null,
      available: false,
      url: null,
      checkedAt: null,
      error: null
    }),
    install: record('kernels.install', null),
    uninstall: record('kernels.uninstall', null),
    setDefault: record('kernels.setDefault', null),
    setMode: record('kernels.setMode', null),
    trial: record('kernels.trial', null),
    onProgress: noop
  },
  runtime: {
    status: record('runtime.status', { installed: false, version: null, path: null, systemNode: null, busy: 'idle' }),
    download: record('runtime.download', null),
    remove: record('runtime.remove', null),
    onProgress: noop
  },
  profiles: {
    list: record('profiles.list', []),
    create: record('profiles.create', null),
    delete: record('profiles.delete', null),
    activate: record('profiles.activate', null),
    setKernel: record('profiles.setKernel', null)
  },
  plugins: {
    installed: record('plugins.installed', []),
    catalog: record('plugins.catalog', []),
    checkUpdate: record('plugins.checkUpdate', {}),
    install: record('plugins.install', null),
    uninstall: record('plugins.uninstall', null),
    upgrade: record('plugins.upgrade', null),
    recommend: record('plugins.recommend', null),
    unrecommend: record('plugins.unrecommend', null)
  },
  backup: {
    list: record('backup.list', []),
    create: record('backup.create', null),
    restore: record('backup.restore', null),
    delete: record('backup.delete', null)
  },
  notify: { test: record('notify.test', null) },
  // 探针内部使用的钩子（非产品 API）
  __calls: () => calls,
  __setInfo: (v) => {
    info = v
  }
})
