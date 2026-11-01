# 更新记录


## 0.2.0 — 2026-11-02

安全优先。修掉一个会在**应用还活着时**动库的真问题。

- 删掉「pid 消失但进程名还在 → 等 120 秒照清」这条兜底。宿主是多进程 Electron，pid 先消失、主窗口还在，于是哨兵会在应用运行时删掉 `dsh-auth-*`，那正是宿主自己的登录态。
- `bin/helper.mjs` 写库前再查一次 `tasklist`，DSH 还在就跳过（`--force-run` 可强制）。
- 新退出条件：pid + 进程名都消失满 45 秒才清；等待期间进程名回来就不扫直接退出；进程名一直不消失最多等 90 秒放弃；12 小时死线。
- 26H2 之后 WSH 的 `GetObject("winmgmts:...") ` 会报 `0x80041021`（同机 PowerShell 的 CIM/COM 都正常），改用 `WbemScripting.SWbemLocator` 的 `ConnectServer`。
- 新增 `test/safety.test.mjs`（10 项），合计 47 项测试。

## 0.1.5

- `helper.mjs` 支持 `--help` / `help`，把用法、选项、退出码写清楚。
- 锁重试只针对「文件还在、只是被锁」的库；库文件已不存在时立即放弃，不再空转 5 分钟。
- 测试跑完会按 `sentinel.json` 里的 pid 收掉自己起的哨兵，不在机器上留 120 秒的空等进程。
- `package.json` 整理格式，补 `repository` / `bugs` / `homepage` 字段。

## 0.1.4

- `--help` 文字（此版已合并进 0.1.5 的说明）。

## 0.1.3

- **真实验收通过**：退出后清掉 4 条 `dsh-auth-*`，释放 1.1 KB，`failed:0`，账号 cookie 保留。
- 新实例启动时不再 `SIGTERM` 上一轮仍在等待的哨兵（修「退出后立刻重开清不掉」）。
- helper 锁重试窗口放宽到 150 × 2 秒（5 分钟）。

## 0.1.2

- `watch.vbs` 去掉中文注释（WSH 按 ANSI 读会语法出错导致哨兵秒退）。
- 退出判定改为 45 秒 / 120 秒双档。
- 按 `sentinel.json.ownerPid` 去重，同一次宿主只布置一个哨兵。
- 失败也写 `last-report.json`，并 append 到 `sweep.log`。

## 0.1.1

- 备份按文件名（ISO 时间戳）排序，新备份不会被自己裁掉。
- 写锁前先 `mkdirSync` 报告目录。
- `DSH_COOKIE_DIR` 改为独占（不再与真实 APPDATA 一起扫）。

## 0.1.0

- 首个版本：默认库 + `Partitions\*` 扫描、只删 `dsh-auth-*`、每库备份、`wscript` 哨兵、CLI。
