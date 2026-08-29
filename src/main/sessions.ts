/**
 * 会话管理（P0：总览/会话页数据源）
 * - 扫描 ~/.dsh/sessions/<workspace>/session-<uuid>/session.jsonl.zstd
 * - 复用 zstd-worker 的 headInfo 提取标题/cwd/首条用户消息（与通知链路同源）
 * - 提供打开（唤起窗口 + 在 Web UI 定位）、删除、导出
 */
import fs from 'node:fs'
import path from 'node:path'
import { dialog, shell } from 'electron'
import { logger } from './logger'
import { dshManager } from './dsh-manager'
import { windowManager } from './window-manager'
import { notificationHub } from './notification-hub'
import { zstdWorker } from './zstd-worker'
import { decodeWorkspaceName, projectNameFromPath, truncate } from '../shared/session-jsonl'
import type { SessionInfo } from '../shared/types'

/** 列表硬上限：防止海量会话把面板/主进程拖垮（本地会话一般远小于此值） */
const MAX_LIST = 500
/** headInfo 并发数（zstd 解压是 CPU 活，限制并发避免主进程/worker 过载） */
const HEAD_CONCURRENCY = 6

function sessionsRoot(): string {
  return path.join(dshManager.resolveDshHome(), 'sessions')
}

/** 路径安全校验：确保目录位于 sessions 根内，防止越权删除/读取任意路径 */
function assertUnderSessionsRoot(target: string): void {
  const root = path.resolve(sessionsRoot())
  const resolved = path.resolve(target)
  const rel = path.relative(root, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('非法会话路径：不在 sessions 目录内')
  }
}

interface Candidate {
  uuid: string
  workspace: string
  file: string
  sessionDir: string
  size: number
  modifiedAt: number
}

/** 扫描全部会话目录（只做 readdir + stat，不做解压），返回按修改时间倒序的候选 */
async function scanCandidates(limit?: number, uuidFilter?: string): Promise<Candidate[]> {
  const root = sessionsRoot()
  const candidates: Candidate[] = []
  let workspaceDirs: string[] = []
  try {
    workspaceDirs = await fs.promises.readdir(root)
  } catch {
    return candidates
  }
  for (const ws of workspaceDirs) {
    const wsDir = path.join(root, ws)
    let sessionDirs: string[] = []
    try {
      if (!(await fs.promises.stat(wsDir)).isDirectory()) continue
      sessionDirs = await fs.promises.readdir(wsDir)
    } catch {
      continue
    }
    for (const s of sessionDirs) {
      if (!s.startsWith('session-')) continue
      const sessionDir = path.join(wsDir, s)
      const file = path.join(sessionDir, 'session.jsonl.zstd')
      let st: fs.Stats
      try {
        st = await fs.promises.stat(file)
      } catch {
        continue
      }
      if (st.size <= 0) continue
      const uuid = s.replace(/^session-/, '')
      if (uuidFilter && uuid !== uuidFilter) continue
      candidates.push({
        uuid,
        workspace: ws,
        file,
        sessionDir,
        size: st.size,
        modifiedAt: st.mtimeMs
      })
    }
  }
  candidates.sort((a, b) => b.modifiedAt - a.modifiedAt)
  // uuid 精确查找时不做 limit 截断（匹配项本就唯一，避免排序后把目标切掉）
  if (uuidFilter) return candidates.slice(0, MAX_LIST)
  if (typeof limit === 'number' && limit > 0) return candidates.slice(0, Math.min(limit, MAX_LIST))
  return candidates.slice(0, MAX_LIST)
}

/** 从候选列表取 headInfo 填充标题/项目（带并发限制，避免一次性压垮 zstd worker） */
async function hydrate(candidates: Candidate[]): Promise<SessionInfo[]> {
  const result: SessionInfo[] = new Array(candidates.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= candidates.length) return
      const c = candidates[i]
      let title = ''
      let project = ''
      let firstUserText = ''
      const head = await zstdWorker.request('headInfo', { file: c.file })
      if (head.ok) {
        const cwd = head.cwd ?? ''
        title = head.title ?? ''
        firstUserText = head.firstUserText ?? ''
        project = cwd ? projectNameFromPath(cwd) : ''
      }
      if (!title) title = `会话 ${c.uuid.slice(0, 8)}`
      if (!project) project = projectNameFromPath(decodeWorkspaceName(c.workspace))
      result[i] = {
        uuid: c.uuid,
        workspace: c.workspace,
        project,
        title: truncate(title, 80),
        firstUserText: truncate(firstUserText, 120),
        file: c.file,
        sessionDir: c.sessionDir,
        size: c.size,
        modifiedAt: c.modifiedAt
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(HEAD_CONCURRENCY, candidates.length) }, () => worker()))
  return result.filter((x): x is SessionInfo => !!x)
}

/** 列出会话摘要（按修改时间倒序；limit 省略或 0 = 最多 MAX_LIST 条） */
export async function listSessions(limit?: number): Promise<SessionInfo[]> {
  const candidates = await scanCandidates(limit)
  return hydrate(candidates)
}

/** 按 uuid 精确查找单个会话 */
async function findSession(uuid: string): Promise<SessionInfo | null> {
  if (!uuid) return null
  const candidates = await scanCandidates(1, uuid)
  if (candidates.length === 0) return null
  const hydrated = await hydrate(candidates)
  return hydrated[0] ?? null
}

/** 在 DSH Web UI 中打开会话：唤起窗口 → 优先插件程序化激活 → DOM 兜底 */
export async function openSession(uuid: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const session = await findSession(uuid)
    if (!session) return { ok: false, error: '会话不存在：' + uuid }
    if (dshManager.getState().status !== 'running') {
      return { ok: false, error: 'DSH 服务未运行，无法打开会话（请先启动服务）' }
    }
    windowManager.show()
    if (!notificationHub.requestActivate(uuid)) {
      windowManager.activateSessionInWebUi(session.title, session.firstUserText, uuid)
    }
    return { ok: true }
  } catch (err) {
    logger.warn('open session failed', err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 删除会话目录（含 session.jsonl.zstd；安全校验防止越权） */
export async function removeSession(uuid: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const session = await findSession(uuid)
    if (!session) return { ok: false, error: '会话不存在：' + uuid }
    assertUnderSessionsRoot(session.sessionDir)
    await fs.promises.rm(session.sessionDir, { recursive: true, force: true })
    logger.info('session removed', { uuid })
    return { ok: true }
  } catch (err) {
    logger.warn('remove session failed', err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 导出会话数据文件：弹出保存对话框后复制 session.jsonl.zstd */
export async function exportSession(uuid: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    const session = await findSession(uuid)
    if (!session) return { ok: false, error: '会话不存在：' + uuid }
    const win = windowManager.getWindow()
    const safeName = (session.title || session.uuid).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
    const opts: Electron.SaveDialogOptions = {
      title: '导出会话',
      defaultPath: `${safeName}.jsonl.zstd`,
      filters: [
        { name: 'DSH 会话数据', extensions: ['zstd'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    }
    const { canceled, filePath } = win
      ? await dialog.showSaveDialog(win, opts)
      : await dialog.showSaveDialog(opts)
    if (canceled || !filePath) return { ok: false, error: '已取消' }
    await fs.promises.copyFile(session.file, filePath)
    logger.info('session exported', { uuid, filePath })
    return { ok: true, path: filePath }
  } catch (err) {
    logger.warn('export session failed', err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 在系统资源管理器中显示会话数据文件（快速定位用） */
export async function showSessionInFolder(uuid: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const session = await findSession(uuid)
    if (!session) return { ok: false, error: '会话不存在：' + uuid }
    shell.showItemInFolder(session.file)
    return { ok: true }
  } catch (err) {
    logger.warn('show session folder failed', err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 确保 session 相关 IPC 仅接受字符串参数（渲染进程来源的防御） */
export function isSessionId(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]+$/.test(v)
}
