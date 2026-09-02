// 端到端验证（阶段 B 验收）：内置 Node 运行时真实下载 → 托管内核真实安装 → dsh web 启动 + 健康检查
// 运行：node node_modules/esbuild/bin/esbuild src/main/runtime-manager.ts --bundle --platform=node --external:electron --format=cjs --outfile=scripts/out/runtime-manager.cjs
//       electron scripts/probe/e2e-kernel.cjs
// 注意：需要网络（nodejs.org + npm registry），耗时数分钟；使用独立 DSH_HOME，不触碰 ~/.dsh
const { app } = require('electron')
const { spawn } = require('child_process')
const http = require('http')
const fs = require('fs')
const path = require('path')

app.setName('DshE2ETest')
let passed = 0
let failed = 0
const assert = (cond, label) => {
  if (cond) { passed++; console.log('  ✓', label) } else { failed++; console.error('  ✗', label) }
}

app.whenReady().then(async () => {
  const dshHome = path.join(app.getPath('userData'), 'e2e-dsh-home')
  try {
    const { runtimeManager } = require('../out/runtime-manager.cjs')
    const { kernelManager } = require('../out/kernel-manager.cjs')
    runtimeManager.init()
    kernelManager.init()

    console.log('1) 下载内置 Node 运行时（真实下载 ~30MB）')
    const t0 = Date.now()
    const d = await runtimeManager.download()
    const dsecs = ((Date.now() - t0) / 1000).toFixed(0)
    const rver = await runtimeManager.readVersion()
    const already = !!d.error && d.error.includes('已安装')
    assert(d.ok || already, '下载安装: ' + (already ? '已安装（跳过）' : dsecs + 's ' + (d.ok ? rver : d.error)))

    console.log('2) 运行时自检')
    assert(!!rver && rver.startsWith('v2'), 'node --version 有效: ' + rver)
    const nodeExe = runtimeManager.getNodeExe()
    assert(!!nodeExe && fs.existsSync(nodeExe), 'node.exe 存在: ' + nodeExe)

    console.log('3) 查询可用内核版本（npm registry）')
    const avail = await kernelManager.listAvailable()
    assert(avail.length > 0, '版本列表非空（' + avail.length + ' 个）')
    const latest = avail[0].version
    console.log('    最新内核版本: v' + latest)

    console.log('4) 安装托管内核 v' + latest + '（真实 npm install，依赖树较大，耗时数分钟）')
    const t1 = Date.now()
    const inst = await kernelManager.install(latest)
    const isecs = ((Date.now() - t1) / 1000).toFixed(0)
    assert(inst.ok, '安装 ' + isecs + 's: ' + (inst.error || 'ok'))
    if (!inst.ok) throw new Error('kernel install failed: ' + inst.error)
    const binJs = kernelManager.binJsFor(latest)
    assert(!!binJs && fs.existsSync(binJs), 'bin.js 存在: ' + binJs)

    console.log('5) 内核版本自检（内置 Node 执行）')
    const kv = await runCapture(nodeExe, [binJs, '--version'])
    assert(kv.trim().length > 0, 'dsh --version: ' + kv.trim().slice(0, 60))

    console.log('6) 端到端启动 dsh web（隔离 DSH_HOME）+ 健康检查')
    fs.mkdirSync(dshHome, { recursive: true })
    const port = await startDshAndGetPort(nodeExe, binJs, dshHome)
    assert(port > 0, 'dsh web 启动并解析端口: ' + port)
    if (port > 0) {
      const ok = await healthCheck(port)
      assert(ok, '健康检查通过: http://127.0.0.1:' + port + '/health')
    } else {
      console.log('    （dsh web 未在 120s 内就绪，跳过健康检查）')
    }
  } catch (e) {
    console.error('TEST CRASH:', e)
    failed++
  } finally {
    console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败')
    app.exit(failed === 0 ? 0 : 1)
  }
})

function runCapture(cmd, args) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let acc = ''
    child.stdout.on('data', (c) => (acc += c.toString()))
    child.on('close', () => resolvePromise(acc))
    child.on('error', () => resolvePromise(''))
  })
}

function startDshAndGetPort(cmd, binJs, dshHome) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, [binJs, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
      env: { ...process.env, DSH_HOME: dshHome },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let buf = ''
    const re = /dsh web: http:\/\/127\.0\.0\.1:(\d+)/i
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* noop */ }
      resolvePromise(0)
    }, 150_000)
    child.stdout.on('data', (c) => {
      buf += c.toString()
      const line = c.toString().trim()
      if (line) console.log('    [dsh]', line.slice(0, 160))
      const m = buf.match(re)
      if (m) {
        clearTimeout(timer)
        resolvePromise(Number(m[1]))
      }
    })
    child.on('exit', () => {
      clearTimeout(timer)
      resolvePromise(0)
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolvePromise(0)
    })
  })
}

function healthCheck(port) {
  return new Promise((resolvePromise) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 10_000 }, (res) => {
      res.resume()
      resolvePromise(res.statusCode !== undefined && res.statusCode < 500)
    })
    req.on('timeout', () => { req.destroy(); resolvePromise(false) })
    req.on('error', () => resolvePromise(false))
  })
}
