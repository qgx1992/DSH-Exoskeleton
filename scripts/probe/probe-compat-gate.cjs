// 本机实测探针（不进 npm test）：用真实内核 + 真实 profile 走一遍 R-24 试启动门禁。
// 运行：node node_modules/esbuild/bin/esbuild src/main/kernel-compat.ts --bundle --platform=node
//        --external:electron --external:@deepseek-ai/* --format=cjs --outfile=scripts/out/kernel-compat.cjs
//       electron scripts/probe/probe-compat-gate.cjs
// 断言：0.1.2-alpha.2 在真实 profile 上「无补丁必失败、带补丁必成功」——两段都验证。
const { app } = require('electron')
const os = require('os')
const path = require('path')

app.setName('DSH-Exoskeleton') // 对齐真实 userData（kernels/ 索引与内核树）

app.whenReady().then(async () => {
  try {
    const { trialBootManagedKernel, compatPatchArgsFor } = require('../out/kernel-compat.cjs')
    const dshHome = path.join(os.homedir(), '.dsh')
    const version = '0.1.2-alpha.2'

    console.log('补丁参数:', JSON.stringify(compatPatchArgsFor(version)))

    console.log('── A) 无补丁试启动（预期失败，复现真实崩溃）──')
    const a = await trialBootManagedKernel(version, dshHome, { timeoutMs: 50_000, patchPaths: [] })
    console.log('  ok=', a.ok, 'error=', a.error)
    console.log('  stderr尾=' + (a.stderr.trim().split(/\r?\n/).slice(-2).join(' | ') || '(空)'))

    console.log('── B) 带 --patch 试启动（预期成功）──')
    // patchPaths 缺省 = 按注册表注入（patchUsed=true）
    const b = await trialBootManagedKernel(version, dshHome, { timeoutMs: 60_000 })
    console.log('  ok=', b.ok, 'patchUsed=', b.patchUsed, 'url=', b.url, 'error=', b.error)
    console.log('  stderr前12行=' + (b.stderr.trim().split(/\r?\n/).slice(-12).join(' ⏎ ') || '(空)'))

    const pass = !a.ok && b.ok && b.patchUsed
    console.log(`\n结果: ${pass ? 'PASS ✓（无补丁失败复现 + 带补丁启动成功）' : 'FAIL ✗（' + JSON.stringify({ a: a.ok, b: b.ok, patch: b.patchUsed }) + '）'}`)
    app.exit(pass ? 0 : 1)
  } catch (e) {
    console.error('PROBE CRASH:', e)
    app.exit(1)
  }
})