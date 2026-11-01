# dsh-cookie-sweep

顺手扫掉 DSH 登录留下的 `dsh-auth-*` cookie。

## 为什么会有这个

DSH 的 `dsh-client-connection` 在 HTTP 下把 authority（`host:port`）当作 cookie 的受众：

```js
const COOKIE_PREFIX = 'dsh-auth-'
cookieName(authority) = COOKIE_PREFIX + base64url(sha256(authority))
```

桌面版每次启动都换端口，于是每次启动都签发一条**名字不同**的新 cookie，有效期 30 天，而主窗口没人清它。
一条 cookie 的请求头约 216 字节，攒到浏览器上限 16384 字节（约 **75 次启动**）就开始报 `431 Request Header Fields Too Large`，
表现成「DSH 突然打不开 / Web authentication failed」。

## 它怎么修

- 启动时布置一个**脱离的哨兵**（Windows 用 `wscript` 跑 `bin/watch.vbs`，无控制台窗口；没有 wscript 就退回 node 轮询）。
- 每 2 秒看一次宿主 pid；pid 全没了先等 45 秒，应用名也不在了就清，应用名还在（退出又马上重开）最多等 120 秒照清。
- 库还被 Chromium 占着时，helper 会**重试最多 2 分钟**（60 次 × 2 秒），不会把「刚退出、文件还没放开」当成失败。
- **默认只删 `dsh-auth-*`**：账号域（`.bilibili.com`、`.deepseek.com`）的 cookie 一条不动。
- 扫**默认库 + 所有 `Partitions\*\Network\Cookies`**（分区库也清）。
- 删前每库单独备份到 `~/.dsh/cookie-sweep/backups/`，默认留 5 份。
- 每次运行都写 `last-report.json`（失败也写）并往 `sweep.log` 记一行，事后能查清「哪一轮、删了几条、为什么没删成」。
- 同一个宿主进程只挂**一个**哨兵（按 `sentinel.json` 里的 `ownerPid` 去重），不会每次启动多留一个。
- 哨兵有死线（默认 12 小时）到点自退；**不 kill 任何进程**；全程无网络请求。

> `watch.vbs` 必须保持纯 ASCII：WSH 在没有 BOM 时按 ANSI 读 `.vbs`，
> UTF-8 中文注释会报一个假的 `'loop' 语句缺少 'do'`。

范围、份数、死线都可以在配置里改。

## 手动用

```bash
node bin/helper.mjs status      # 每个库多少条、dsh-auth 占多少字节
node bin/helper.mjs dry-run     # 算一遍，什么都不动
node bin/helper.mjs apply       # 真删（先备份）
node bin/helper.mjs apply --scope local   # 连本机 origin 的其它 cookie 一起删
node bin/helper.mjs apply --keep 3 --vacuum
```

`status` / `dry-run` 在 DSH 运行时会提示「打不开 cookie 库」——这是正常的，库被宿主独占锁着，
哨兵就是为这个存在的：等你退出再清。

## 配置（可选）

在 profile 的 patch 里给 `dsh-cookie-sweep` 覆盖即可：

```yaml
- id: dsh-cookie-sweep
  config:
    enabled: true        # false = 只保留诊断日志，不布置哨兵
    scope: auth          # auth（默认，只删 dsh-auth-*）| local（本机 origin 全删）
    keepBackups: 5
    timeoutHours: 12
```

## 装/卸

```bash
# 装（用 DSH 自己的插件管理器，不要手改 profile 的 package.json）
plugin_manager action=install_bundle target=C:\Users\Windows11\.dsh\plugins\cookie-sweep
# 卸
plugin_manager action=set_bundle target=dsh-cookie-sweep enabled=false
```

装完重启一次 DSH，哨兵才会挂上。之后你正常用、正常退，不用管。

## 文件

- `lib/index.js` —— 插件入口（读上次报告、诊断当前库、布置哨兵；全部 try/catch）
- `lib/targets.js` —— 找库：默认库 + `Partitions\*` + `DSH_COOKIE_DB`
- `lib/sweep.js` —— 数 / 备份 / 删（`node:sqlite`，参数绑定）
- `lib/sentinel.js` —— 哨兵进程与锁
- `lib/report.js` —— 上次报告 `~/.dsh/cookie-sweep/last-report.json` 与日志
- `bin/helper.mjs` —— CLI（status / dry-run / apply / watch）
- `bin/watch.vbs` —— Windows 哨兵（WMI 查 pid，GUI 子系统无窗口）
- `test/sweep.test.mjs`、`test/sentinel.test.mjs` —— 用临时库测，不碰真库

## 与第三方实现的差别

| | 这个 | 常见做法 |
|---|---|---|
| 扫描范围 | 默认库 + 所有分区库 | 只默认库 |
| 删除范围 | 默认只 `dsh-auth-*` | 本机 host 的全部 cookie |
| 备份 | 每库独立、按份数滚动 | 整库一份 |
| 哨兵 | 12 小时死线、到点自退 | 常驻直到退出（无死线） |
| 杀进程 | 不杀 | 会 kill 过期锁里的 pid |

## 已知边界

- 需要 Node ≥ 22（`node:sqlite`）。不够时插件只打一行 warn，不做事。
- 如果宿主不是 Electron 的 node 而是别的运行时，`process.execPath` 可能不是 node；可用环境变量
  `DSH_COOKIE_SWEEP_NODE` 指定一个 node 解释器。
- 库被占用时清不了是设计如此：清理只发生在退出之后。

## 0.2.0：安全优先（2026-11-02）

之前的规则里有一条「pid 没了但进程名还在 → 等 120 秒照清」。实测踩到过：宿主是多进程 Electron，pid 先消失、主窗口还在，哨兵就在**应用仍然活着**的时候去删库 —— 而 `dsh-auth-*` 正是宿主自己的登录态，这就是那次「登录态丢失」的可疑来源。

新规则（`bin/watch.vbs`）：

| 情形 | 动作 |
|---|---|
| 所有 pid 消失 + 进程名消失，持续 45 秒 | 清一次，退出 |
| 等待期间进程名又出现（刚重启） | **清都不清，直接退出**（新实例有自己的哨兵） |
| 进程名一直不消失（卡死的进程） | 最多等 90 秒，放弃并退出 |
| 12 小时死线 | 退出 |

另外：

- `bin/helper.mjs` 在真正写库前再查一次 `tasklist`，宿主还在跑就跳过（`--force-run` 可强制）。
- 26H2 之后 WSH 里 `GetObject("winmgmts:\.ootcimv2")` 会报 `0x80041021`（同机 PowerShell 的 CIM/COM 都正常），改用 `WbemScripting.SWbemLocator` 的 `ConnectServer`。
- 回归测试 `test/safety.test.mjs`：断言危险分支已删、退回不扫、VBS 纯 ASCII、helper 守卫存在。
