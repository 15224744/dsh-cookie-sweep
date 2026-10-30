// 报告与日志：把每次清理的结果写一份 JSON，下次启动时打一行给宿主日志。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const SWEEP_HOME = path.join(
  process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh'),
  'cookie-sweep',
)

export function paths(root = SWEEP_HOME) {
  return {
    root,
    last: path.join(root, 'last-report.json'),
    log: path.join(root, 'sweep.log'),
    backups: path.join(root, 'backups'),
    lock: path.join(root, 'helper.lock'),
    sentinel: path.join(root, 'sentinel.json'),
  }
}

export function readLast(root = SWEEP_HOME) {
  try {
    const raw = readFileSync(paths(root).last, 'utf8').replace(/^\uFEFF/, '')
    const data = JSON.parse(raw)
    return data && typeof data === 'object' ? data : null
  } catch {
    return null
  }
}

export function writeLast(report, root = SWEEP_HOME) {
  const p = paths(root)
  mkdirSync(p.root, { recursive: true })
  writeFileSync(p.last, JSON.stringify(report, null, 2), 'utf8')
  return p.last
}

export function appendLog(line, root = SWEEP_HOME) {
  const p = paths(root)
  mkdirSync(p.root, { recursive: true })
  appendFileSafe(p.log, `${new Date().toISOString()} ${line}\n`)
}

let appendFileSafe = (file, text) => {
  try {
    writeFileSync(file, text, { flag: 'a', encoding: 'utf8' })
  } catch {
    // 日志写不进去不该让清理失败
  }
}

// 给宿主日志/终端的一行摘要。
export function oneLine(report) {
  if (!report) return 'cookie-sweep：还没有清理记录'
  const when = report.at ? new Date(report.at).toLocaleString('zh-CN', { hour12: false }) : '未知时间'
  if (report.dryRun) return `cookie-sweep：${when} 试算 ${report.deleted} 条（未删除）`
  const tail = report.failed ? `，${report.failed} 个库失败` : ''
  return `cookie-sweep：${when} 清掉 ${report.deleted} 条登录 cookie，释放约 ${report.freedText || '0 B'}${tail}`
}
