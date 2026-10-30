// 哨兵：DSH 退出之后才清（运行中库是锁着的）。
//
// Windows 上用一个 wscript 跑的 VBS（GUI 子系统，没有控制台窗口，约 5MB），
// 每 2 秒查一次我们关心的 pid；全没了就隐藏起 node helper 清一次，然后自己退。
// 没有 wscript（或被策略禁掉）时退回「node 自己 detach 起来轮询」。
//
// 和第三方实现不同的两点：
//   1. 哨兵有 12 小时死线，过了自己退，绝不会留一个永久的幽灵进程；
//   2. 不主动 kill 任何进程——锁只用来避免两个 helper 同时写同一个库。

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { paths } from './report.js'

export const LOCK_TTL_MS = 30 * 60 * 1000
export const DEFAULT_TIMEOUT_HOURS = 12

export function readLock(root) {
  try {
    const data = JSON.parse(readFileSync(paths(root).lock, 'utf8'))
    return data && typeof data === 'object' ? data : null
  } catch {
    return null
  }
}

export function lockIsFresh(lock, now = Date.now()) {
  if (!lock?.at) return false
  return now - Number(lock.at) < LOCK_TTL_MS
}

export function writeLock(root, data) {
  const p = paths(root)
  mkdirSync(p.root, { recursive: true })
  writeFileSync(p.lock, JSON.stringify({ ...data, at: Date.now() }, null, 2), 'utf8')
}

export function releaseLock(root) {
  try {
    rmSync(paths(root).lock, { force: true })
  } catch {
    // ignore
  }
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

export function alivePids(pids) {
  return pids.filter((p) => Number.isInteger(Number(p)) && pidAlive(Number(p)))
}

export function writeSentinelInfo(root, info) {
  const p = paths(root)
  mkdirSync(p.root, { recursive: true })
  writeFileSync(p.sentinel, JSON.stringify({ ...info, at: Date.now() }, null, 2), 'utf8')
}

export function readSentinelInfo(root) {
  try {
    return JSON.parse(readFileSync(paths(root).sentinel, 'utf8'))
  } catch {
    return null
  }
}

function wscriptExe() {
  const win = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe')
  return existsSync(win) ? win : null
}

// 起一个脱离的哨兵。返回 { started, mode, detail }。
// procName：多进程 Electron 里单个 pid 不可靠，等「整个应用都不在了」再清。
export function spawnSentinel({ root, pids, nodeExe, helper, timeoutHours = DEFAULT_TIMEOUT_HOURS, procName = 'DeepSeek Harness.exe' } = {}) {
  const list = [...new Set((pids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))]
  if (!list.length && !procName) return { started: false, mode: 'none', detail: '没有可监视的 pid' }
  if (!nodeExe || !existsSync(nodeExe)) return { started: false, mode: 'none', detail: `找不到 node：${nodeExe}` }
  if (!helper || !existsSync(helper)) return { started: false, mode: 'none', detail: `找不到 helper：${helper}` }

  // 已经有一个哨兵在盯着这个宿主进程：不再起第二个（否则每次启动都会多留一个）。
  const prev = readSentinelInfo(root)
  if (prev?.pid && pidAlive(Number(prev.pid))) {
    const owner = Number(prev.ownerPid || 0)
    if (!owner || pidAlive(owner)) {
      return { started: false, mode: prev.mode || 'wscript', detail: `已有哨兵 pid ${prev.pid} 在盯 ${(prev.pids || []).join(',')}，这次不重复起` }
    }
    // 上一轮宿主的哨兵还活着：**不能杀**。它正等着给自己的那一轮清库
    // （刚退出又重开时还要多等 120 秒才动手）。再起一个新的盯着本轮就行，
    // 两个哨兵不会互相踩：helper 有锁，谁先抢到谁清，另一个看到锁就跳过。
  }

  const deadline = Date.now() + timeoutHours * 3600 * 1000
  const p = paths(root)
  mkdirSync(p.root, { recursive: true })

  const script = path.join(path.dirname(helper), 'watch.vbs')
  const wp = process.platform === 'win32' ? wscriptExe() : null
  if (wp && existsSync(script)) {
    const child = spawn(
      wp,
      ['//nologo', '//B', script, list.join(','), nodeExe, helper, p.log, String(timeoutHours), root, procName],
      { detached: true, stdio: 'ignore', windowsHide: true },
    )
    child.unref()
    writeSentinelInfo(root, { mode: 'wscript', pids: list, deadline, pid: child.pid, ownerPid: process.pid })
    return { started: true, mode: 'wscript', detail: `哨兵 pid ${child.pid}，监视 ${list.join(',')}` }
  }

  // 退路：node 自己轮询。多占几十 MB，但没有 wscript 也能工作。
  const child = spawn(nodeExe, [helper, 'watch', '--pids', list.join(','), '--timeout-hours', String(timeoutHours), '--root', root], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  writeSentinelInfo(root, { mode: 'node', pids: list, deadline, pid: child.pid, ownerPid: process.pid })
  return { started: true, mode: 'node', detail: `哨兵（node 回退）pid ${child.pid}` }
}
