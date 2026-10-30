// cookie-sweep 的库操作测试：用临时目录造一个同构的 Cookies 库，不碰真库。
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { inspect, sweep, backup, summarize, sqliteAvailable, fmtBytes, AUTH_PREFIX } from '../lib/sweep.js'
import { findCookieDbs } from '../lib/targets.js'

let pass = 0
const ok = (cond, msg) => {
  if (!cond) throw new Error(`FAIL: ${msg}`)
  pass += 1
}

function makeDb(file) {
  mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE cookies (
      host_key TEXT, name TEXT, path TEXT, value TEXT,
      encrypted_value BLOB, creation_utc INTEGER, top_frame_site_key TEXT
    );
  `)
  return db
}

function seed(db, rows) {
  const stmt = db.prepare(
    'INSERT INTO cookies (host_key, name, path, value, encrypted_value, creation_utc, top_frame_site_key) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  for (const r of rows) stmt.run(r.host, r.name, r.path || '/', r.value || '', r.blob ?? null, r.ct ?? 1, r.top || '')
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'cookie-sweep-test-'))
try {
  ok(await sqliteAvailable(), 'node:sqlite 可用')

  // —— 造两个库：默认库 + 一个分区库
  const dataDir = path.join(tmp, 'appdata', '@deepseek-ai', 'dsh-desktop')
  const defaultDb = path.join(dataDir, 'Network', 'Cookies')
  const partDir = path.join(dataDir, 'Partitions', 'persist-dsh-platform-abc', 'Network')
  const partDb = path.join(partDir, 'Cookies')

  const d1 = makeDb(defaultDb)
  seed(d1, [
    ...Array.from({ length: 9 }, (_, i) => ({
      host: '127.0.0.1',
      name: `${AUTH_PREFIX}${String(i).padStart(4, '0')}`,
      value: 'v1.' + 'x'.repeat(150),
      top: '127.0.0.1',
    })),
    { host: '.bilibili.com', name: 'SESSDATA', value: 'secret' },
    { host: '.deepseek.com', name: '_ga', value: 'GA1.1' },
    { host: '127.0.0.1', name: 'not-auth-keep-me', value: 'k' },
  ])
  d1.close()

  const d2 = makeDb(partDb)
  seed(d2, [
    { host: '127.0.0.1', name: `${AUTH_PREFIX}part`, value: 'v1.abc' },
    { host: '.bilibili.com', name: 'bili_jct', value: 'j' },
  ])
  d2.close()

  // —— 发现逻辑：默认库 + 分区库都要找到
  const found = findCookieDbs({ APPDATA: path.join(tmp, 'appdata') })
  ok(found.length === 2, `找到 2 个库（实际 ${found.length}）`)
  ok(found.some((d) => d.kind === 'default'), '有默认库')
  ok(found.some((d) => d.kind === 'partition' && d.label.includes('abc')), '有分区库')

  // —— 只读统计
  const info = await inspect(defaultDb)
  ok(info.total === 12, `默认库共 12 条（实际 ${info.total}）`)
  ok(info.auth === 9, `dsh-auth 9 条（实际 ${info.auth}）`)
  ok(info.authBytes > 9 * 150, 'dsh-auth 字节数算得出来')

  // —— dry-run 不动库
  const dry = await sweep(defaultDb, { apply: false })
  ok(dry.deleted === 0 && dry.candidate === 9, 'dry-run 报 9 条但不删')
  ok((await inspect(defaultDb)).total === 12, 'dry-run 后一条没少')

  // —— 真删：只删 dsh-auth-*，账号 cookie 与非 auth 的本机 cookie 都不动
  const backupDir = path.join(tmp, 'backups')
  const res = await sweep(defaultDb, { apply: true, backupDir, keep: 2 })
  ok(res.deleted === 9, `删了 9 条（实际 ${res.deleted}）`)
  ok(res.backup && res.backup.size > 0, '删前留了备份')
  const after = await inspect(defaultDb)
  ok(after.total === 3, `剩 3 条（实际 ${after.total}）`)
  ok(after.auth === 0, 'dsh-auth 清干净了')
  const names = after.hosts.map((h) => h.host)
  ok(names.includes('.bilibili.com') && names.includes('.deepseek.com'), '账号域 cookie 都还在')

  // —— scope=local：连本机 origin 的其它 cookie 一起删
  const localRes = await sweep(defaultDb, { apply: true, scope: 'local' })
  ok(localRes.deleted === 1, `local 范围再删 1 条（实际 ${localRes.deleted}）`)
  ok((await inspect(defaultDb)).total === 2, '只剩两个账号域 cookie')

  // —— 分区库也能清
  const partRes = await sweep(partDb, { apply: true })
  ok(partRes.deleted === 1, '分区库删掉 1 条')
  ok((await inspect(partDb)).total === 1, '分区库剩 1 条')

  // —— 备份保留份数
  for (let i = 0; i < 4; i += 1) backup(partDb, { dir: backupDir, label: 'x', keep: 2, now: new Date(Date.now() + i * 1000) })
  const kept = readdirSync(backupDir).filter((f) => f.startsWith('Cookies-x-'))
  ok(kept.length === 2, `备份只留 2 份（实际 ${kept.length}）`)

  // —— 汇总与格式化
  const sum = summarize([
    { ok: true, deleted: 3, freed: 100, totalBefore: 5, authBefore: 3 },
    { ok: false },
  ])
  ok(sum.deleted === 3 && sum.failed === 1, '汇总口径')
  ok(fmtBytes(2048) === '2.0 KB', 'fmtBytes')

  // —— 坏文件不炸
  const broken = path.join(tmp, 'broken.db')
  writeFileSync(broken, 'not a database')
  let threw = false
  try {
    await inspect(broken)
  } catch {
    threw = true
  }
  ok(threw, '坏库要抛错（由调用方记进报告）')

  console.log(`sweep.test.mjs OK {"pass":${pass},"sentinel":"ok","auth":${AUTH_PREFIX.length}}`)
} finally {
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {
    // Windows 上偶尔删不掉，忽略
  }
}
