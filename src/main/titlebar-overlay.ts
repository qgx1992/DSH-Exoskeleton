/**
 * 无标题栏窗口的「原生窗口按钮叠加层（titleBarOverlay）」底色同步。
 *
 * 背景（实测取证见 scripts/probe/probe-overlay-color.cjs）：
 * 窗口用 `titleBarStyle: 'hidden'` + `titleBarOverlay`——内容从 y=0 铺满，右上角三个
 * 原生按钮（最小化/最大化/关闭）由系统画在内容**之上**，底色由 `titleBarOverlay.color`
 * 单方面决定。这个色是「窗口级」的，但窗口内容区同时承载三个底色互不相同的表面：
 *
 *   | 表面                      | 暗色主题   | 亮色主题   |
 *   |---------------------------|-----------|-----------|
 *   | 壳管理面板（Dashboard）    | #060B12   | —（固定暗色）|
 *   | DSH Web UI 顶栏            | #151517   | #FFFFFF   |
 *   | 官方网页版 DeepSeek        | 站点自定   | 站点自定   |
 *
 * 旧实现把 color/backgroundColor 硬编码成 `#0b0f17` 就不再变，于是：
 * - DSH 页面顶栏是 `#151517`，右上角却压着一块 `#0b0f17`，实测边界正好落在
 *   x=1443（离右边 137px）——三个按钮底下是另一种颜色，一条色缝纵贯顶栏；
 * - DSH 切亮色主题后变成白底 `#FFFFFF`，色缝从「深灰差一档」恶化成「白底压黑块」。
 *
 * 本模块只做两件事：
 * ① 提供「页面顶栏底色」的探针脚本与颜色工具（归一化/亮度/对比度/笔画色）；
 * ② 由 window-manager 按**当前在上的表面**调用 win.setTitleBarOverlay 同步。
 *
 * 分辨率策略：优先读页面**真实像素来源**（顶层不透明祖先的背景色），拿不到时回退
 * 到官方设计令牌默认值；两者都拿不到才回退壳画布色。这样 DSH 改主题/换版本都不用改代码。
 */

/**
 * 窗口初始底色 / 壳管理面板底色。
 * 与 src/renderer/styles/global.css 的 `--color-canvas: oklch(0.148 0.018 258)` 一致
 * （换算 sRGB ≈ #060B12）。三者必须同值，否则启动瞬间与面板态会出现同款色缝。
 */
export const SHELL_CANVAS_COLOR = '#060B12'

/** DSH 官方顶栏兜底色（暗色主题；实测 body 背景 = --dsw-alias-bg-base = #151517） */
export const DSH_TOP_COLOR_DARK = '#151517'
/** DSH 官方顶栏兜底色（亮色主题；实测 body 背景 = --dsw-alias-bg-base = #fff） */
export const DSH_TOP_COLOR_LIGHT = '#ffffff'

/**
 * 按钮笔画色候选，取自 DSH 自己的 `--dsw-alias-label-primary`
 * （暗色 #f9fafb / 亮色 #0f1115）——按钮与页面文字同色，视觉才是一套。
 */
const SYMBOL_LIGHT = '#f9fafb'
const SYMBOL_DARK = '#0f1115'

/** 页面 → 壳：主题切换通知（复用 dsh-view preload 的 __dshExo 白名单通道） */
export const THEME_CHANGED_CHANNEL = 'theme:changed'

/**
 * 解析 CSS 颜色字符串为 `#rrggbb`。
 * 只接受十六进制与 rgb()/rgba() 两种（页面计算值只会是这两种）；半透明（alpha<1）
 * 返回 null —— 调用方需要继续向上找祖先，而不是把半透明色当成实底。
 */
export function normalizeCssColor(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const s = input.trim().toLowerCase()
  if (!s) return null

  // #rgb / #rgba / #rrggbb / #rrggbbaa
  if (s.startsWith('#')) {
    const h = s.slice(1)
    if (!/^[0-9a-f]+$/.test(h)) return null
    if (h.length === 3 || h.length === 4) {
      if (h.length === 4 && h[3] !== 'f') return null
      return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`
    }
    if (h.length === 6) return `#${h}`
    if (h.length === 8) {
      if (h.slice(6) !== 'ff') return null // 半透明 → 交由调用方上溯
      return `#${h.slice(0, 6)}`
    }
    return null
  }

  // rgb(r, g, b) / rgba(r, g, b, a)
  const m = s.match(/^rgba?\(([^)]+)\)$/)
  if (!m) return null
  const parts = m[1].split(/[,/\s]+/).filter(Boolean)
  if (parts.length < 3) return null
  const chan = parts.slice(0, 3).map((p) => {
    const v = p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p)
    return v
  })
  if (chan.some((v) => !Number.isFinite(v))) return null
  if (parts.length >= 4) {
    const raw = parts[3]
    const a = raw.endsWith('%') ? parseFloat(raw) / 100 : parseFloat(raw)
    if (Number.isFinite(a) && a < 1) return null // 半透明
  }
  return `#${chan.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`
}

/** `#rrggbb` → [r, g, b]；非法返回 null */
function toRgb(hex: string): [number, number, number] | null {
  const n = normalizeCssColor(hex)
  if (!n) return null
  return [
    parseInt(n.slice(1, 3), 16),
    parseInt(n.slice(3, 5), 16),
    parseInt(n.slice(5, 7), 16)
  ]
}

/** WCAG 相对亮度（0=黑，1=白） */
export function relativeLuminance(hex: string): number {
  const rgb = toRgb(hex)
  if (!rgb) return 0
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 对比度（1 ~ 21） */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * 按底色挑笔画色：在深浅两个候选中取对比度更高者。
 * 暗底 → 浅笔画，亮底 → 深笔画；底色异常时也总有一侧可用，不会出现「白底白按钮」。
 */
export function pickSymbolColor(background: string): string {
  const bg = normalizeCssColor(background) ?? SHELL_CANVAS_COLOR
  const withLight = contrastRatio(bg, SYMBOL_LIGHT)
  const withDark = contrastRatio(bg, SYMBOL_DARK)
  return withLight >= withDark ? SYMBOL_LIGHT : SYMBOL_DARK
}

/**
 * 页面顶栏底色探针（在主世界执行）。
 *
 * 采样策略：overlay 带（顶部 overlayHeight 像素）内、靠右边缘取若干横向采样点——
 * 那正是三个原生按钮压住的区域，也正是要匹配的区域。每个点沿祖先链找**第一个不透明
 * 背景**（即实际被画出来的底色），再把各点结果取众数（顶栏里零星的功能按钮不会翻转结果）。
 * 全程取不到时回退官方令牌 --dsw-alias-bg-base → body 背景 → null（由调用方兜底）。
 *
 * 返回 `{ color, dark, samples, source }`；任何异常返回 `{ color: null }`，不抛出。
 */
export function buildTopColorProbeScript(overlayHeight: number): string {
  return `(() => {
  try {
    const H = ${Math.max(1, Math.round(overlayHeight))}
    const hexOf = (v) => {
      if (typeof v !== 'string') return null
      const s = v.trim().toLowerCase()
      if (!s) return null
      if (s.startsWith('#')) {
        const h = s.slice(1)
        if (!/^[0-9a-f]+$/.test(h)) return null
        if (h.length === 3) return '#' + h[0]+h[0]+h[1]+h[1]+h[2]+h[2]
        if (h.length === 6) return '#' + h
        if (h.length === 8) return h.slice(6) === 'ff' ? '#' + h.slice(0,6) : null
        return null
      }
      const m = s.match(/^rgba?\\(([^)]+)\\)$/)
      if (!m) return null
      const parts = m[1].split(/[,/\\s]+/).filter(Boolean)
      if (parts.length < 3) return null
      if (parts.length >= 4) {
        const raw = parts[3]
        const a = raw.endsWith('%') ? parseFloat(raw) / 100 : parseFloat(raw)
        if (isFinite(a) && a < 1) return null
      }
      const c = parts.slice(0,3).map((p) => p.endsWith('%') ? (parseFloat(p)/100)*255 : parseFloat(p))
      if (c.some((v) => !isFinite(v))) return null
      return '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2,'0')).join('')
    }
    // 该元素的「有效底色」：向上找第一个不透明背景
    const effectiveBg = (start) => {
      let el = start
      for (let i = 0; el && i < 14; i++, el = el.parentElement) {
        const c = getComputedStyle(el)
        const hex = hexOf(c.backgroundColor)
        if (hex) return hex
      }
      return null
    }

    const y = Math.max(1, Math.round(H / 2))
    const xs = [6, 46, 92, 138].map((d) => window.innerWidth - d).filter((x) => x > 0)
    const samples = []
    for (const x of xs) {
      const hit = document.elementFromPoint(x, y)
      const hex = hit ? effectiveBg(hit) : null
      if (hex) samples.push(hex)
    }

    let color = null
    let source = 'none'
    if (samples.length) {
      const tally = new Map()
      for (const s of samples) tally.set(s, (tally.get(s) || 0) + 1)
      // 众数优先，平票取先出现的（采样点自右向左，最右最贴近按钮区）
      let best = samples[0], bestN = 0
      for (const s of samples) {
        const n = tally.get(s)
        if (n > bestN) { best = s; bestN = n }
      }
      color = best
      source = 'element'
    }
    if (!color) {
      const rootCs = getComputedStyle(document.documentElement)
      const bodyCs = getComputedStyle(document.body)
      const tok = hexOf(bodyCs.getPropertyValue('--dsw-alias-bg-base')) ||
                  hexOf(rootCs.getPropertyValue('--dsw-alias-bg-base'))
      if (tok) { color = tok; source = 'token' }
    }
    if (!color) {
      const bodyHex = hexOf(getComputedStyle(document.body).backgroundColor)
      if (bodyHex) { color = bodyHex; source = 'body' }
    }
    return {
      color,
      source,
      samples,
      dark: document.body.hasAttribute('data-ds-dark-theme'),
      href: location.href
    }
  } catch (e) {
    return { color: null, source: 'error', samples: [], dark: false, href: '' }
  }
})()`
}

/**
 * 主题切换监听（主世界执行，幂等）。
 *
 * DSH 换主题只改 `body[data-ds-dark-theme]`，不发任何事件；壳需要跟着换 overlay 底色，
 * 否则「暗色下差一档」会变成「亮色下白底压黑块」。这里观察该属性 + 系统配色偏好变化，
 * 去抖后经既有 `__dshExo.send` 白名单通道回壳（不新增 preload 暴露面，遵守 R-27）。
 */
export function buildThemeWatchScript(): string {
  return `(() => {
  try {
    const SEND = ${JSON.stringify(THEME_CHANGED_CHANNEL)}
    if (window.__dshExoOverlayThemeWatch) return 'already'
    window.__dshExoOverlayThemeWatch = true
    let timer = null
    const notify = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        try {
          const dark = document.body.hasAttribute('data-ds-dark-theme')
          window.__dshExo && window.__dshExo.send(SEND, { dark })
        } catch (e) { /* 静默 */ }
      }, 120)
    }
    const obs = new MutationObserver(notify)
    obs.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class', 'style'] })
    try {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      mq.addEventListener ? mq.addEventListener('change', notify) : mq.addListener(notify)
    } catch (e) { /* 老内核忽略 */ }
    return 'installed'
  } catch (e) { return 'failed' }
})()`
}
