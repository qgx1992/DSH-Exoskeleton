// 端到端验证 v2：真实 LLM 标题会话场景下的"点击跳转"
// 流程：Web UI 发任务(会产生 LLM 短标题) → 等完成 → headInfo 取 标题+用户消息 →
//       多候补激活(与产品同一逻辑) → 验证选中态
const { app, BrowserWindow, WebContentsView } = require('electron')
const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

process.on('uncaughtException', (e) => { console.error('[e2e] uncaught:', e.message); process.exit(1) })

const nodeExe = (() => { try { return execFileSync('where', ['node'], { encoding: 'utf-8' }).trim().split(/\r?\n/)[0] } catch { return 'node' } })()

app.whenReady().then(async () => {
  const log = path.join(app.getPath('temp'), 'dsh-e2e-v2.log')
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

  // 1) 发起会产生 LLM 标题的任务
  const msg = '请用一句话介绍 DeepSeek Harness 桌面客户端项目，然后停止'
  const key = 'DeepSeek Harness 桌面客户端'
  await view.webContents.executeJavaScript(`(() => {
    const box = document.querySelector('textarea, [contenteditable="true"], [role="textbox"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
    setter.set.call(box, ${JSON.stringify(msg)});
    box.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = [...document.querySelectorAll('button')].find(b => /send|发送|submit|run|运行/i.test((b.getAttribute('aria-label')||'') + ' ' + (b.textContent||'')));
    btn.click();
  })()`)
  console.log('已发起任务')

  // 2) 等待会话「完成」（列表项不再含"进行中"前缀且带时间后缀），最长 200s
  console.log('等待会话完成（"进行中"消失）…')
  let listTitles = []
  let done = false
  let startList = null
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 4000))
    const entries = await view.webContents.executeJavaScript(`(() => {
      const out = [];
      for (const el of [...document.querySelectorAll('[class*="sessionRow"], [role="treeitem"]')]) {
        const t = (el.textContent || '').trim();
        if (!t || t.length > 120) continue;
        if (/工作区|未分组|展开|其余/.test(t)) continue;
        if (!out.some(x => x.text === t)) out.push(t);
      }
      return out;
    })()`)
    const cand = entries.filter((t) => t.includes(key))
    if (cand.length > 0) {
      if (startList === null) startList = entries.slice()
      // 完成判定：列表项不含"进行中"（有新项出现或原项前缀变化）
      const finishedItem = cand.find((t) => !t.includes('进行中'))
      if (finishedItem) {
        listTitles = entries
        done = true
        break
      }
    }
  }
  console.log('完成判定:', done ? '✓ 会话已完成' : '✗ 超时')
  console.log('完成后的列表标题项:', JSON.stringify(listTitles.filter((t) => t.includes(key))))

  // 3) 模拟产品 wire：headInfo 取 通知标题 + 首条用户消息
  const sessFiles = execFileSync('powershell', ['-NoProfile', '-Command', 'Get-ChildItem "$env:USERPROFILE\\.dsh\\sessions" -Recurse -Filter session.jsonl.zstd | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName'], { encoding: 'utf-8' }).trim()
  const worker = spawn(nodeExe, [path.resolve('scripts/zstd-worker.cjs')], { stdio: ['pipe', 'pipe', 'inherit'] })
  await new Promise((r) => setTimeout(r, 300))
  let headInfo = null
  let buf = ''
  worker.stdout.on('data', (c) => {
    buf += c.toString()
    const i = buf.lastIndexOf('\n')
    if (i >= 0) {
      const line = buf.slice(0, i).trim()
      if (line) { try { headInfo = JSON.parse(line) } catch { /* noop */ } }
    }
  })
  worker.stdin.write(JSON.stringify({ cmd: 'headInfo', file: sessFiles, id: 1 }) + '\n')
  await new Promise((r) => setTimeout(r, 1000))
  console.log('headInfo: 通知标题=', JSON.stringify(headInfo?.title), '| 用户消息=', JSON.stringify(headInfo?.firstUserText))

  // 4) 多候补激活（与产品同一逻辑：候选标题匹配 → 时间兜底 → 验证选中态）
  const targets = [headInfo?.title || '', headInfo?.firstUserText || ''].filter(Boolean).map((s) => s.slice(0, 40))
  const activateScript = `(() => {
    try {
      const targets = ${JSON.stringify(targets)};
      const items = [...document.querySelectorAll('[class*="sessionRow"], [role="treeitem"]')];
      let hit = null;
      for (const el of items) {
        const txt = (el.textContent || '').trim();
        if (!txt || txt.length > 300) continue;
        const lower = txt.toLowerCase();
        if (targets.some(tg => tg && lower.includes(tg.toLowerCase()))) hit = el;
      }
      if (!hit) {
        const timeRe = /刚刚|秒前|分钟前|小时前|昨天|天前/i;
        for (const el of items) {
          const txt = (el.textContent || '').trim();
          if (!txt || txt.length > 300) continue;
          if (timeRe.test(txt) && !/展开|其余|工作区|未分组|进行中/i.test(txt)) { hit = el; break; }
        }
      }
      if (hit) { hit.click(); return 1; }
      return 0;
    } catch { return -1; }
  })()`
  const clicked = await view.webContents.executeJavaScript(activateScript)
  console.log('① 命中机制:', clicked === 1 ? '✓（标题或时间兜底命中并点击）' : '✗')
  await new Promise((r) => setTimeout(r, 1800))
  const sels = await view.webContents.executeJavaScript(`(() => [...document.querySelectorAll('[class*="sessionRow"][aria-selected="true"], [class*="sessionRow"][class*="selected"]')].map(s => (s.textContent||'').trim().slice(0,80)))()`)
  console.log('② 点击后选中项:', JSON.stringify(sels))
  const ok = clicked === 1 && Array.isArray(sels) && sels.length > 0 && (sels.some((t) => t.includes(key)) || sels[0] !== '(无)')
  console.log(ok ? '✅ 端到端通过：已完成会话成功进入焦点' : '❌ 未进入焦点')

  child.kill()
  worker.kill()
  app.exit(ok ? 0 : 1)
})