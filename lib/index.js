// dsh-cookie-sweep —— 顺手扫掉 DSH 登录留下的 dsh-auth-* cookie。
//
// 背景：DSH 的 client-connection 在 HTTP 下把 authority（host:port）当受众，
// 每次启动端口都变，于是每次签发一条新的 dsh-auth-<sha256(host:port)> cookie，
// 有效期 30 天、谁都不清。一条 cookie 的请求头约 216 字节，攒到 16384 字节
// （约 75 次启动）请求头就超标，浏览器报 431，表现成「DSH 打不开」。
//
// 做法：启动时布置一个脱离的哨兵，等宿主进程退出（库解锁）后清一次。
// 默认只删 dsh-auth-*，账号域 cookie 一条不动；删前每库单独备份。
// 不联网、不 kill 任何进程、出错只记日志，绝不拖累启动。

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findCookieDbs } from './targets.js'
import { inspect, sqliteAvailable, fmtBytes } from './sweep.js'
import { readLast, oneLine, appendLog, SWEEP_HOME } from './report.js'
import { spawnSentinel, readLock, lockIsFresh } from './sentinel.js'

const NAME = 'dsh-cookie-sweep'
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HELPER = path.join(PACKAGE_ROOT, 'bin', 'helper.mjs')

function apply(ctx, config = {}) {
  const logger = ctx?.logger
  const say = (level, line) => {
    try {
      const fn = logger?.[level]
      if (typeof fn === 'function') fn.call(logger, `[${NAME}] ${line}`)
    } catch {
      // 日志失败不影响任何事
    }
  }

  const opts = {
    enabled: config?.enabled !== false,
    scope: config?.scope === 'local' ? 'local' : 'auth',
    keepBackups: Number(config?.keepBackups) || 5,
    timeoutHours: Number(config?.timeoutHours) || 12,
    root: config?.root || SWEEP_HOME,
  }

  // 上次的结果先说一句，方便在宿主日志里对上号。
  try {
    const last = readLast(opts.root)
    if (last) say('info', oneLine(last))
  } catch {
    // 报告读不出来就算了
  }

  if (!opts.enabled) {
    say('info', '已在配置里关掉（enabled: false），不布置哨兵')
    return
  }

  const dbs = findCookieDbs()
  if (!dbs.length) {
    say('info', '没找到 cookie 库，不布置哨兵')
    return
  }

  // 顺带把「现在有多少条」打进日志：只读尝试，读不到就算了。
  void (async () => {
    try {
      if (!(await sqliteAvailable())) {
        say('warn', '这台机器的 node 没有 node:sqlite（需要 >= 22），清理功能不可用')
        return
      }
      const rows = []
      for (const db of dbs) {
        try {
          const info = await inspect(db.path)
          rows.push(`${db.label} ${info.total} 条（dsh-auth ${info.auth} 条 / ${fmtBytes(info.authBytes)}）`)
        } catch (err) {
          rows.push(`${db.label} 读不到（${String(err?.message || err).slice(0, 60)}）`)
        }
      }
      if (rows.length) say('info', `当前 cookie 库：${rows.join('；')}`)
    } catch {
      // 只是诊断，失败不影响清理
    }
  })()

  try {
    const lock = readLock(opts.root)
    if (lock && lockIsFresh(lock)) {
      say('info', `已有一个清理进程在跑（pid ${lock.pid}），这次跳过`)
      return
    }
    const nodeExe = process.env.DSH_COOKIE_SWEEP_NODE || process.execPath
    const res = spawnSentinel({
      root: opts.root,
      pids: [process.pid, ...(Array.isArray(config?.pids) ? config.pids : [])],
      nodeExe,
      helper: HELPER,
      timeoutHours: opts.timeoutHours,
    })
    if (res.started) {
      say('info', `${res.detail}；DSH 退出后会清一次（scope=${opts.scope}，最多留 ${opts.keepBackups} 份备份）`)
      appendLog(`sentinel started (${res.mode}) pids=${process.pid}`, opts.root)
    } else {
      say('warn', `哨兵没起来：${res.detail}`)
    }
  } catch (err) {
    say('warn', `布置哨兵失败：${String(err?.message || err)}`)
  }
}

export default {
  name: NAME,
  apply,
}
