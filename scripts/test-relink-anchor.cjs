// 第一锚点重链接集成测试：验证 relinkProfileAnchor 把 profile 私有 node_modules/@deepseek-ai
// 的官方包链接统一指向目标内核（版本混杂修复）；顺带修复当前残留的 npm 全局链接。
const { app } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

app.setName('RelinkAnchorTest')
// 指向真实内核仓库（验证真实环境的 relink 行为；只改链接不改数据）
app.setPath('userData', 'C:/Users/QIU/AppData/Roaming/DSH-Exoskeleton')
let passed = 0
let failed = 0
const assert = (cond, label) => {
  if (cond) { passed++; console.log('  ✓', label) } else { failed++; console.error('  ✗', label) }
}

app.whenReady().then(async () => {
  try {
    const { kernelManager } = require('./out/kernel-manager.cjs')
    kernelManager.init()

    const ver = '0.1.2-alpha.2'
    const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    const anchorDir = path.join(dshHome, 'profiles', 'web', 'node_modules', '@deepseek-ai')
    const kernelDir = path.join(app.getPath('userData'), 'kernels', ver)

    console.log('1) 前置检查')
    assert(fs.existsSync(anchorDir), '第一锚点存在: ' + anchorDir)
    assert(fs.existsSync(kernelDir), '内核目录存在: ' + kernelDir)

    console.log('2) 重链接前现状')
    const before = fs.readdirSync(anchorDir, { withFileTypes: true })
      .filter((e) => e.isSymbolicLink())
      .map((e) => e.name + ' -> ' + fs.readlinkSync(path.join(anchorDir, e.name)))
    console.log('   ' + before.join('\n   '))

    console.log('3) 执行 relinkProfileAnchor(' + ver + ')')
    const r = kernelManager.relinkProfileAnchor(ver)
    console.log('   relinked:', r.relinked.length ? r.relinked.join(', ') : '（无）')
    console.log('   skipped:', r.skipped.length ? r.skipped.join(', ') : '（无）')

    console.log('4) 重链接后校验')
    const after = fs.readdirSync(anchorDir, { withFileTypes: true })
      .filter((e) => e.isSymbolicLink())
      .map((e) => e.name + ' -> ' + fs.readlinkSync(path.join(anchorDir, e.name)))
    console.log('   ' + after.join('\n   '))
    const mislinked = after.filter((l) => !l.includes(kernelDir) && !l.includes('profiles'))
    assert(mislinked.length === 0, '所有官方包链接均指向内核（残留: ' + (mislinked.join(', ') || '无') + '）')

    console.log('5) 幂等性：再次执行不应有 relink')
    const r2 = kernelManager.relinkProfileAnchor(ver)
    assert(r2.relinked.length === 0, '二次执行幂等（relinked 为空）')

    console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败')
    app.exit(failed > 0 ? 1 : 0)
  } catch (err) {
    console.error('测试异常:', err)
    app.exit(2)
  }
})
