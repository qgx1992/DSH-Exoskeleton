/**
 * 侧边栏底部工具栏契约测试（纯 DOM 仿真，不依赖 DSH 内核，可进 CI）。
 *
 * 覆盖 src/main/web-sidebar-entry.ts 的产品契约：
 *   1. 样式与脚本注入后，底部区重排成一行 4 个 32×32 小按钮：
 *      设置（官方）/ 网页版 DeepSeek / 管理面板 / 折叠切换
 *   2. 官方「设置」按钮节点原样保留（aria-haspopup=dialog 不变）→ 点击仍走官方链路
 *   3. 「网页版 DeepSeek」→ __dshExo.send('webpanel:toggle')
 *   4. 「管理面板」→ __dshExo.send('panel:open')
 *   5. 「折叠切换」→ 转发 click 给 dsh-ui-tools 官方按钮（按 aria-expanded 现状选目标）
 *   6. dsh-ui-tools 的整行工具条（.wc-collapse-bar）被收起，底部区不再占两行
 *   7. 窄条（sidebarCol 56px）→ 只显示「设置」，其余隐藏；无横向溢出
 *   8. 自愈：删掉壳按钮后重新同步能补回
 *
 * 仿真 DOM 带真实的哈希类名（footArea=hHd-Xa_footArea 等）与官方底部区样式，
 * 保证校验的是「CSS 是否真的把官方布局改对了」，而不是只在空白页里成立。
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const os = require('node:os')

const ROOT = path.resolve(__dirname, '..', '..')
// 独立 userData：避免与正在运行的应用（单实例锁 / Chromium profile 锁）互等导致卡死
const tmpRoot = path.join(os.tmpdir(), 'dsh-sidebar-footer-test-' + Date.now())
app.setPath('userData', path.join(tmpRoot, 'userdata'))

/** 用 esbuild 现场编译 TS 模块（electron 下 process.execPath 是 electron.exe，不能当 node 用） */
function loadModule () {
  const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'))
  const out = path.join(os.tmpdir(), `sidebar-footer-test-${Date.now()}.cjs`)
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'src', 'main', 'web-sidebar-entry.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error'
  })
  return require(out)
}

/** 仿 DSH 底部区 DOM（类名/插槽标记/官方样式按实测结果复刻） */
const PAGE = `<!DOCTYPE html><html><head><style>
  /* 官方侧边栏底部区（实测：footArea 竖排两行，footerActions 允许换行，设置行 42px 整行） */
  .pI_x6G_sidebarCol{width:280px;display:flex;flex-direction:column;height:100vh}
  .hHd-Xa_footArea{flex-direction:column;flex:none;display:flex}
  .hHd-Xa_footerActions{flex:none;width:100%;min-width:0;display:flex;flex-wrap:wrap}
  .hHd-Xa_settingsArea{flex:none;width:100%;min-width:0}
  .VOzbGW_triggerRow{flex:none;align-items:center;gap:8px;width:calc(100% + 4px);margin:4px -2px;display:flex}
  .VOzbGW_trigger{box-sizing:border-box;cursor:pointer;height:42px;flex:1;display:flex;align-items:center;gap:8px;padding:0 10px 0 8px;border:0;background:0 0;border-radius:12px;font:inherit;font-size:14px}
  .UQsH_q_triggerLabel{white-space:nowrap;overflow:hidden}
  /* dsh-ui-tools 工具条（实测：占满一行 256×36） */
  .wc-collapse-bar{display:flex;align-items:center;gap:4px;flex:1 1 100%;padding:4px 12px 6px}
  .wc-collapse-bar>button{flex:1 1 0;display:inline-flex;align-items:center;justify-content:center;height:26px;border:0;background:0 0;font:inherit;font-size:12px}
</style></head><body>
<div class="pI_x6G_sidebarCol">
  <div data-slot="sidebar.workspaces">
    <div class="YDXeBa_projectRow" aria-expanded="true">项目A</div>
    <div class="YDXeBa_projectRow" aria-expanded="true">项目B</div>
  </div>
  <div class="hHd-Xa_footArea">
    <div class="hHd-Xa_footerActions">
      <div data-slot="sidebar.footer.action" style="display: contents;">
        <!-- 第三方“整行”元素（如 dsh-cost-meter 余额栈）实测会出现在壳按钮**之前**：
           壳按钮组用 flex-basis:100% + order 抢到**最后一行**（按键行固定在底栏最底部）。
           默认 display:none（模拟无此类插件的干净环境），由最后的「整行元素」用例打开。 -->
        <div class="cm-balance" style="flex:1 1 100%;display:none">今日 ¥1.23</div>
        <div class="wc-collapse-bar" role="toolbar" aria-label="工作区视图">
          <button type="button" title="折叠所有工作区" aria-label="折叠所有工作区">折叠全部</button>
          <button type="button" title="展开所有工作区" aria-label="展开所有工作区">展开全部</button>
        </div>
      </div>
    </div>
    <div class="hHd-Xa_settingsArea">
      <div data-slot="sidebar.settings" style="display: contents;">
        <div class="VOzbGW_triggerRow">
          <button type="button" class="VOzbGW_trigger" aria-label="设置" aria-haspopup="dialog" aria-expanded="false">
            <div data-slot="settings.trigger" style="display: contents;">
              <span class="set-icon">&#9881;</span><span class="UQsH_q_triggerLabel">设置</span>
            </div>
          </button>
        </div>
      </div>
    </div>
  </div>
</div>
<script>
  // 仿官方行为：点官方「折叠/展开」按钮会翻转分组 aria-expanded
  window.__officialClicks = []
  document.querySelectorAll('.wc-collapse-bar button').forEach(function (b) {
    b.addEventListener('click', function () {
      window.__officialClicks.push(b.getAttribute('aria-label'))
      var to = b.getAttribute('aria-label').indexOf('折叠') === 0 ? 'false' : 'true'
      document.querySelectorAll('.YDXeBa_projectRow').forEach(function (r) { r.setAttribute('aria-expanded', to) })
    })
  })
  // 官方设置按钮：标记被点到（点击链路必须仍走官方节点）
  window.__settingsClicks = 0
  document.querySelector('.VOzbGW_trigger').addEventListener('click', function () { window.__settingsClicks += 1 })
  // 仿 dsh-view preload 桥
  window.__sent = []
  window.__dshExo = { send: function (channel) { window.__sent.push(channel) }, ready: function () {}, appInfo: function () { return { version: '' } } }
</script>
</body></html>`

const SURVEY = `(() => {
  const R = (el) => { const r = el.getBoundingClientRect(); return { t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) } }
  const foot = document.querySelector('[class*="footArea"]')
  const visible = (el) => { const st = getComputedStyle(el); const r = el.getBoundingClientRect(); return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0 }
  return {
    footRailAttr: foot ? foot.getAttribute('data-dsh-exo-rail') : null,
    footRect: foot ? R(foot) : null,
    footScrollW: foot ? foot.scrollWidth - foot.clientWidth : null,
    docScrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    buttons: [...document.querySelectorAll('[class*="footArea"] button')].map((b) => ({
      id: b.id || null, aria: b.getAttribute('aria-label'), haspopup: b.getAttribute('aria-haspopup'),
      disabled: b.getAttribute('data-disabled'), visible: visible(b), rect: R(b)
    })),
    footRect: foot ? R(foot) : null,
    collapseBar: (() => { const el = document.querySelector('.wc-collapse-bar'); return el ? getComputedStyle(el).display : 'missing' })(),
    expanded: [...document.querySelectorAll('[data-slot="sidebar.workspaces"] [aria-expanded]')].map((el) => el.getAttribute('aria-expanded')),
    sent: window.__sent.slice(),
    officialClicks: window.__officialClicks.slice(),
    settingsClicks: window.__settingsClicks
  }
})()`

app.whenReady().then(async () => {
  let failed = 0
  const assert = (cond, label, detail) => {
    console.log((cond ? '  ✓ ' : '  ✗ ') + label + (cond || detail === undefined ? '' : ' — ' + JSON.stringify(detail)))
    if (!cond) failed++
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  const mod = loadModule()
  // 先卡一道语法防线：这组 CSS 是用模板字符串拼的，漏一个逗号会把两条字符串
  // 默默合成一条（甚至把 `${wide}` 当标签函数调用），错误很难从行为上看出来。
  const cssText = mod.sidebarFooterCss()
  assert(typeof cssText === 'string' && cssText.length > 100, 'sidebarFooterCss() 返回非空字符串', cssText && cssText.length)
  assert(!/undefined|\[object/.test(cssText), 'CSS 无 undefined/[object 残留（模板插值完备）', cssText.match(/undefined|\[object/g))
  assert((cssText.match(/{/g) || []).length === (cssText.match(/}/g) || []).length, 'CSS 花括号配对', (cssText.match(/{/g) || []).length)
  assert(cssText.indexOf('data-dsh-exo-rail="wide"') >= 0, 'CSS 含 wide 态规则前缀', cssText.indexOf('data-dsh-exo-rail'))
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { sandbox: true, contextIsolation: true } })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE))

  await win.webContents.insertCSS(mod.sidebarFooterCss(), { cssOrigin: 'user' })
  await win.webContents.executeJavaScript(mod.buildSidebarEntryScript())
  await win.webContents.executeJavaScript(mod.buildSidebarFooterScript())
  await sleep(300)
  await win.webContents.executeJavaScript(`window.__dshExoFootSync()`)
  await sleep(150)

  const wide = await win.webContents.executeJavaScript(SURVEY)
  const visibleBtns = wide.buttons.filter((b) => b.visible)

  console.log('\n[宽态]')
  assert(wide.footRailAttr === 'wide', '底部区标记为 wide', wide.footRailAttr)
  assert(visibleBtns.length === 4, '可见按钮 4 个', visibleBtns.map((b) => b.aria))
  assert(visibleBtns.every((b) => b.rect.w === 32 && b.rect.h === 32), '四个按钮均 32×32', visibleBtns.map((b) => b.rect.w + 'x' + b.rect.h))
  const tops = visibleBtns.map((b) => b.rect.t)
  assert(Math.max(...tops) - Math.min(...tops) <= 2, '四个按钮横排同一行', tops)

  // ── 自适应均分：4 个按钮中心应恰在整行的 1/8, 3/8, 5/8, 7/8 处，且随宽度跟随 ──
  // 设置钮在 settingsArea、另 3 个在 footerActions 两个并列容器里，靠 1:3 宽度 + 各容器
  // space-around 才能精确等价于 4 等分；这条断言就是套住那个等价关系的（改错就红）。
  const spacing = await win.webContents.executeJavaScript(`(() => {
    const measure = () => {
      const btns = [...document.querySelectorAll('.dsh-exo-foot-btn, [class*="triggerRow"] > button[class*="trigger"]')]
        .filter((b) => b.getBoundingClientRect().width > 0)
      const foot = document.querySelector('[class*="footArea"]')
      const fr = foot.getBoundingClientRect()
      const centers = btns.map((b) => { const r = b.getBoundingClientRect(); return (r.left + r.width / 2 - fr.left) / fr.width })
      return { centers, gaps: centers.slice(1).map((c, i) => c - centers[i]), footW: Math.round(fr.width) }
    }
    const col = document.querySelector('.pI_x6G_sidebarCol')
    const base = { sidebarW: Math.round(col.getBoundingClientRect().width), ...measure() }
    col.style.width = '320px'
    const wider = { sidebarW: 320, ...measure() }
    col.style.width = '240px'
    const narrower = { sidebarW: 240, ...measure() }
    col.style.width = ''
    return { base, wider, narrower }
  })()`)
  // 每个按钮中心与理论值 (2i+1)/8 的最大偏差（归一化到整行宽）。
  // 注意先按位置排序：四个按钮分属两个容器，**DOM 顺序 ≠ 视觉顺序**（设置在最后）。
  const centerError = (centers) => {
    if (centers.length !== 4) return 1
    const sorted = [...centers].sort((a, b) => a - b)
    return Math.max(...sorted.map((c, i) => Math.abs(c - (2 * i + 1) / 8)))
  }
  const sortedGaps = (centers) => {
    const s = [...centers].sort((a, b) => a - b)
    return s.slice(1).map((c, i) => c - s[i])
  }
  assert(centerError(spacing.base.centers) < 0.02, '★ 4 个按钮中心落在整行 1/8·3/8·5/8·7/8（自适应均分）', [...spacing.base.centers].sort((a, b) => a - b).map((c) => c.toFixed(3)))
  const gaps = sortedGaps(spacing.base.centers)
  assert(Math.max(...gaps) - Math.min(...gaps) < 0.02, '★ 相邻按钮中心间距相等', gaps.map((g) => g.toFixed(3)))
  // 确认宽度真的变了（否则「随宽度跟随」没被真正验证）
  assert(spacing.wider.footW > spacing.base.footW && spacing.narrower.footW < spacing.base.footW,
    '★ 测试确实改动了侧栏宽度（宽度跟随验证有效）', { base: spacing.base.footW, wider: spacing.wider.footW, narrower: spacing.narrower.footW })
  assert(centerError(spacing.wider.centers) < 0.02, '★ 侧栏加宽到 320px 后仍均分（间距非写死）', [...spacing.wider.centers].sort((a, b) => a - b).map((c) => c.toFixed(3)))
  assert(centerError(spacing.narrower.centers) < 0.02, '★ 侧栏收窄到 240px 后仍均分（间距非写死）', [...spacing.narrower.centers].sort((a, b) => a - b).map((c) => c.toFixed(3)))
  const settings = visibleBtns.find((b) => b.haspopup === 'dialog')
  assert(!!settings && settings.aria === '设置', '官方「设置」按钮在列且已缩成小方钮', settings)
  assert(wide.footRect.h <= 44, '底部区压到一行（≤44px）', wide.footRect)
  assert(wide.collapseBar === 'none', '.wc-collapse-bar 已收起', wide.collapseBar)
  assert(wide.footScrollW === 0 && wide.docScrollX === 0, '无横向溢出', { footScrollW: wide.footScrollW, docScrollX: wide.docScrollX })

  // 官方设置按钮点击链路未被破坏
  await win.webContents.executeJavaScript(`document.querySelector('.VOzbGW_trigger').click()`)
  await sleep(150)
  const afterSettings = await win.webContents.executeJavaScript(`window.__settingsClicks`)
  assert(afterSettings === 1, '点击「设置」仍触发官方节点（打开 DSH 设置弹窗链路未改）', afterSettings)

  // 两个壳入口 → 桥
  await win.webContents.executeJavaScript(`document.getElementById('dsh-exo-webpanel-entry').click()`)
  await win.webContents.executeJavaScript(`document.getElementById('dsh-exo-panel-entry').click()`)
  await sleep(150)
  const sent = await win.webContents.executeJavaScript(`window.__sent.slice()`)
  assert(sent.includes('webpanel:toggle'), '网页版入口 → 桥收到 webpanel:toggle', sent)
  assert(sent.includes('panel:open'), '管理面板入口 → 桥收到 panel:open', sent)

  // 折叠切换：初始全展开 → 应点官方「折叠所有工作区」，分组变 false，图标/文案切到「展开」
  await win.webContents.executeJavaScript(`document.getElementById('dsh-exo-collapse-toggle').click()`)
  await sleep(400)
  const collapsed = await win.webContents.executeJavaScript(SURVEY)
  assert(collapsed.officialClicks[0] === '折叠所有工作区', '折叠切换转发 click 给官方「折叠」按钮', collapsed.officialClicks)
  assert(collapsed.expanded.every((v) => v === 'false'), '分组全部收起', collapsed.expanded)
  const toggleBtn = collapsed.buttons.find((b) => b.id === 'dsh-exo-collapse-toggle')
  assert(!!toggleBtn && toggleBtn.aria === '展开所有工作区', '按钮文案随状态切到「展开所有工作区」', toggleBtn && toggleBtn.aria)

  // 再点一次 → 官方「展开所有工作区」
  await win.webContents.executeJavaScript(`document.getElementById('dsh-exo-collapse-toggle').click()`)
  await sleep(400)
  const expanded = await win.webContents.executeJavaScript(SURVEY)
  assert(expanded.officialClicks[1] === '展开所有工作区', '再点转发给官方「展开」按钮（双向 toggle）', expanded.officialClicks)
  assert(expanded.expanded.every((v) => v === 'true'), '分组全部展开', expanded.expanded)

  // 自愈
  await win.webContents.executeJavaScript(`document.getElementById('dsh-exo-panel-entry').remove(); document.getElementById('dsh-exo-collapse-toggle').remove(); window.__dshExoFootSync()`)
  await sleep(200)
  const healed = await win.webContents.executeJavaScript(`!!document.getElementById('dsh-exo-panel-entry') && !!document.getElementById('dsh-exo-collapse-toggle')`)
  assert(healed === true, '壳按钮被移除后重新同步可补回（自愈）', healed)

  // 窄条：只留设置
  await win.webContents.executeJavaScript(`document.querySelector('.pI_x6G_sidebarCol').style.width = '56px'; window.__dshExoFootSync()`)
  await sleep(250)
  const rail = await win.webContents.executeJavaScript(SURVEY)
  const railVisible = rail.buttons.filter((b) => b.visible)
  console.log('\n[窄态]')
  assert(rail.footRailAttr === 'rail', '窄条切换到 rail 标记', rail.footRailAttr)
  assert(railVisible.length === 1 && railVisible[0].aria === '设置', '窄条只显示「设置」', railVisible.map((b) => b.aria))
  assert(rail.docScrollX === 0, '窄条无横向溢出', rail.docScrollX)

  // 恢复宽态：壳按钮应回来
  await win.webContents.executeJavaScript(`document.querySelector('.pI_x6G_sidebarCol').style.width = '280px'; window.__dshExoFootSync()`)
  await sleep(250)
  const restored = await win.webContents.executeJavaScript(SURVEY)
  assert(restored.buttons.filter((b) => b.visible).length === 4, '恢复宽态后 4 个按钮回来', restored.buttons.filter((b) => b.visible).map((b) => b.aria))

  // 第三方「整行」元素（余额行等）应在**上方**，而壳按钮行固定在**最底部**。
  // 同时验「4 个按钮仍在同一行」——这是组容器（flex-basis:100% + order）的核心作用
  // （实机曾因第三方元素排在壳按钮之前而被顶到第二行，footArea 高 131px）。
  const balance = await win.webContents.executeJavaScript(`(() => {
    const R = (el) => { const r = el.getBoundingClientRect(); return { t: Math.round(r.top), l: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) } }
    const el = document.querySelector('.cm-balance')
    el.style.display = 'block'
    window.__dshExoFootSync()
    const all = [...document.querySelectorAll('.dsh-exo-foot-btn, [class*="triggerRow"] > button[class*="trigger"]')]
      .filter((b) => b.getBoundingClientRect().width > 0)
    const btns = [...document.querySelectorAll('.dsh-exo-foot-btn')].filter((b) => b.getBoundingClientRect().width > 0)
    const foot = document.querySelector('[class*="footArea"]')
    const out = {
      balance: R(el),
      btnTops: btns.map((b) => Math.round(b.getBoundingClientRect().top)),
      btnSizes: btns.map((b) => Math.round(b.getBoundingClientRect().width)),
      allTops: all.map((b) => Math.round(b.getBoundingClientRect().top)),
      allBottoms: all.map((b) => Math.round(b.getBoundingClientRect().bottom)),
      footRect: R(foot),
      footBottoms: [R(foot).t + R(foot).h]
    }
    el.style.display = 'none'
    window.__dshExoFootSync()
    return out
  })()`)
  assert(balance.btnSizes.every((w) => w === 32), '第三方整行元素不挤扁壳按钮（仍为 32px 宽）', balance.btnSizes)
  assert(Math.max(...balance.allTops) - Math.min(...balance.allTops) <= 2, '★ 有第三方整行元素时 4 个按钮仍在同一行', balance.allTops)
  assert(balance.balance.t < Math.min(...balance.allTops), '★ 第三方整行元素排在按钮行**上方**（按键行在最底）', balance)
  assert(Math.max(...balance.allBottoms) >= balance.footRect.t + balance.footRect.h - 6,
    '★ 按键行压在底栏最底部（底边贴近底栏底边）', { allBottoms: balance.allBottoms, footBottom: balance.footRect.t + balance.footRect.h })

  console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 项失败`)
  app.exit(failed === 0 ? 0 : 1)
})
