#!/usr/bin/env node
/**
 * prune-dist 契约测试：分通道保留计划 + 版本排序 + 文件名识别。
 *
 * 为什么值得测：这是**会删文件**的脚本，正则或比较器写错会静默删掉不该删的东西
 * （旧实现就是因为正则不认 `-beta.N`，导致 beta 产物永不清理、累积 1.4GB）。
 * 重点覆盖：
 *   ① 正式版与预发布版分开计数，互不挤占
 *   ② 预发布排序不比字符串（R-22）：beta.10 > beta.2
 *   ③ 正式版 > 同 base 预发布版（0.9.4 排在 0.9.4-beta.4 之后 = 更新）
 *   ④ Setup / Portable / blockmap 归入同一版本；孤儿 blockmap 也纳管
 *   ⑤ 非版本化文件（latest.yml / win-unpacked / .icon-ico）绝不误判为产物
 *   ⑥ 默认保留数量（5 / 2）与文档一致——用断言锁住，防改动后文档与代码漂移
 *
 * 用法：node scripts/test/test-prune-dist.mjs（接入 npm test）
 */
import assert from 'node:assert/strict'
import {
  FILE_RE,
  DEFAULT_KEEP,
  DEFAULT_KEEP_BETA,
  isPrerelease,
  compareVersions,
  groupDistFiles,
  planChannel
} from '../prune-dist.mjs'

let passed = 0
let failed = 0
const t = (label, fn) => {
  try {
    fn()
    passed++
    console.log('  ✓', label)
  } catch (e) {
    failed++
    console.error('  ✗', label, '—', e.message)
  }
}

console.log('1) 默认保留数量（与 AGENT.md / 脚本注释一致）')
t('正式版默认 5、预发布默认 2', () => {
  assert.equal(DEFAULT_KEEP, 5)
  assert.equal(DEFAULT_KEEP_BETA, 2)
})

console.log('\n2) 文件名识别（FILE_RE / isPrerelease）')
t('正式版 Setup / Portable / blockmap 均识别', () => {
  assert.equal(FILE_RE.exec('DSH-Exoskeleton-Setup-0.9.4.exe')?.[1], '0.9.4')
  assert.equal(FILE_RE.exec('DSH-Exoskeleton-Portable-0.9.4.exe')?.[1], '0.9.4')
  assert.equal(FILE_RE.exec('DSH-Exoskeleton-Setup-0.9.4.exe.blockmap')?.[1], '0.9.4')
})
t('预发布版 -beta.N 识别（旧实现漏掉的关键用例）', () => {
  assert.equal(FILE_RE.exec('DSH-Exoskeleton-Setup-0.9.4-beta.4.exe')?.[1], '0.9.4-beta.4')
  assert.equal(FILE_RE.exec('DSH-Exoskeleton-Portable-0.9.3-beta.1.exe')?.[1], '0.9.3-beta.1')
  assert.equal(FILE_RE.exec('DSH-Exoskeleton-Setup-0.9.4-beta.4.exe.blockmap')?.[1], '0.9.4-beta.4')
})
t('-rc.N 也识别为预发布', () => {
  assert.equal(FILE_RE.exec('DSH-Exoskeleton-Setup-0.10.0-rc.2.exe')?.[1], '0.10.0-rc.2')
})
t('非产物文件不匹配', () => {
  for (const n of ['latest.yml', 'builder-debug.yml', 'win-unpacked', '.icon-ico', 'DSH-Exoskeleton.exe', 'DSH-Exoskeleton-Setup.exe']) {
    assert.equal(FILE_RE.exec(n), null, `不应匹配：${n}`)
  }
})
t('isPrerelease 判定', () => {
  assert.equal(isPrerelease('0.9.4'), false)
  assert.equal(isPrerelease('0.9.4-beta.4'), true)
  assert.equal(isPrerelease('0.9.4-rc.1'), true)
})

console.log('\n3) 版本比较（R-22：绝不用字符串比较）')
t('base 数字段逐段比较', () => {
  assert.equal(compareVersions('0.9.4', '0.9.3'), 1)
  assert.equal(compareVersions('0.9.3', '0.9.4'), -1)
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1)
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1)
})
t('★ beta.10 > beta.2（字符串比较会判反）', () => {
  assert.equal(compareVersions('0.9.4-beta.10', '0.9.4-beta.2'), 1)
  assert.equal(compareVersions('0.9.4-beta.2', '0.9.4-beta.10'), -1)
  assert.ok('0.9.4-beta.10' > '0.9.4-beta.2' === false, '前提：字符串比较确实是错的')
})
t('正式版 > 同 base 预发布版', () => {
  assert.equal(compareVersions('0.9.4', '0.9.4-beta.4'), 1)
  assert.equal(compareVersions('0.9.4-beta.4', '0.9.4'), -1)
})
t('高 base 的预发布 > 低 base 的正式版', () => {
  assert.equal(compareVersions('0.9.5-beta.1', '0.9.4'), 1)
})
t('相等', () => {
  assert.equal(compareVersions('0.9.4', '0.9.4'), 0)
  assert.equal(compareVersions('0.9.4-beta.1', '0.9.4-beta.1'), 0)
})
t('段少 < 段多（beta < beta.1）', () => {
  assert.equal(compareVersions('0.9.4-beta', '0.9.4-beta.1'), -1)
})

console.log('\n4) 分组：正式版与预发布版分开')
t('分入两条通道，且多文件归入同一版本', () => {
  const { stable, prerelease, otherFiles } = groupDistFiles([
    'DSH-Exoskeleton-Setup-0.9.4.exe',
    'DSH-Exoskeleton-Setup-0.9.4.exe.blockmap',
    'DSH-Exoskeleton-Portable-0.9.4.exe',
    'DSH-Exoskeleton-Setup-0.9.4-beta.4.exe',
    'latest.yml',
    'win-unpacked'
  ])
  assert.deepEqual([...stable.keys()], ['0.9.4'])
  assert.equal(stable.get('0.9.4').length, 3, 'Setup+blockmap+Portable 应同属 0.9.4')
  assert.deepEqual([...prerelease.keys()], ['0.9.4-beta.4'])
  assert.deepEqual(otherFiles.sort(), ['latest.yml', 'win-unpacked'])
})
t('孤儿 blockmap（无对应 exe）仍按版本纳管', () => {
  const { stable } = groupDistFiles(['DSH-Exoskeleton-Setup-0.8.1.exe.blockmap'])
  assert.deepEqual([...stable.keys()], ['0.8.1'])
})

console.log('\n5) 分通道保留计划')
t('正式版只留 5 个（默认），第 6 个起删', () => {
  const vs = Array.from({ length: 8 }, (_, i) => `0.9.${i}`)
  const { keep, prune } = planChannel(vs, DEFAULT_KEEP)
  assert.equal(keep.length, 5)
  assert.equal(prune.length, 3)
  assert.deepEqual(prune.sort(), ['0.9.0', '0.9.1', '0.9.2'].sort())
  assert.equal(keep[0], '0.9.7', 'keep 首位应是最新')
})
t('★ 预发布只留 2 个（默认），beta.10 不被误删', () => {
  const vs = ['0.9.4-beta.1', '0.9.4-beta.2', '0.9.4-beta.10', '0.9.3-beta.1', '0.9.4-beta.3']
  const { keep, prune } = planChannel(vs, DEFAULT_KEEP_BETA)
  assert.deepEqual(keep, ['0.9.4-beta.10', '0.9.4-beta.3'])
  assert.deepEqual(prune.sort(), ['0.9.3-beta.1', '0.9.4-beta.1', '0.9.4-beta.2'].sort())
})
t('正式版与预发布互不挤占（旧实现的关键缺陷）', () => {
  // 8 个正式版 + 5 个 beta：两条通道各自独立计数
  const names = []
  for (let i = 0; i < 8; i++) names.push(`DSH-Exoskeleton-Setup-0.9.${i}.exe`)
  for (let i = 1; i <= 5; i++) names.push(`DSH-Exoskeleton-Setup-0.9.4-beta.${i}.exe`)
  const { stable, prerelease } = groupDistFiles(names)
  const s = planChannel(stable.keys(), DEFAULT_KEEP)
  const p = planChannel(prerelease.keys(), DEFAULT_KEEP_BETA)
  assert.equal(s.prune.length, 3, '正式版删 3')
  assert.equal(p.prune.length, 3, '预发布删 3')
  assert.ok(p.keep.every((v) => v.includes('-')), 'keep 的 beta 必须都是预发布')
  assert.ok(s.keep.every((v) => !v.includes('-')), 'keep 的正式版必须都不带后缀')
})
t('数量不足时不删', () => {
  assert.deepEqual(planChannel(['0.9.4', '0.9.3'], 10).prune, [])
  assert.deepEqual(planChannel([], 3).prune, [])
})
t('keep=0 时全删', () => {
  assert.equal(planChannel(['0.9.4', '0.9.3'], 0).prune.length, 2)
})

console.log('\n6) 本机真实场景回归（v0.9.4 发布后实测清单）')
t('0.9.3-beta.1 与 0.9.4-beta.1..4 中只留最近 2 个', () => {
  const { prerelease } = groupDistFiles([
    'DSH-Exoskeleton-Portable-0.9.3-beta.1.exe',
    'DSH-Exoskeleton-Portable-0.9.4-beta.1.exe',
    'DSH-Exoskeleton-Portable-0.9.4-beta.2.exe',
    'DSH-Exoskeleton-Portable-0.9.4-beta.3.exe',
    'DSH-Exoskeleton-Portable-0.9.4-beta.4.exe',
    'DSH-Exoskeleton-Setup-0.9.3-beta.1.exe',
    'DSH-Exoskeleton-Setup-0.9.4-beta.1.exe',
    'DSH-Exoskeleton-Setup-0.9.4-beta.2.exe',
    'DSH-Exoskeleton-Setup-0.9.4-beta.3.exe',
    'DSH-Exoskeleton-Setup-0.9.4-beta.4.exe'
  ])
  const { keep, prune } = planChannel(prerelease.keys(), DEFAULT_KEEP_BETA)
  assert.deepEqual(keep, ['0.9.4-beta.4', '0.9.4-beta.3'])
  assert.deepEqual(prune.sort(), ['0.9.3-beta.1', '0.9.4-beta.1', '0.9.4-beta.2'].sort())
  assert.equal(prerelease.get('0.9.3-beta.1').length, 2, '同版本多文件要一起删')
})

console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
