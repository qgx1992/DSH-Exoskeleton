// 首启默认内核预置测试：守卫纯函数 + 默认版本常量 + config 全新/迁移/重试语义
const { app } = require('electron')
const fs = require('fs')
const path = require('path')

app.setName('DshKernelProvisionTest')
let passed = 0
let failed = 0
const assert = (cond, label) => {
  if (cond) { passed++; console.log('  ✓', label) } else { failed++; console.error('  ✗', label) }
}

app.whenReady().then(async () => {
  try {
    const { ConfigStore, needsDefaultKernelProvision, DEFAULT_KERNEL_VERSION, KernelManager } =
      require('./out/kernel-provision.cjs')

    console.log('1) 默认内核版本常量')
    assert(DEFAULT_KERNEL_VERSION === '0.1.2-alpha.1', '默认内核为 0.1.2-alpha.1')
    assert(KernelManager.isValidVersion(DEFAULT_KERNEL_VERSION), '版本号格式合法（VERSION_RE）')

    console.log('2) 预置守卫（纯函数）')
    const baseCfg = () => ({
      defaultKernelProvisioned: false,
      kernelMode: 'managed',
      defaultKernelVersion: null,
      profiles: [{ id: 'default', name: '默认档案', kernelVersion: null, createdAt: 0 }]
    })
    assert(needsDefaultKernelProvision(baseCfg(), []) === true, '全新安装（无内核无选择）→ 需要预置')
    assert(needsDefaultKernelProvision({ ...baseCfg(), defaultKernelProvisioned: true }, []) === false, '已完成预置 → 跳过')
    assert(needsDefaultKernelProvision({ ...baseCfg(), kernelMode: 'system' }, []) === false, 'system 模式 → 跳过')
    assert(needsDefaultKernelProvision({ ...baseCfg(), defaultKernelVersion: '0.1.1-rc.2' }, []) === false, '用户已设默认内核 → 跳过')
    assert(
      needsDefaultKernelProvision(
        { ...baseCfg(), profiles: [{ id: 'default', name: 'x', kernelVersion: '0.1.1-rc.2', createdAt: 0 }] },
        []
      ) === false,
      '档案已绑定内核 → 跳过'
    )
    assert(needsDefaultKernelProvision(baseCfg(), ['0.1.1-rc.2']) === false, '已有任何托管内核 → 跳过')

    console.log('3) config 语义：全新安装（首次生成）')
    const cfgFile = path.join(app.getPath('userData'), 'config.json')
    if (fs.existsSync(cfgFile)) fs.rmSync(cfgFile)
    const s1 = new ConfigStore()
    s1.init()
    assert(s1.get().defaultKernelProvisioned === false, '首次创建 → false（待预置）')
    assert(fs.existsSync(cfgFile), '首次创建同步落盘（R-16）')

    console.log('4) config 语义：老配置迁移（升级用户）')
    const legacy = JSON.parse(fs.readFileSync(cfgFile, 'utf-8'))
    delete legacy.defaultKernelProvisioned
    fs.writeFileSync(cfgFile, JSON.stringify(legacy, null, 2))
    const s2 = new ConfigStore()
    s2.init()
    assert(s2.get().defaultKernelProvisioned === true, '字段缺失 → true（老用户不打扰）')

    console.log('5) config 语义：显式 false（预置失败待重试）不被迁移改写')
    fs.writeFileSync(cfgFile, JSON.stringify({ ...legacy, defaultKernelProvisioned: false }, null, 2))
    const s3 = new ConfigStore()
    s3.init()
    assert(s3.get().defaultKernelProvisioned === false, '显式 false 保留 → 下次启动重试')
  } catch (err) {
    failed++
    console.error('  ✗ 测试异常:', err)
  } finally {
    console.log(`\n${passed} passed, ${failed} failed`)
    app.exit(failed > 0 ? 1 : 0)
  }
})
