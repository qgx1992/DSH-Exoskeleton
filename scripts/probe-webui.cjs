// 勘察 DSH Web UI 的会话列表 DOM 结构与可能的激活全局对象
const { app, BrowserWindow, WebContentsView } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

// 勘察脚本：避免任何未捕获异常弹出 Electron 错误框
process.on('uncaughtException', (e) => {
  console.error('[probe] uncaught:', e && e.message)
  process.exit(1)
})
process.on('unhandledRejection', (e) => {
  console.error('[probe] unhandledRejection:', e && (e.message || e))
})

app.whenReady().then(async () => {
  // 启动 dsh web
  const entry = 'C:\\Users\\QIU\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
  const log = path.join(app.getPath('temp'), 'dsh-webui-probe.log')
  fs.rmSync(log, { force: true })
  const fd = fs.openSync(log, 'w')
  const child = spawn('node.exe', [entry, 'web', '--port', '0', '--no-open'], { stdio: ['ignore', fd, fd], windowsHide: true })
  let port = null
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      const text = fs.readFileSync(log, 'utf-8')
      const m = text.match(/dsh web: http:\/\/127\.0\.0\.1:(\d+)/)
      if (m) { port = m[1]; break }
    } catch { /* noop */ }
  }
  if (!port) { console.error('dsh web 未启动'); app.exit(1); return }

  const win = new BrowserWindow({ show: false, width: 1200, height: 800 })
  const view = new WebContentsView({})
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 1200, height: 800 })
  await view.webContents.loadURL(`http://127.0.0.1:${port}`)
  await new Promise((r) => setTimeout(r, 6000)) // 等 SPA 渲染

  const dump = await view.webContents.executeJavaScript(`(() => {
    const out = {};
    out.url = location.href;
    out.title = document.title;
    out.windowGlobals = Object.keys(window).filter(k => k.startsWith('__') || /ds|harness|session|app/i.test(k)).slice(0, 60);
    const sessSel = ['[data-session-id]','[data-session]','[data-conversation]','[class*=session]','[class*=conversation]'];
    out.sessionCount = {};
    for (const s of sessSel) out.sessionCount[s] = document.querySelectorAll(s).length;
    // 会话相关元素的样本
    const samples = [];
    for (const s of sessSel) {
      const el = document.querySelector(s);
      if (el && samples.length < 6) {
        samples.push({ sel: s, tag: el.tagName, attrs: el.outerHTML.slice(0, 300) });
      }
    }
    out.samples = samples;
    out.sidebarText = (() => {
      const sels = ['aside','nav','[class*=sidebar]','[class*=side-panel]'];
      for (const s of sels) { const el = document.querySelector(s); if (el) return el.textContent.slice(0, 300); }
      return '';
    })();
    out.bodyFirst = document.body.innerHTML.slice(0, 300);
    return out;
  })()`)

  console.log('=== Web UI 勘察结果 ===')
  console.log(JSON.stringify(dump, null, 2))

  // 验证新激活脚本的命中检测（不实际点击，避免触发会话重渲染卡死；includes 匹配避免转义问题）
  const hitScript = (title) => `(() => {
    try {
      const t = ${JSON.stringify(title)}.slice(0, 40).toLowerCase();
      const items = [...document.querySelectorAll('[class*="sessionRow"], [role="treeitem"]')];
      for (const el of items) {
        const txt = (el.textContent || '').trim();
        if (txt && txt.length < 300 && txt.toLowerCase().includes(t)) { return txt.slice(0, 60); }
      }
      return null;
    } catch { return null; }
  })()`
  const h1 = await view.webContents.executeJavaScript(hitScript('666_5.15mh'))
  console.log('命中测试1 (标题"666_5.15mh"):', h1 ? '命中 ✓ → ' + h1 : '未命中 ✗')
  const h2 = await view.webContents.executeJavaScript(hitScript('不存在的会话标题xyz'))
  console.log('命中测试2 (不存在标题):', h2 ? '误判 ✗' : '正确拒绝 ✓')
  const h3 = await view.webContents.executeJavaScript(hitScript('新会话'))
  console.log('命中测试3 ("新会话"):', h3 ? '命中 ✓' : '未命中 ✗')

  child.kill()
  app.exit(0)
})