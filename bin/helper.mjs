#!/usr/bin/env node
// cookie-sweep 的命令行：status（只看）/ dry-run（试算）/ apply（真删）/
// watch（等 pid 全退出再删，给哨兵用）。
//
//   node bin/helper.mjs                 # status
//   node bin/helper.mjs dry-run
//   node bin/helper.mjs apply --scope auth --keep 5 --vacuum
//   node bin/helper.mjs watch --pids 1234,5678 --timeout-hours 12
//
// 默认只删 dsh-auth-*；--scope local 连本机 origin 的其它 cookie 一起删。

import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { findCookieDbs } from '../lib/targets.js'
import { inspect, sweepAll, summarize, fmtBytes, sqliteAvailable } from '../lib/sweep.js'
import { paths, readLast, writeLast, appendLog, oneLine, SWEEP_HOME } from '../lib/report.js'
import { alivePids, readLock, lockIsFresh, releaseLock } from '../lib/sentinel.js'

const USAGE = `cookie-sweep —— 清掉 DSH 每次启动留下的 dsh-auth-* 登录 cookie

用法：
  node bin/helper.mjs [status]              看每个库有多少条（默认）
  node bin/helper.mjs dry-run               只算不清
  node bin/helper.mjs apply                 真清（删前每库备份）
  node bin/helper.mjs watch --pids 1,2      等这些 pid 全退出再清（哨兵用）

选项：
  --scope auth|local   默认 auth（只删 dsh-auth-*）；local 连本机 host 的其它 cookie 一起删
  --keep N             每个库保留几份备份（默认 5，0 = 不备份）
  --vacuum             清完 VACUUM 收缩库文件
  --json               机器可读输出
  --root DIR           报告/日志/备份目录（默认 ~/.dsh/cookie-sweep）
  --timeout-hours N    watch 的死线（默认 12）
  --help               显示这段说明

退出码：0 正常；1 有库失败；2 环境不支持（node < 22 没有 node:sqlite）。
`

const argv = process.argv.slice(2)
const cmd = argv.find((a) => !a.startsWith('-')) || 'status'
const has = (flag) => argv.includes(flag)
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}

const root = opt('root', SWEEP_HOME)
const scope = opt('scope', 'auth')
const keep = Number(opt('keep', 5)) || 5
const json = has('--json')
const vacuum = has('--vacuum')

function out(line = '') {
  process.stdout.write(`${line}\n`)
}

async function run() {
  if (has('--help') || has('-h') || cmd === 'help') {
    out(USAGE.trimEnd())
    return 0
  }

  if (!(await sqliteAvailable())) {
    out('这台机器的 node 没有 node:sqlite（需要 >= 22），清不了。')
    return 2
  }

  if (cmd === 'status') {
    const dbs = findCookieDbs()
    if (!dbs.length) {
      out('没找到 cookie 库（DSH 可能还没在这台机器上跑过）。')
      return 0
    }
    const rows = []
    for (const db of dbs) {
      try {
        const info = await inspect(db.path)
        rows.push({ ...db, ...info, ok: true })
      } catch (err) {
        rows.push({ ...db, ok: false, error: String(err?.message || err) })
      }
    }
    if (json) {
      out(JSON.stringify({ dbs: rows.map(({ columns, ...r }) => r) }, null, 2))
      return 0
    }
    for (const r of rows) {
      if (!r.ok) {
        out(`${r.label.padEnd(24)} ${r.error}`)
        continue
      }
      const hosts = r.hosts.slice(0, 3).map((h) => `${h.host}×${h.n}`).join(' ')
      out(
        `${r.label.padEnd(24)} 共 ${String(r.total).padStart(3)} 条 · dsh-auth ${String(r.auth).padStart(3)} 条 / ${fmtBytes(r.authBytes).padStart(8)}  ${hosts}`,
      )
    }
    const last = readLast(root)
    out(oneLine(last))
    return 0
  }

  if (cmd === 'watch') {
    const pids = String(opt('pids', '')).split(',').map(Number).filter(Boolean)
    const timeoutHours = Number(opt('timeout-hours', 12)) || 12
    const deadline = Date.now() + timeoutHours * 3600 * 1000
    out(`哨兵启动：监视 ${pids.join(',') || '(空)'}，最长 ${timeoutHours} 小时`)
    await new Promise((resolve) => {
      const tick = () => {
        if (!alivePids(pids).length || Date.now() > deadline) {
          clearInterval(timer)
          resolve()
        }
      }
      const timer = setInterval(tick, 2000)
      tick()
    })
    const still = alivePids(pids)
    if (still.length) {
      out(`超时，${still.join(',')} 还在，先不退不删`)
      return 0
    }
    out('目标进程都退了，开始清理')
    return applySweep(true)
  }

  if (cmd === 'dry-run' || cmd === 'apply') return applySweep(cmd === 'apply')

  out(`不认识的命令：${cmd}（可用：status / dry-run / apply / watch）`)
  return 2
}

// 真实退出时，Chromium 释放库可能要一两秒；库还被占着就再等一会儿，
// 别把「刚退出、文件还没放开」当成失败写进报告。
async function retryWhileLocked(runSweep) {
  // 退出后「马上又重开」很常见：新实例会立刻把库锁上，
  // 所以窗口给到 5 分钟（150 × 2s），别一看到锁就放弃。
  const tries = Number(process.env.DSH_SWEEP_LOCK_TRIES || 150)
  const gapMs = Number(process.env.DSH_SWEEP_LOCK_GAP_MS || 2000)
  let rows = await runSweep()
  for (let i = 1; i < tries; i += 1) {
    // 只重试「文件还在、只是被锁住」的库。
    // 文件已经不存在（用户删了目录/临时目录被清）就别等了，那不是锁，是没得清。
    const locked = rows.filter(
      (r) => !r.ok && /打不开/.test(String(r.error || '')) && (!r.file || existsSync(r.file)),
    )
    if (!locked.length) return rows
    out(`还有 ${locked.length} 个库被占用，${Math.round(gapMs / 1000)} 秒后重试（${i}/${tries - 1}）`)
    await new Promise((resolve) => setTimeout(resolve, gapMs))
    rows = await runSweep()
  }
  return rows
}

async function applySweep(apply) {
  const lock = readLock(root)
  if (lock && lockIsFresh(lock)) {
    out(`另一个清理进程还在跑（pid ${lock.pid}），这次跳过`)
    return 0
  }
  const p = paths(root)
  mkdirSync(p.root, { recursive: true })
  try {
    writeFileSync(p.lock, JSON.stringify({ pid: process.pid, cmd, at: Date.now() }, null, 2), { flag: 'wx' })
  } catch {
    // 锁文件存在但已过期：直接接管
    writeFileSync(p.lock, JSON.stringify({ pid: process.pid, cmd, at: Date.now() }, null, 2))
  }

  try {
    const dbs = findCookieDbs()
    if (!dbs.length) {
      out('没找到 cookie 库。')
      return 0
    }
    const rows = await retryWhileLocked(() =>
      sweepAll(dbs, {
        apply,
        scope,
        backupDir: apply ? p.backups : null,
        keep,
        vacuum,
      }),
    )
    const sum = summarize(rows)
    const report = {
      at: new Date().toISOString(),
      dryRun: !apply,
      scope,
      deleted: sum.deleted,
      freed: sum.freed,
      freedText: fmtBytes(sum.freed),
      totalBefore: sum.totalBefore,
      authBefore: sum.authBefore,
      failed: sum.failed,
      dbs: rows.map(({ path: file, ...r }) => ({ ...r, file: path.basename(path.dirname(path.dirname(file))) })),
    }
    // 报告一律落盘：失败也要留证据，否则下次没人知道这次为什么没清成
    writeLast(report, root)
    appendLog(oneLine(report), root)

    if (json) {
      out(JSON.stringify(report, null, 2))
    } else {
      for (const r of rows) {
        if (!r.ok) {
          out(`${r.label.padEnd(24)} ✗ ${r.error}`)
          continue
        }
        const verb = apply ? '删' : '将删'
        out(
          `${r.label.padEnd(24)} ${verb} ${String(r.deleted).padStart(3)} 条 / ${fmtBytes(r.freed).padStart(8)}  （清理前 ${r.totalBefore} 条）`,
        )
        if (r.backup) out(`  备份：${r.backup}`)
      }
      out('')
      out(apply ? `完成：删 ${sum.deleted} 条，释放约 ${fmtBytes(sum.freed)}` : `试算：将删 ${sum.deleted} 条，约 ${fmtBytes(sum.freed)}（什么都没动）`)
    }
    return sum.failed ? 1 : 0
  } finally {
    releaseLock(root)
  }
}

run()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err) => {
    out(`出错：${err?.stack || err}`)
    try {
      rmSync(paths(root).lock, { force: true })
    } catch {
      // ignore
    }
    process.exitCode = 1
  })
