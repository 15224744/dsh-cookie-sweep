# 安装 / 分发说明（dsh-cookie-sweep 0.1.5）

一个 DSH 插件：宿主退出后，用一个脱离的哨兵把 `dsh-auth-*` 登录 cookie 清掉。

## 它解决什么

DSH 的 `client-connection` 在 HTTP 下把 `host:port` 当 cookie 受众，而端口每次启动都变，
所以**每次启动都会新签发一条 `dsh-auth-<sha256(host:port)>`**，有效期 30 天，没人清。
一条 cookie 的请求头约 216 字节，攒到 16384 字节（约 75 次启动）请求头就超标，
表现成「DSH 打不开 / Web authentication failed / 431」。

插件在启动时布置一个哨兵；宿主退出后（cookie 库解锁）清一次：

- 默认**只删 `dsh-auth-*`**，`.bilibili.com`、`.deepseek.com` 这类账号 cookie 一条不动；
- 删前**每库单独备份**到 `~/.dsh/cookie-sweep/backups/`，默认留 5 份；
- 扫默认库 `Network\Cookies` + 所有 `Partitions\*\Network\Cookies`（主窗口实际用的是后者）；
- 不联网、不 kill 任何进程、出错只写日志，不拖累启动。

## 要求

- Windows（哨兵用 `wscript`；其他平台退化为 node 子进程）
- Node **>= 22**（用内置 `node:sqlite`）
- DSH 桌面版；插件 API 与 `0.2.1-rc.x` 同代

## 安装（推荐：用 DSH 自己的 plugin_manager）

1. 把本目录放到 `C:\Users\<你>\.dsh\plugins\cookie-sweep\`（名字随意）。
2. 在 DSH 里让 agent 执行：

   ```
   plugin_manager action=install_bundle target=C:\Users\<你>\.dsh\plugins\cookie-sweep
   ```

   它会代做依赖与 `bundles` 注册。
3. 重启 DSH（托盘退出再开）——插件在宿主启动时才会布置哨兵。

> 不要手改 `profiles\desktop\package.json`。真要改，先备份，改完跑一次
> `node bin/check-config.mjs`（本仓库带的那个），不绿不要重启。

## 只用命令行（不装插件）

```bash
node bin/helper.mjs status        # 看每个库有多少条、占多少字节
node bin/helper.mjs dry-run       # 只算不清
node bin/helper.mjs apply         # 真清（先备份）
node bin/helper.mjs apply --scope local --vacuum
```

选项：`--scope auth|local`（默认 `auth`）、`--keep N`（备份份数）、`--vacuum`、
`--json`、`--root DIR`（报告目录）。

DSH 正在跑时库是被锁的，`apply` 会提示「多半是 DSH 还在跑」，这是正常的——
所以插件才用「退出后清」这个时机。

## 验证它真的工作了

退出 DSH，等 45–120 秒，再打开，然后看：

- `~/.dsh/cookie-sweep/last-report.json` —— `deleted`、`freed`、`failed`、每库明细与备份路径
- `~/.dsh/cookie-sweep/sweep.log` —— 应能看到
  `[vbs] targets gone, sweeping` → `清掉 N 条登录 cookie` → `[vbs] sentinel done`

没看到就先怀疑哨兵没起来：`powershell -c "Get-CimInstance Win32_Process -Filter \"Name='wscript.exe'\""`
应当有一条 `watch.vbs <pid> ...`，它的 `<pid>` 就是当前 DSH 宿主。

## 配置项（bundle 配置里可覆盖）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | `false` 时不布置哨兵 |
| `scope` | `auth` | `auth` 只删 `dsh-auth-*`；`local` 删本机 host 的全部 cookie |
| `keepBackups` | `5` | 每个库保留几份备份 |
| `timeoutHours` | `12` | 哨兵死线；到点自退，不会常驻 |
| `root` | `~/.dsh/cookie-sweep` | 报告/日志/备份目录 |

## 卸载

1. `plugin_manager action=set_bundle target=dsh-cookie-sweep enabled=false`（或 `remove_bundle`）
2. 删掉 `~/.dsh/cookie-sweep/`（报告与备份，里面是整库副本，含账号 cookie，**别外传**）

## 已知代价

- 退出后 45–120 秒内会多一个隐藏的 `wscript.exe`（约 5MB），清完自退。
- 备份是**整库副本**（含账号域 cookie，Chrome 加密存储）。介意的话把 `keepBackups` 设 0。

## 测试

```bash
node test/sweep.test.mjs      # 22 项
node test/sentinel.test.mjs   # 15 项
```

`audit/sim-sentinel.mjs`、`audit/sim-sentinel-restart.mjs`（在打包者工作区里，不在本包内）
是端到端模拟：假宿主 + 真 `wscript` + 假库，验证「正常退出」与「退出后立刻重开」两种时序。

MIT License.
