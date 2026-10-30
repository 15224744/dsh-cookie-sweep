// 找 cookie 库：默认库 + 所有 Partitions\*\Network\Cookies。
//
// 为什么要扫 Partitions：Chromium 把持久分区库放在
//   <userData>\Partitions\<partition>\Network\Cookies
// 第三方插件（比如侧栏网页）用的是 persist:dsh-platform-<hash> 分区。
// 现在主窗口那份在默认库，但换版本/换分区策略时可能搬家，两边都看才不漏。

import { existsSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const SWEEP_HOME = path.join(
  process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
  'cookie-sweep',
)

// Electron 把 userData 放在 %APPDATA%\<appName>；我们的 appName 是 @deepseek-ai/dsh-desktop。
export function desktopDataDirs(env = process.env) {
  // DSH_COOKIE_DIR 是显式覆盖：给了就只认它，不再去扫真实的 APPDATA（测试/换机时不会误伤）。
  const explicit = env.DSH_COOKIE_DIR
  if (explicit) return [explicit]
  const appData = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  return [path.join(appData, '@deepseek-ai', 'dsh-desktop')]
}

function isFile(p) {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

// 返回 [{ label, path, kind }]，去重、只保留真实存在的文件。
export function findCookieDbs(env = process.env) {
  const found = []
  const seen = new Set()
  const push = (label, file, kind) => {
    if (!isFile(file)) return
    const key = path.resolve(file).toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    found.push({ label, path: path.resolve(file), kind })
  }

  for (const dir of desktopDataDirs(env)) {
    push('default', path.join(dir, 'Network', 'Cookies'), 'default')
    const partitions = path.join(dir, 'Partitions')
    let names = []
    try {
      names = readdirSync(partitions, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      // 没有 Partitions 目录很正常
    }
    for (const name of names) {
      push(`partition:${name}`, path.join(partitions, name, 'Network', 'Cookies'), 'partition')
    }
  }

  for (const extra of String(env.DSH_COOKIE_DB || '').split(',')) {
    const p = extra.trim()
    if (p) push(`extra:${path.basename(path.dirname(path.dirname(p)))}`, p, 'extra')
  }

  return found
}

// 同目录下 Chromium 的旁挂文件；清理时一起看，方便判断库是不是还开着。
export function sidecars(file) {
  return [file, `${file}-journal`, `${file}-wal`, `${file}-shm`].filter((p) => existsSync(p))
}
