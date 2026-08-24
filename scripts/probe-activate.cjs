// 端到端验证（真实会话）：在 Web UI 发起任务 → 等会话完成且带标题 → 用标题激活 → 验证跳转
const { app, BrowserWindow, WebContentsView } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

process.on('uncaughtException', (e) => { console.error('[e2e] uncaught:', e.message); process.exit(1) })

app.whenReady().then(async () => {
  const log = path.join(app.getPath('temp'), 'dsh-e2e-real.log')
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

  // 1) 勘察输入控件与发送按钮
  const inputs = await view.webContents.executeJavaScript(`(() => {
    const textareas = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')];
    const btns = [...document.querySelectorAll('button')].map(b => ({ text: (b.textContent||'').trim().slice(0,20), aria: b.getAttribute('aria-label')||'', cls: b.className.slice(0,40) }));
    return { textareas: textareas.map(t => ({ tag: t.tagName, ph: t.getAttribute('placeholder')||'', cls: t.className.slice(0,40) })), sendCandidates: btns.filter(b => /send|发送|submit|上|run|运行/i.test(b.text + ' ' + b.aria)).slice(0, 10) };
  })()`)
  console.log('输入控件:', JSON.stringify(inputs.textareas))
  console.log('发送候选:', JSON.stringify(inputs.sendCandidates, null, 0))

  // 2) 注入任务并发送（找 textarea/contenteditable 输入，点发送候选按钮）
  const message = '只回复四个字：收到完成'
  const sent = await view.webContents.executeJavaScript(`(() => {
    const box = document.querySelector('textarea, [contenteditable="true"], [role="textbox"]');
    if (!box) return { ok: false, reason: 'no input' };
    const setVal = (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value') ||
                     Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (setter && setter.set) setter.set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setVal(box, ${JSON.stringify(message)});
    const btn = [...document.querySelectorAll('button')].find(b => /send|发送|submit|run|运行/i.test((b.getAttribute('aria-label')||'') + ' ' + (b.textContent||'')));
    if (!btn) return { ok: false, reason: 'no send btn' };
    btn.click();
    return { ok: true };
  })()`)
  console.log('发送任务:', JSON.stringify(sent), '→', message)

  if (!sent.ok) {
    console.error('❌ 无法通过 UI 发送任务，无法进行真实端到端')
    child.kill(); app.exit(1); return
  }

  // 3) 等待会话出现在列表且带标题（轮询 150s）
  console.log('等待真实会话完成并出现在列表（最多 150s）…')
  let targetTitle = null
  let before = Date.now()
  while (Date.now() - before < 150000) {
    await new Promise((r) => setTimeout(r, 4000))
    const entries = await view.webContents.executeJavaScript(`(() => {
      const out = [];
      for (const el of [...document.querySelectorAll('[class*="sessionRow"], [role="treeitem"]')]) {
        const t = (el.textContent || '').trim();
        if (!t || t.length > 100) continue;
        if (/新会话|工作区|未分组|展开|其余/.test(t)) continue;
        if (!out.some(x => x.text === t)) out.push({ text: t, sel: el.getAttribute('aria-selected') === 'true' });
      }
      return out;
    })()`)
    // 找一个包含我们消息关键词的标题（自动标题会取消息前段）
    const hit = entries.find((e) => e.text.includes('收到完成') || e.text.includes('只回复'))
    if (hit) { targetTitle = hit.text; break }
    if (entries.length > 0) console.log('   当前条目:', entries.map((e) => e.text).join(' | ').slice(0, 200))
  }
  console.log(targetTitle ? '✓ 真实会话出现在列表，标题: ' + JSON.stringify(targetTitle) : '✗ 150s 内未见带标题会话')

  // 4) 用真实标题执行激活（与产品同一逻辑）→ 验证选中态
  let switched = false
  if (targetTitle) {
    const targets = [targetTitle.slice(0, 40)]
    const activate = `(() => {
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
        if (hit) { hit.click(); return 1; }
        return 0;
      } catch { return -1; }
    })()`
    const clicked = await view.webContents.executeJavaScript(activate)
    console.log('① 匹配并点击:', clicked === 1 ? '✓' : '✗')
    await new Promise((r) => setTimeout(r, 1600))
    const sels = await view.webContents.executeJavaScript(`(() => [...document.querySelectorAll('[class*="sessionRow"][aria-selected="true"], [class*="sessionRow"][class*="selected"]')].map(s => (s.textContent||'').trim().slice(0,60)))()`)
    console.log('② 点击后选中项:', JSON.stringify(sels))
    switched = clicked === 1 && Array.isArray(sels) && sels.some((t) => t && t.includes(targetTitle.slice(0, 20)))
    console.log(switched ? '✅ 端到端通过：点击通知对应的真实会话 → 成功跳转' : '❌ 未成功跳转')
  }

  child.kill()
  app.exit(switched ? 0 : 1)
})