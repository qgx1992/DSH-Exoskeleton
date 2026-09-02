// 诊断：真实会话完成后，对比 watcher 视角标题(headInfo) vs Web UI 列表实际标题
// 用于定位"点击通知跳转失败"的根因（标题不一致？时间兜底缺失？）
const { app, BrowserWindow, WebContentsView } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

process.on('uncaughtException', (e) => { console.error('[diag] uncaught:', e.message); process.exit(1) })
const nodeExe = (() => { try { const p = require('child_process').execFileSync('where', ['node'], { encoding: 'utf-8' }).trim().split(/\r?\n/)[0]; return p } catch { return 'node' } })()

app.whenReady().then(async () => {
  const log = path.join(app.getPath('temp'), 'dsh-diag.log')
  fs.rmSync(log, { force: true })
  const fd = fs.openSync(log, 'w')
  const child = spawn('node.exe', [path.resolve('C:\\Users\\QIU\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'), 'web', '--port', '0', '--no-open'], { stdio: ['ignore', fd, fd], windowsHide: true })

  let port = null
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      const m = fs.readFileSync(log, 'utf-8').match(/dsh web: http:\/\/127\.0\.0\.1:(\d+)/)
      if (m) { port = m[1]; break }
    } catch { /* noop */ }
  }
  if (!port) { console.error('❌ dsh web 未启动'); app.exit(1); return }

  const win = new BrowserWindow({ show: false, width: 1280, height: 860 })
  const view = new WebContentsView({})
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 1280, height: 860 })
  await view.webContents.loadURL(`http://127.0.0.1:${port}`)
  await new Promise((r) => setTimeout(r, 8000))

  // 1) 发起一个会触发 LLM 标题的任务
  const msg = '请用一句话介绍 DeepSeek Harness 桌面客户端项目，然后停止'
  const sent = await view.webContents.executeJavaScript(`(() => {
    const box = document.querySelector('textarea, [contenteditable="true"], [role="textbox"]');
    if (!box) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
    setter.set.call(box, ${JSON.stringify(msg)});
    box.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = [...document.querySelectorAll('button')].find(b => /send|发送|submit|run|运行/i.test((b.getAttribute('aria-label')||'') + ' ' + (b.textContent||'')));
    if (!btn) return false;
    btn.click();
    return true;
  })()`)
  console.log('已发起任务:', msg, '| 发送:', sent)

  // 2) 等待完成：轮询列表出现含该任务关键词/新标题的项
  console.log('等待会话完成…（轮询列表）')
  let listTitle = null
  let start = Date.now()
  while (Date.now() - start < 180000) {
    await new Promise((r) => setTimeout(r, 4000))
    const entries = await view.webContents.executeJavaScript(`(() => {
      const out = [];
      for (const el of [...document.querySelectorAll('[class*="sessionRow"], [role="treeitem"]')]) {
        const t = (el.textContent || '').trim();
        if (!t || t.length > 100) continue;
        if (/新会话|工作区|未分组|展开|其余/.test(t)) continue;
        if (!out.some(x => x.text === t)) out.push(t);
      }
      return out;
    })()`)
    const hit = entries.find((t) => t.includes('DeepSeek Harness 桌面客户端') || t.includes('一句话介绍'))
    if (hit) { listTitle = hit; break }
  }
  console.log('列表实际标题:', listTitle ? JSON.stringify(listTitle) : '(未找到——可能在折叠区)')
  if (!listTitle) { child.kill(); app.exit(1); return }

  await new Promise((r) => setTimeout(r, 3000))

  // 3) 用 watcher 视角（headInfo）读取"通知会用到的标题 / cwd / 首条用户消息"
  const worker = require('child_process').spawn(nodeExe, [path.resolve('scripts/zstd-worker.cjs')], { stdio: ['pipe', 'pipe', 'inherit'] })
  await new Promise((r) => setTimeout(r, 300))
  const sessFiles = require('child_process').execFileSync('powershell', ['-NoProfile', '-Command', `Get-ChildItem "$env:USERPROFILE\\.dsh\\sessions" -Recurse -Filter session.jsonl.zstd | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName`], { encoding: 'utf-8' }).trim()
  console.log('最新会话文件:', sessFiles)
  let headInfo = null
  let buf = ''
  worker.stdout.on('data', (c) => {
    buf += c.toString()
    const i = buf.lastIndexOf('\n')
    if (i >= 0) {
      const line = buf.slice(0, i).trim()
      if (line) {
        try { headInfo = JSON.parse(line) } catch { /* noop */ }
      }
    }
  })
  worker.stdin.write(JSON.stringify({ cmd: 'headInfo', file: sessFiles, id: 1 }) + '\n')
  await new Promise((r) => setTimeout(r, 1200))
  console.log('watcher 视角（通知将用）: title=', JSON.stringify(headInfo?.title), 'cwd=', headInfo?.cwd)

  // 4) 对比 + 多候补命中测试
  const notifyTitle = headInfo?.title || ''
  const userText = notifyTitle // headInfo 的 title 已是用户消息 fallback 或 session/title
  const candidates = [notifyTitle.slice(0, 40), msg.slice(0, 40)].filter(Boolean)
  console.log('匹配候补:', JSON.stringify(candidates))
  const hitCount = await view.webContents.executeJavaScript(`(() => {
    const candidates = ${JSON.stringify(candidates)};
    const items = [...document.querySelectorAll('[class*="sessionRow"], [role="treeitem"]')];
    const hits = [];
    for (const el of items) {
      const txt = (el.textContent || '').trim();
      if (!txt || txt.length > 300) continue;
      const lower = txt.toLowerCase();
      if (candidates.some(c => lower.includes(c.toLowerCase()))) hits.push(txt.slice(0, 60));
    }
    return hits;
  })()`)
  console.log('候补命中项:', JSON.stringify(hitCount))

  child.kill()
  worker.kill()
  app.exit(0)
})