// 哨兵/锁的纯逻辑测试：不真的起进程，只测判定。
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { lockIsFresh, pidAlive, alivePids, spawnSentinel, writeLock, readLock, releaseLock, LOCK_TTL_MS } from '../lib/sentinel.js'

let pass = 0
const ok = (cond, msg) => {
  if (!cond) throw new Error(`FAIL: ${msg}`)
  pass += 1
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'cookie-sweep-sentinel-'))
try {
  // 锁的新鲜度
  ok(lockIsFresh({ at: Date.now() - 1000 }), '刚写的锁算新鲜')
  ok(!lockIsFresh({ at: Date.now() - LOCK_TTL_MS - 1000 }), '过期的锁不算新鲜')
  ok(!lockIsFresh(null), '没有锁不算新鲜')

  // 写/读/删锁
  writeLock(tmp, { pid: 1234, cmd: 'apply' })
  const lock = readLock(tmp)
  ok(lock?.pid === 1234 && lockIsFresh(lock), '锁能读回且新鲜')
  releaseLock(tmp)
  ok(readLock(tmp) === null, '锁能删掉')

  // 进程存活判定
  ok(pidAlive(process.pid), '自己肯定活着')
  ok(!pidAlive(999999), '不存在的 pid 判死')
  ok(alivePids([process.pid, 999999]).length === 1, 'alivePids 只留活的')

  // 缺 node / 缺 helper 时不起哨兵，返回原因
  const noNode = spawnSentinel({ root: tmp, pids: [process.pid], nodeExe: 'C:\\nope\\node.exe', helper: 'C:\\nope\\helper.mjs' })
  ok(noNode.started === false, '缺 node 不起哨兵')
  ok(/node/i.test(noNode.detail), '缺 node 的提示要说清')

  const noHelper = spawnSentinel({ root: tmp, pids: [process.pid], nodeExe: process.execPath, helper: 'C:\\nope\\helper.mjs' })
  ok(noHelper.started === false, '缺 helper 不起哨兵')

  const noPid = spawnSentinel({ root: tmp, pids: [], procName: '', nodeExe: process.execPath, helper: import.meta.filename })
  ok(noPid.started === false, '既没有 pid 也没有进程名时不起哨兵')

  // 起一个真的哨兵（监视自己，2 秒后自己退出；这里只验证 spawn 成功）
  const res = spawnSentinel({
    root: tmp,
    pids: [process.pid],
    nodeExe: process.execPath,
    helper: path.join(path.dirname(import.meta.filename), '..', 'bin', 'helper.mjs'),
    timeoutHours: 1,
  })
  ok(res.started === true, `哨兵能起来（${res.mode}）`)
  ok(['wscript', 'node'].includes(res.mode), '哨兵模式是 wscript 或 node 回退')
  ok(existsSync(path.join(tmp, 'sentinel.json')), '写了哨兵信息文件')

  console.log(`sentinel.test.mjs OK {"pass":${pass},"mode":"${res.mode}"}`)
} finally {
  // 别把测试起的哨兵留在机器上等 120 秒：按 sentinel.json 里的 pid 收掉。
  try {
    const info = JSON.parse(readFileSync(path.join(tmp, 'sentinel.json'), 'utf8'))
    if (info?.pid) process.kill(Number(info.pid), 'SIGTERM')
  } catch {
    // 没有就算
  }
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {
    // ignore
  }
}
