// 验证：从 DOM 元素 React fiber 读取 node.id 并精确匹配（模拟结构）
const { app, BrowserWindow } = require('electron')
const path = require('path')

app.whenReady().then(async () => {
  let failed = 0
  const assert = (cond, label) => { console.log((cond ? '  ✓ ' : '  ✗ ') + label); if (!cond) failed++ }

  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } })
  // 模拟 DSH 会话列表 DOM：sessionRow div，带假 __reactFiber$ 属性（div 的 fiber 无 node，return 一层是组件 fiber 带 node）
  const html = `<!DOCTYPE html><html><body>
    <div id="g1" role="button">展开 3 个会话</div>
    <div id="s1" class="YDXeBa_sessionRow" role="treeitem">项目A · 第一个会话<time>3小时前</time></div>
    <div id="s2" class="YDXeBa_sessionRow" role="treeitem">项目A · 第二个会话<time>刚刚</time></div>
    <div id="s3" class="YDXeBa_sessionRow" role="treeitem">项目A · 第一个会话<time>昨天</time></div>
    <script>
      // 模拟 React 19 fiber 挂载属性：div 宿主 fiber → return → SessionNodeItem 组件 fiber（memoizedProps.node.id）
      const attach = (id, el) => {
        const hostFiber = { memoizedProps: { onClick: () => {}, role: 'treeitem' }, return: null };
        const compFiber = { memoizedProps: { node: { id }, title: 'x' }, return: null };
        hostFiber.return = compFiber;
        el['__reactFiber$' + Math.random().toString(36).slice(2)] = hostFiber;
      };
      attach('11111111-0000-4000-8000-000000000001', document.getElementById('s1'));
      attach('22222222-0000-4000-8000-000000000002', document.getElementById('s2'));
      attach('33333333-0000-4000-8000-000000000003', document.getElementById('s3'));
    </script>
  </body></html>`
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))

  // 注入脚本（与 window-manager.ts 中 activateSessionInWebUi 相同的 readId + ID 匹配逻辑）
  const run = async (targetId) => {
    return win.webContents.executeJavaScript(`(() => {
      const readId = (el) => {
        const k = Object.keys(el).find(x => x.startsWith('__reactFiber'));
        if (!k) return null;
        let f = el[k];
        for (let i = 0; i < 8 && f; i++) {
          const p = f.memoizedProps;
          if (p && p.node && typeof p.node.id === 'string' && p.node.id) return p.node.id;
          f = f.return;
        }
        return null;
      };
      const items = [...document.querySelectorAll('[class*="sessionRow"], [role="treeitem"]')];
      const targetId = ${JSON.stringify(targetId)};
      if (targetId) {
        for (const el of items) {
          if (readId(el) === targetId) { el.click(); return { hit: el.id, id: readId(el) }; }
        }
      }
      return { hit: null };
    })()`)
  }

  // 用例 1：按 ID 精确命中（三个行里有同标题，验证不误点）
  let r = await run('22222222-0000-4000-8000-000000000002')
  assert(r.hit === 's2', 'ID 精确命中 s2（同标题场景不误点 s1/s3）')
  assert(r.id === '22222222-0000-4000-8000-000000000002', 'readId 返回正确 uuid')

  // 用例 2：ID 不存在 → 返回 hit:null（交给标题/时间兜底）
  r = await run('99999999-0000-4000-8000-000000000099')
  assert(r.hit === null, 'ID 未命中时返回 null（走标题/时间兜底）')

  // 用例 3：readId 对无 fiber 的元素返回 null 不崩溃
  r = await win.webContents.executeJavaScript(`(() => {
    const readId = (el) => {
      const k = Object.keys(el).find(x => x.startsWith('__reactFiber'));
      if (!k) return null;
      let f = el[k];
      for (let i = 0; i < 8 && f; i++) {
        const p = f.memoizedProps;
        if (p && p.node && typeof p.node.id === 'string' && p.node.id) return p.node.id;
        f = f.return;
      }
      return null;
    };
    const plain = document.getElementById('g1');
    return readId(plain);
  })()`)
  assert(r === null, '无 fiber 的元素 readId 返回 null（静默降级）')

  win.destroy()
  console.log(failed === 0 ? '\n结果: 全部通过' : '\n结果: ' + failed + ' 项失败')
  app.exit(failed === 0 ? 0 : 1)
})
