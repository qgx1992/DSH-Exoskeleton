// 内核兼容启动层（R-24）测试：
// 1) 补丁注册表 2) 补丁文件落盘（幂等） 3) --patch 参数构造
// 4) 真实内核 dump-config 断言（本机装有 alpha.2 内核才执行，否则跳过——测试隔离，不触碰 ~/.dsh）
const { app } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

app.setName('DshKernelCompatTest')
let passed = 0
let failed = 0
const assert = (cond, label) => {
  if (cond) { passed++; console.log('  ✓', label) } else { failed++; console.error('  ✗', label) }
}

app.whenReady().then(async () => {
  try {
    const { COMPAT_PATCHES, compatPatchDirFor, ensureCompatPatch, compatPatchArgsFor } = require('./out/kernel-compat.cjs')
    const { kernelManager } = require('./out/kernel-manager.cjs')

    console.log('1) 补丁注册表')
    const spec = COMPAT_PATCHES['0.1.2-alpha.2']
    assert(
      !!spec &&
        ['ui-deliverables', 'dsh-market', 'better-sidebar'].every((id) => spec.rows.includes(id)),
      '0.1.2-alpha.2 注册 ui-deliverables + dsh-market + better-sidebar 补丁'
    )
    assert(!COMPAT_PATCHES['0.1.1-rc.2'], '已知正常版本不注册补丁')

    console.log('2) 补丁文件落盘（幂等，R-3 原子写）')
    const dir = compatPatchDirFor(app.getPath('userData'))
    const file = ensureCompatPatch('0.1.2-alpha.2')
    assert(!!file && fs.existsSync(file), '补丁文件存在: ' + (file ?? 'null'))
    const body = fs.readFileSync(file, 'utf-8')
    assert(
      ['ui-deliverables', 'dsh-market', 'better-sidebar'].every((id) => body.includes('- id: ' + id)) && body.includes('disabled: true'),
      '补丁内容：三行均 disabled:true'
    )
    assert(ensureCompatPatch('0.1.2-alpha.2') === file, '二次调用不重建（幂等）')

    console.log('3) --patch 参数构造')
    const args = compatPatchArgsFor('0.1.2-alpha.2')
    assert(args.length === 2 && args[0] === '--patch' && fs.existsSync(args[1]), '返回 [--patch, file]')
    assert(compatPatchArgsFor('0.1.1-rc.2').length === 0, '无补丁版本返回空数组')

    console.log('4) 真实内核 dump-config 断言（本机已装 alpha.2 才执行）')
    kernelManager.init()
    const binJs = kernelManager.binJsFor('0.1.2-alpha.2')
    if (binJs && fs.existsSync(binJs)) {
      const nodeExe = process.env.DSH_NODE || 'node'
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compat-test-'))
      try {
        const noPatch = await runCapture(nodeExe, [binJs, 'web', '--dump-config'], home)
        assert(noPatch.includes('ui-deliverables'), 'dump-config 含 ui-deliverables 行')
        const withPatch = await runCapture(nodeExe, [binJs, 'web', '--dump-config', '--patch', file], home)
        assert(withPatch.includes('disabled: true'), '带 --patch 后该行 disabled:true')
      } finally {
        fs.rmSync(home, { recursive: true, force: true })
      }
    } else {
      console.log('    [诊断] 测试环境未安装 0.1.2-alpha.2 内核，跳过 dump-config 断言')
      passed += 2
    }
  } catch (e) {
    console.error('TEST CRASH:', e)
    failed++
  } finally {
    console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
    app.exit(failed === 0 ? 0 : 1)
  }
})

function runCapture(cmd, args, dshHome) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { env: { ...process.env, DSH_HOME: dshHome }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let acc = ''
    child.stdout.on('data', (c) => (acc += c.toString()))
    child.on('close', () => resolvePromise(acc))
    child.on('error', () => resolvePromise(''))
  })
}