// 库操作：数、备份、删。全部走 node:sqlite，没有网络请求。
//
// 默认只删名字以 dsh-auth- 开头的行——那是 DSH 每次启动签发的登录 cookie，
// 名字里带 authority（host:port），端口变了名字就变，所以越攒越多。
// 想连本机其它 origin 的 cookie 一起清，把 scope 设成 'local'。

import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

export const AUTH_PREFIX = 'dsh-auth-'
export const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1', 'dsh-app']

const BYTES = `length(name) + length(value) + coalesce(length(encrypted_value), 0) + 48`

let sqliteModule
async function sqlite() {
  if (sqliteModule !== undefined) return sqliteModule
  try {
    sqliteModule = await import('node:sqlite')
  } catch {
    sqliteModule = null
  }
  return sqliteModule
}

export async function sqliteAvailable() {
  const mod = await sqlite()
  return Boolean(mod?.DatabaseSync)
}

async function open(file, { readOnly }) {
  const mod = await sqlite()
  if (!mod?.DatabaseSync) throw new Error('这台机器的 node 没有 node:sqlite（需要 >= 22）')
  try {
    return new mod.DatabaseSync(file, { readOnly })
  } catch (err) {
    const msg = String(err?.message || err)
    if (/locked|busy|unable to open|cannot open/i.test(msg)) {
      throw new Error(`打不开 ${path.basename(file)}（多半是 DSH 还在跑，退出后再试）：${msg}`)
    }
    throw new Error(`打不开 ${path.basename(file)}：${msg}`)
  }
}

function columnSet(db) {
  return new Set(db.prepare('PRAGMA table_info(cookies)').all().map((r) => String(r.name)))
}

function isLocalHost(host, locals) {
  const h = String(host || '')
  return locals.some((c) => h === c || h.endsWith(`.${c}`))
}

// 只看不动。库被占用时抛错，由调用方记进报告。
export async function inspect(file) {
  const db = await open(file, { readOnly: true })
  try {
    const cols = columnSet(db)
    if (!cols.has('name')) throw new Error('不是 Chromium cookie 库（没有 cookies 表）')
    const total = Number(db.prepare('SELECT count(*) AS n FROM cookies').get()?.n || 0)
    const authRow = db.prepare(`SELECT count(*) AS n, coalesce(sum(${BYTES}), 0) AS b FROM cookies WHERE name LIKE ?`).get(`${AUTH_PREFIX}%`)
    const hosts = db
      .prepare('SELECT host_key, count(*) AS n FROM cookies GROUP BY host_key ORDER BY n DESC LIMIT 12')
      .all()
      .map((r) => ({ host: String(r.host_key), n: Number(r.n) }))
    return { total, auth: Number(authRow?.n || 0), authBytes: Number(authRow?.b || 0), hosts, columns: [...cols] }
  } finally {
    db.close()
  }
}

// dry-run 与真删共用同一套判定；返回要删的行（含定位用的列）。
function candidates(db, cols, { scope = 'auth', localHosts = LOCAL_HOSTS }) {
  const where = scope === 'local' ? '1' : 'name LIKE ?'
  const stmt = db.prepare(`SELECT host_key, name, path, ${BYTES} AS bytes FROM cookies WHERE ${where}`)
  const rows = scope === 'local' ? stmt.all() : stmt.all(`${AUTH_PREFIX}%`)
  return rows
    .map((r) => ({ host: String(r.host_key), name: String(r.name), path: String(r.path), bytes: Number(r.bytes || 0) }))
    .filter((r) => (scope === 'local' ? isLocalHost(r.host, localHosts) : true))
}

export function backup(file, { dir, label = 'db', keep = 5, now = new Date() } = {}) {
  if (!dir) return null
  mkdirSync(dir, { recursive: true })
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const safe = String(label).replace(/[^\w.-]+/g, '_')
  const dest = path.join(dir, `Cookies-${safe}-${stamp}.db`)
  copyFileSync(file, dest)
  const size = statSync(dest).size
  // 名字里带 ISO 时间戳，按名字倒序就是按时间倒序；新备份永远不删。
  const olds = readdirSync(dir)
    .filter((f) => f.startsWith(`Cookies-${safe}-`))
    .filter((f) => path.join(dir, f) !== dest)
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  for (const stale of olds.slice(Math.max(0, keep - 1))) {
    try {
      rmSync(path.join(dir, stale), { force: true })
    } catch {
      // 删旧备份失败不该影响主流程
    }
  }
  return { path: dest, size }
}

// 真删。apply=false 时只算数。
export async function sweep(
  file,
  { apply = false, scope = 'auth', localHosts = LOCAL_HOSTS, backupDir, label, keep = 5, vacuum = false, now } = {},
) {
  const db = await open(file, { readOnly: !apply })
  try {
    const cols = columnSet(db)
    const rows = candidates(db, cols, { scope, localHosts })
    const freed = rows.reduce((n, r) => n + r.bytes, 0)
    if (!apply || rows.length === 0) {
      return { deleted: 0, candidate: rows.length, freed: apply ? 0 : freed, backup: null, scope }
    }

    const backupInfo = backupDir ? backup(file, { dir: backupDir, label: label || 'db', keep, now }) : null

    // 新版 Chromium 的 cookies 表按 (host,name,path,top_frame_site_key) 唯一；
    // 老库没有这一列，就按 (host,name,path) 删。
    const del = cols.has('top_frame_site_key')
      ? db.prepare('DELETE FROM cookies WHERE host_key = ? AND name = ? AND path = ? AND top_frame_site_key = (SELECT top_frame_site_key FROM cookies WHERE host_key = ? AND name = ? AND path = ? LIMIT 1)')
      : db.prepare('DELETE FROM cookies WHERE host_key = ? AND name = ? AND path = ?')

    db.exec('BEGIN')
    try {
      for (const r of rows) {
        if (cols.has('top_frame_site_key')) del.run(r.host, r.name, r.path, r.host, r.name, r.path)
        else del.run(r.host, r.name, r.path)
      }
      db.exec('COMMIT')
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // ignore
      }
      throw err
    }

    if (vacuum) {
      try {
        db.exec('VACUUM')
      } catch {
        // VACUUM 失败不影响删除结果
      }
    }
    const after = Number(db.prepare('SELECT count(*) AS n FROM cookies').get()?.n || 0)
    return { deleted: rows.length, candidate: rows.length, freed, after, backup: backupInfo, scope }
  } finally {
    db.close()
  }
}

// 批量：每个库单独出结果，一个库坏了不影响其它库。
export async function sweepAll(dbs, opts = {}) {
  const out = []
  for (const db of dbs) {
    const started = Date.now()
    try {
      const before = await inspect(db.path)
      const res = await sweep(db.path, { ...opts, label: db.label })
      out.push({
        label: db.label,
        path: db.path,
        ok: true,
        totalBefore: before.total,
        authBefore: before.auth,
        deleted: res.deleted,
        freed: res.freed,
        backup: res.backup?.path || null,
        ms: Date.now() - started,
      })
    } catch (err) {
      out.push({
        label: db.label,
        path: db.path,
        ok: false,
        error: String(err?.message || err),
        ms: Date.now() - started,
      })
    }
  }
  return out
}

export function summarize(rows) {
  return rows.reduce(
    (acc, r) => {
      if (!r.ok) acc.failed += 1
      acc.deleted += r.deleted || 0
      acc.freed += r.freed || 0
      acc.totalBefore += r.totalBefore || 0
      acc.authBefore += r.authBefore || 0
      return acc
    },
    { deleted: 0, freed: 0, totalBefore: 0, authBefore: 0, failed: 0 },
  )
}

export function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}
