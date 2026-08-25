// 内核管理器集成测试（离线种子克隆方式；真实网络安装逻辑由 install() 提供，受网络环境影响可慢）
const { app } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

app.setName('DshKernelTest')
let passed = 0
let failed = 0
const assert = (cond, label) => {
  if (cond) { passed++; console.log('  ✓', label) } else { failed++; console.error('  ✗', label) }
}

app.whenReady().then(async () => {
  try {
    const { kernelManager } = require('./out/kernel-manager.cjs')
    kernelManager.init()
    const kernelsDir = path.join(app.getPath('userData'), 'kernels')
    const ver = '0.1.1-rc.2'

    console.log('1) 版本校验')
    assert(kernelManager.constructor.isValidVersion(ver), '合法版本通过')
    assert(!kernelManager.constructor.isValidVersion('../../etc/passwd'), '注入路径拒绝')
    assert(!kernelManager.constructor.isValidVersion('latest'), '非语义版本拒绝')
    assert(kernelManager.constructor.safeDirName(ver) === ver, '目录名安全')

    console.log('2) 已安装列表（初始）')
    assert(kernelManager.listInstalled().length === 0, '初始为空')

    console.log('3) 离线种子克隆（模拟已安装，等价 install() 结果）')
    // 从系统全局 dsh 克隆 node_modules 作为内核
    const src = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules')
    const haveSeed = fs.existsSync(path.join(src, '@deepseek-ai', 'dsh')) && fs.existsSync(path.join(src, '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
    assert(haveSeed, '找到系统 dsh 种子（否则跳过安装断言）')
    if (haveSeed) {
      fs.mkdirSync(path.join(kernelsDir, ver, 'node_modules'), { recursive: true })
      fs.cpSync(src, path.join(kernelsDir, ver, 'node_modules'), { recursive: true })
      const size = dirSize(path.join(kernelsDir, ver))
      const meta = {
        kernels: {
          [ver]: { version: ver, dir: path.join(kernelsDir, ver), status: 'installed', installedAt: Date.now(), size, integrity: 'seed', error: null }
        }
      }
      fs.writeFileSync(path.join(kernelsDir, 'kernels.json'), JSON.stringify(meta, null, 2))
      kernelManager.init() // 重载索引
    }

    console.log('4) 安装结果')
    const bin = kernelManager.binJsFor(ver)
    assert(fs.existsSync(bin || ''), 'bin.js 存在: ' + bin)
    const list = kernelManager.listInstalled()
    assert(list.length === 1 && list[0].version === ver, 'listInstalled 含该版本')
    assert(list[0].status === 'installed', '状态 installed')

    console.log('5) 默认版本路由')
    assert(kernelManager.getActiveVersion(ver) === ver, '已装版本可激活')
    assert(kernelManager.getActiveVersion('9.9.9') === null, '未装版本不可激活')
    assert(kernelManager.getActiveVersion(null) === null, 'null 默认返回 null')

    console.log('5.5) 存储统计（配额，阶段 C）')
    assert(kernelManager.totalSizeBytes() > 0, 'totalSizeBytes > 0（种子已装）')
    const q = kernelManager.quota()
    assert(typeof q.quotaMB === 'number' && q.quotaMB > 0, 'quotaMB 有效: ' + q.quotaMB)
    assert(typeof q.usedMB === 'number' && q.usedMB > 0, 'usedMB 有效: ' + q.usedMB)
    assert(typeof q.diskFreeMB === 'number', 'diskFreeMB 有效: ' + q.diskFreeMB)

    console.log('6) 重复安装拒绝（不触发网络）')
    const dup = await kernelManager.install(ver)
    assert(!dup.ok, '重复安装被拒绝')

    console.log('7) 卸载')
    const un = kernelManager.uninstall(ver)
    assert(un.ok, 'uninstall ok')
    assert(kernelManager.listInstalled().length === 0, '卸载后列表为空')
    assert(!kernelManager.binJsFor(ver), 'bin.js 已移除')
  } catch (e) {
    console.error('TEST CRASH:', e)
    failed++
  } finally {
    console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
    app.exit(failed === 0 ? 0 : 1)
  }
})

function dirSize(dir) {
  let s = 0
  try {
    const stack = [dir]
    while (stack.length) {
      const cur = stack.pop()
      if (!cur) continue
      for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
        const p = path.join(cur, e.name)
        if (e.isDirectory()) stack.push(p)
        else s += fs.statSync(p).size
      }
    }
  } catch { /* noop */ }
  return s
}