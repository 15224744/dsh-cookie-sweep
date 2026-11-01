// 0.2.0 的安全规则：哨兵绝不在宿主还活着的时候动手。
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vbs = readFileSync(path.join(ROOT, 'bin', 'watch.vbs'), 'utf8')
const helper = readFileSync(path.join(ROOT, 'bin', 'helper.mjs'), 'utf8')

const results = []
const check = (name, ok, detail = '') => results.push({ name, ok, detail })

check('v0.2.0 标记存在', vbs.includes('v0.2.0 safe'))
check('已删掉 120 秒「照清」分支', !vbs.includes('sweeping anyway'))
check('应用回来时明确退出不扫', vbs.includes('app came back while waiting, exit without sweep'))
check('应用一直活着时给放弃', vbs.includes('exit without sweep') && vbs.includes('GIVEUP'))
check('走 SWbemLocator（26H2 之后 moniker 会失败）', vbs.includes('SWbemLocator') && !/Set wmi = GetObject/.test(vbs))
check('pid 消失但应用还活着时只等 90 秒', vbs.includes('pids gone but app name alive') && vbs.includes('waiting up to'))
check('watch.vbs 纯 ASCII', !/[^\x00-\x7F]/.test(vbs))
check('helper 有宿主运行守卫', helper.includes('function dshRunning') && helper.includes('DSH 还在运行，这次不动库'))
check('helper 支持 --force-run', helper.includes("has('--force-run')"))

// helper 的 status 子命令在宿主运行时也必须能跑（只读，不受守卫影响）
const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'helper.mjs'), 'status', '--root', path.join(ROOT, '.tmp-safety')], { encoding: 'utf8', timeout: 30000 })
check('宿主运行中 status 仍可执行', r.status === 0, `exit=${r.status}`)

const failed = results.filter((x) => !x.ok)
for (const x of results) console.log(`${x.ok ? 'ok  ' : 'FAIL'} ${x.name}${x.detail ? ' — ' + x.detail : ''}`)
console.log(`safety.test.mjs ${failed.length ? 'FAIL' : 'OK'} ${JSON.stringify({ pass: results.length - failed.length, failed: failed.length })}`)
process.exit(failed.length ? 1 : 0)
