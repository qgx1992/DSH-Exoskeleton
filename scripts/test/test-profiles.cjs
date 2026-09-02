// 配置档案管理单元测试（阶段 C：多 Profile + 内核版本绑定）
const { app } = require('electron')
const fs = require('fs')
const path = require('path')

app.setName('DshProfileTest')
let passed = 0
let failed = 0
const assert = (cond, label) => {
  if (cond) { passed++; console.log('  ✓', label) } else { failed++; console.error('  ✗', label) }
}

app.whenReady().then(async () => {
  try {
    const { listProfiles, createProfile, deleteProfile, activateProfile, setProfileKernel } = require('../out/profiles.cjs')
    // 干净起点：删除测试 userData 的 config.json
    const cfgFile = path.join(app.getPath('userData'), 'config.json')
    if (fs.existsSync(cfgFile)) fs.rmSync(cfgFile)

    console.log('1) 默认档案')
    let ps = listProfiles()
    assert(ps.length === 1 && ps[0].id === 'default', '初始默认档案存在')
    assert(ps[0].kernelVersion === null, '默认档案未绑定内核')

    console.log('2) 新建档案')
    assert(!createProfile('').ok, '空名拒绝')
    assert(!createProfile('   ').ok, '纯空格拒绝')
    const r1 = createProfile('实验A')
    assert(r1.ok && r1.profile && r1.profile.id !== 'default', '创建成功')
    assert(!createProfile('实验A').ok, '重名拒绝')
    ps = listProfiles()
    assert(ps.length === 2, '列表含 2 个档案')

    console.log('3) 激活')
    const p1 = ps.find((p) => p.id !== 'default')
    assert(!activateProfile('不存在').ok, '不存在档案拒绝')
    assert(activateProfile(p1.id).ok, '激活成功')

    console.log('4) 删除')
    assert(!deleteProfile('default').ok, '默认档案不可删除')
    assert(deleteProfile(p1.id).ok, '删除成功')
    ps = listProfiles()
    assert(ps.length === 1, '回到 1 个档案')
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf-8'))
    assert(cfg.activeProfileId === 'default', '删除激活档案后 active 回落到 default')

    console.log('5) 内核绑定')
    assert(!setProfileKernel('default', '9.9.9').ok, '未安装内核拒绝绑定')
    assert(setProfileKernel('default', null).ok, '解绑成功')
  } catch (e) {
    console.error('TEST CRASH:', e)
    failed++
  } finally {
    console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败')
    app.exit(failed === 0 ? 0 : 1)
  }
})
