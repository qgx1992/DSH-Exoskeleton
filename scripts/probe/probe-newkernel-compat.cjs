// 本机实测探针（不进 npm test）：新内核兼容性门禁（alpha.3/4/5…）。
// 运行：node node_modules/esbuild/bin/esbuild src/main/kernel-compat.ts --bundle --platform=node
//        --external:electron --external:@deepseek-ai/* --format=cjs --outfile=scripts/out/kernel-compat.cjs
//       electron scripts/probe/probe-newkernel-compat.cjs [版本号 ...]
//   不带参数时默认测 alpha.3 + alpha.4；新版验证时把版本号作为参数传入（如 0.1.2-alpha.5）。
// 断言：
//   A) 各版本无补丁试启动（注册表未收录 → 生产路径就是无补丁）→ 预期成功；
//      失败则用 alpha.2 补丁行做对照定位首个失败插件。
// 全程走 R-24 门禁（克隆 DSH_HOME + 第一锚点 relink/restore，零副作用）。
const { app } = require('electron')
const os = require('os')
const path = require('path')

app.setName('DSH-Exoskeleton') // 对齐真实 userData（kernels/ 索引与内核树）

app.whenReady().then(async () => {
  try {
    const { trialBootManagedKernel, compatPatchArgsFor, compatPatchPathFor } = require('../out/kernel-compat.cjs')
    const dshHome = path.join(os.homedir(), '.dsh')
    const versions = process.argv.slice(2).filter((a) => !a.startsWith('-'))
    if (versions.length === 0) versions.push('0.1.2-alpha.3', '0.1.2-alpha.4')
    const results = {}

    for (const v of versions) {
      const patch = compatPatchPathFor(v)
      console.log(`\n═══ ${v} ═══ 注册表补丁: ${patch ?? '无（生产即无补丁启动）'}`)

      console.log(`── 无补丁试启动 ──`)
      const a = await trialBootManagedKernel(v, dshHome, { timeoutMs: 60_000, patchPaths: [] })
      results[v] = { noPatch: a.ok, url: a.url, error: a.error }
      console.log('  ok=', a.ok, 'url=', a.url ? a.url.slice(0, 60) : null, 'error=', a.error)
      if (!a.ok) {
        const tail = (a.stderr || a.stdout).trim().split(/\r?\n/).filter(Boolean).slice(-8).join(' ⏎ ')
        console.log('  失败输出尾=', tail || '(空)')
        // 对照：带 alpha.2 的禁行补丁再试一次，定位是否同一批插件问题
        const legacy = compatPatchPathFor('0.1.2-alpha.2')
        if (legacy) {
          console.log('── 对照：带 alpha.2 兼容补丁 ──')
          const b = await trialBootManagedKernel(v, dshHome, { timeoutMs: 60_000, patchPaths: [legacy] })
          results[v].withLegacyPatch = b.ok
          console.log('  ok=', b.ok, 'error=', b.error)
          if (!b.ok) {
            console.log('  失败输出尾=', (b.stderr || b.stdout).trim().split(/\r?\n/).filter(Boolean).slice(-8).join(' ⏎ ') || '(空)')
          }
        }
      }
    }

    const allOk = versions.every((v) => results[v].noPatch)
    console.log(`\n结论: ${allOk ? 'PASS ✓（两版无补丁均可兼容启动）' : 'PARTIAL/FAIL ✗（' + JSON.stringify(results) + '）'}`)
    app.exit(allOk ? 0 : 1)
  } catch (e) {
    console.error('PROBE CRASH:', e)
    app.exit(1)
  }
})
