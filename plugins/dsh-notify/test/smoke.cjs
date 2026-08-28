/**
 * dsh-notify 冒烟测试（Node，无浏览器依赖）
 *
 * 用最小 DOM shim + 假 ctx 真实加载 lib/client.js 并执行 apply()，验证：
 *   1. __ModuleLoader__ bundle 加载成功，导出 apply / inject 形状正确；
 *   2. 无壳降级：订阅 sessions list，completed 0→1 边缘会弹出一条 toast；
 *   3. 壳桥模式：存在 window.__dshExo 时握手 + onEvent 订阅 + 事件渲染 toast；
 *   4. 卸载（dispose）后覆盖层被整体拆除。
 *
 * 运行：node test/smoke.cjs
 */

const path = require('node:path')

/* ── 最小 DOM shim（仅覆盖 client.js 用到的 API）──────────────────── */
function makeEl(tag) {
  return {
    tagName: tag,
    style: {},
    dataset: {},
    id: '',
    textContent: '',
    isConnected: false,
    parentNode: null,
    _attrs: {},
    _children: [],
    _listeners: {},
    setAttribute(k, v) { this._attrs[k] = String(v) },
    removeAttribute(k) { delete this._attrs[k] },
    getAttribute(k) { return this._attrs[k] },
    appendChild(c) { c.isConnected = true; c.parentNode = this; this._children.push(c); return c },
    replaceChildren(...cs) { this._children = []; for (const c of cs) { c.isConnected = true; c.parentNode = this; this._children.push(c) } },
    remove() { if (this.parentNode) this.parentNode._children = this.parentNode._children.filter((c) => c !== this); this.isConnected = false },
    addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn) },
    removeEventListener(type, fn) { this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn) },
    closest() { return null },
    querySelector() { return null }
  }
}

const document = { createElement: (t) => makeEl(t), head: makeEl('head'), body: makeEl('body'), documentElement: makeEl('html') }
const windowObj = { __ModuleLoader__: null, __dshExo: undefined }

global.window = windowObj
global.document = document

/* ── 加载 bundle，捕获 factory 产物 ────────────────────────────────── */
let exportsOf = null
windowObj.__ModuleLoader__ = {
  load(spec) {
    if (spec.id !== 'dsh-notify') throw new Error('unexpected bundle id: ' + spec.id)
    const mod = spec.factory(() => { throw new Error('no deps expected; got require()') })
    exportsOf = mod
  }
}

const bundle = path.join(__dirname, '..', 'lib', 'client.js')
require(bundle)

let failed = 0
function assert(name, cond, detail) {
  if (cond) console.log('  ✓', name)
  else { failed += 1; console.log('  ✗', name, detail ? '— ' + detail : '') }
}
function toastNodes() {
  // document.body 下应有 #dsh-notify-root > [data-dsh-notify-stack] > toasts
  const root = document.body._children.find((c) => c.id === 'dsh-notify-root')
  const stack = root && root._children.find((c) => c.getAttribute('data-dsh-notify-stack') !== undefined)
  return stack ? stack._children : []
}

/* 1) 导出形状 */
console.log('1) bundle 加载 / 导出形状')
assert('bundle id=dsh-notify 已加载', exportsOf !== null)
assert('exports.apply 是函数', typeof exportsOf.apply === 'function')
assert('exports.inject 包含 sessions 与 locale', Array.isArray(exportsOf.inject) && ['sessions', 'locale'].every((s) => exportsOf.inject.includes(s)))

/* 2) 无壳降级：completed 边缘 → toast */
console.log('2) 无壳降级（sessions store）')
{
  function makeCtx(store) {
    const localeState = {}
    const ctx = {
      sessions: store,
      locale: {
        register(NS, dicts) { localeState[NS] = dicts; return () => { delete localeState[NS] } },
        bind() { return (key, params) => {
          const d = (localeState['dsh-notify'] || {}).zh || {}
          let s = d[key] || key
          if (params) for (const [k, v] of Object.entries(params)) s = String(s).replace(new RegExp('\\{' + k + '\\}'), String(v))
          return s
        } }
      }
    }
    ctx.effect = (fn) => { const r = fn(); return typeof r === 'function' ? r : () => {} }
    return ctx
  }

  // 假 sessions 服务：形状对齐真实 ISessions —— 快照 store 在 ctx.sessions.list
  // （{ getSnapshot, subscribe }），open() 是契约面动作
  let snap = { ids: ['session-aaa'], byId: { 'session-aaa': { displayTitle: '帮我debug', cwd: 'D:/proj/foo', completed: false, blank: false } }, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined }
  const listeners = new Set()
  const sessionsService = {
    opened: [],
    list: {
      getSnapshot() { return snap },
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }
    },
    open(id) { this.opened.push(id); snap = { ...snap, current: id }; listeners.forEach((fn) => fn()) }
  }
  const ctx = makeCtx(sessionsService)
  const disposers = []
  const origEffect = ctx.effect
  ctx.effect = (fn, desc) => { const r = origEffect(fn, desc); if (typeof r === 'function') disposers.push(r); return () => {} }

  exportsOf.apply(ctx)

  assert('无壳：基线不产生 toast（completed=false）', toastNodes().length === 0, `got ${toastNodes().length}`)

  // 模拟一轮完成：completed false→true
  snap = { ...snap, byId: { 'session-aaa': { displayTitle: '帮我debug', cwd: 'D:/proj/foo', completed: true, blank: false } } }
  listeners.forEach((fn) => fn())

  const toasts = toastNodes()
  assert('无壳：completed 0→1 弹出一条 toast', toasts.length === 1, `got ${toasts.length}`)
  if (toasts.length === 1) {
    const tEl = toasts[0]
    const title = tEl._children.find((c) => c.getAttribute('data-dsh-notify-title') !== undefined)
    assert('无壳：toast 标题为「对话完成」', title && title.textContent === '对话完成', title && title.textContent)
    const body = tEl._children.find((c) => c.getAttribute('data-dsh-notify-body') !== undefined)
    assert('无壳：toast 正文含项目名与标题', body && /项目「foo」· 帮我debug/.test(body.textContent), body && body.textContent)
    assert('无壳：toast 可点击（data-dsh-notify-clickable）', tEl.getAttribute('data-dsh-notify-clickable') !== undefined)
  }

  // 点无壳 toast：应程序化激活（open 记录开会话 id）
  const found = toastNodes()[0]
  const click = found && found._listeners.click && found._listeners.click[0]
  assert('无壳：toast 挂载了 click 监听', typeof click === 'function')
  if (click) click({ target: found })
  assert('无壳：点击后 store.open 被调用于目标会话', sessionsService.opened.some((id) => id === 'session-aaa'), JSON.stringify(sessionsService.opened))

  // 同会话连发（completed 再 0→1）应原位刷新而非堆积
  snap = { ...snap, byId: { 'session-aaa': { displayTitle: '帮我debug', cwd: 'D:/proj/foo', completed: false, blank: false } } }
  listeners.forEach((fn) => fn())
  snap = { ...snap, byId: { 'session-aaa': { displayTitle: '帮我debug', cwd: 'D:/proj/foo', completed: true, blank: false } } }
  listeners.forEach((fn) => fn())
  assert('无壳：同会话连发不堆积（原位刷新）', toastNodes().length === 1, `got ${toastNodes().length}`)

  // 卸载：整体拆除
  disposers.forEach((d) => d())
  assert('无壳：dispose 后覆盖层拆除', document.body._children.filter((c) => c.id === 'dsh-notify-root').length === 0)
}

/* 3) 壳桥模式：__dshExo 存在 → 握手 + 订阅 + 渲染 */
console.log('3) 壳桥模式（window.__dshExo）')
{
  // 重置 DOM（上次 dispose 已清；保险起见再清一次）
  document.body._children = []

  let readyCalls = 0
  const sent = []
  const handlers = new Set()
  windowObj.__dshExo = {
    ready() { readyCalls += 1 },
    appInfo() { return { version: '0.0.0-test' } },
    send(channel, payload) { sent.push({ channel, payload }) },
    onEvent(fn) { handlers.add(fn); return () => handlers.delete(fn) }
  }

  const sessionsService = {
    opened: [],
    list: {
      getSnapshot: () => ({ ids: ['session-abc'], byId: { 'session-abc': { displayTitle: '帮我debug' } }, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined }),
      subscribe: () => () => {}
    },
    open(id) { this.opened.push(id) }
  }
  const localeState = {}
  const ctx = {
    sessions: sessionsService,
    locale: { register(NS, d) { localeState[NS] = d; return () => {} }, bind() { return (k, p) => { const s = (localeState['dsh-notify'].zh || {})[k] || k; return p ? s.replace('{project}', p.project).replace('{title}', p.title) : s } } },
    effect(fn) { const r = fn(); return typeof r === 'function' ? r : () => {} }
  }

  exportsOf.apply(ctx)

  assert('壳桥：ready() 握手被调用', readyCalls === 1, `calls=${readyCalls}`)
  assert('壳桥：onEvent 已订阅', handlers.size === 1)

  // 喂一条服务异常事件
  const ev = { id: 'ev-1', kind: 'service-error', title: 'DSH 服务异常', body: '连接被拒绝', ts: Date.now() }
  handlers.forEach((fn) => fn(ev))
  let t = toastNodes()
  assert('壳桥：事件渲染出 toast', t.length === 1, `got ${t.length}`)
  if (t[0]) {
    const title = t[0]._children.find((c) => c.getAttribute('data-dsh-notify-title') !== undefined)
    assert('壳桥：toast 标题来自事件', title && title.textContent === 'DSH 服务异常', title && title.textContent)
    assert('壳桥：error 级样式标记', t[0].getAttribute('data-dsh-notify-kind') === 'error', t[0].getAttribute('data-dsh-notify-kind'))
  }
  const seen = sent.find((s) => s.channel === 'notify:seen')
  assert('壳桥：已渲染即发 notify:seen 回执', !!seen && seen.payload.id === 'ev-1')

  // 点击：应发 notify:click 且含归一化 sessionId；这里事件无 session，故 sessionId 为 undefined
  const clickHandler = t[0] && t[0]._listeners.click && t[0]._listeners.click[0]
  if (clickHandler) clickHandler({ target: t[0] })
  const click = sent.find((s) => s.channel === 'notify:click')
  assert('壳桥：点击发 notify:click（含事件 id）', !!click && click.payload.id === 'ev-1', JSON.stringify(sent))

  // 会话事件：sessionId 归一化（uuid 无前缀 → session- 前缀）
  windowObj.__dshExo.send = function (channel, payload) { sent.push({ channel, payload }) }
  const ev2 = { id: 'ev-2', kind: 'session-done', title: 'DSH 对话完成', body: '项目「foo」· 帮我debug', ts: Date.now(), session: { uuid: 'abc' } }
  const before = sent.length
  handlers.forEach((fn) => fn(ev2))
  t = toastNodes()
  // ev1 与 ev2 的 toast 同时在屏：按正文精确命中 ev2 的 toast 再点击
  let ev2Toast = t.find((n) => n._children.some((c) => c.getAttribute('data-dsh-notify-body') !== undefined && /帮我debug/.test(c.textContent || '')))
  assert('壳桥：session-done toast 已渲染', !!ev2Toast)
  if (ev2Toast) ev2Toast._listeners.click[0]({ target: ev2Toast })
  const click2 = sent.slice(before).find((s) => s.channel === 'notify:click')
  assert('壳桥：session-done 点击回传归一化 session-id', !!click2 && click2.payload.sessionId === 'session-abc', click2 && JSON.stringify(click2.payload))
  assert('壳桥：程序化激活 open() 被调用（session-abc）', sessionsService.opened.includes('session-abc'), JSON.stringify(sessionsService.opened))

  // 更新就绪事件（P2）：点击应发 notify:install（触发壳侧安装），不应误发 notify:click
  const ev3 = { id: 'ev-3', kind: 'update-ready', title: 'DSH-Exoskeleton 更新已就绪', body: '新版本 v9.9.9 已下载', ts: Date.now(), update: { version: '9.9.9' } }
  const before3 = sent.length
  handlers.forEach((fn) => fn(ev3))
  t = toastNodes()
  let ev3Toast = t.find((n) => n._children.some((c) => c.getAttribute('data-dsh-notify-body') !== undefined && /v9\.9\.9/.test(c.textContent || '')))
  assert('壳桥：update-ready toast 已渲染', !!ev3Toast)
  assert('壳桥：update-ready meta 为「点击重启安装」', !!ev3Toast && ev3Toast._children.some((c) => c.getAttribute('data-dsh-notify-meta') !== undefined && /点击重启安装/.test(c.textContent || '')), ev3Toast && JSON.stringify(ev3Toast._children.map((c) => c.textContent)))
  if (ev3Toast) ev3Toast._listeners.click[0]({ target: ev3Toast })
  const installMsg = sent.slice(before3).find((s) => s.channel === 'notify:install')
  const clickAfter3 = sent.slice(before3).find((s) => s.channel === 'notify:click')
  assert('壳桥：update-ready 点击发 notify:install', !!installMsg && installMsg.payload.id === 'ev-3', JSON.stringify(sent.slice(before3)))
  assert('壳桥：update-ready 不误发 notify:click', !clickAfter3, JSON.stringify(sent.slice(before3)))

  // 事件 id 去重（同一 id 重复下发只渲染一次）
  const beforeCount = toastNodes().length
  handlers.forEach((fn) => fn(ev2))
  assert('壳桥：同事件 id 去重', toastNodes().length === beforeCount, `before=${beforeCount} after=${toastNodes().length}`)

  // 桥通道与 sessions 降级互斥：有桥时不应走降级
  // （桥模式下无任何 fallback toast 用 fb: 前缀；此处 session store 为空，天然无降级 toast）
  windowObj.__dshExo = undefined
}

console.log(failed === 0 ? '\n全部通过 ✔' : `\n${failed} 项失败 ✘`)
process.exit(failed === 0 ? 0 : 1)
