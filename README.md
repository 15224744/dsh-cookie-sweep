# dsh-cookie-sweep

给 DeepSeek Harness 桌面版用的 cookie 清理插件。

DSH 在 HTTP 下把 `host:port` 当作 cookie 受众，而**端口每次启动都变**，于是每次启动都会新签发一条
`dsh-auth-<sha256(host:port)>`，有效期 30 天、没有任何清理，攒到约 75 次启动（≈16KB 请求头）就会被
431 挡在门外，表现成「DSH 打不开 / `Web authentication failed`」。

这个插件在 DSH 退出后把 `dsh-auth-*` 清掉一次。**账号登录 cookie 一条不动**，删前每个库单独备份。

## 功能

- 退出后自动清理，不用再手动删 `Cookies`
- 默认只删 `dsh-auth-*`；`.bilibili.com`、`.deepseek.com` 这些账号域不碰
- 扫**默认库 + 所有 `Partitions\*\Network\Cookies`**（主窗口实际用的是按账号 hash 命名的分区库）
- 删除前每库备份到 `~/.dsh/cookie-sweep/backups/`，默认留 5 份
- 失败也写报告：`last-report.json` 里能看出哪个库没清成、为什么
- 不联网、不 kill 任何进程、出错只写日志
- 命令行可随时 `status` / `dry-run` / `apply`

## 症状对不对得上

满足这几条基本就是它：

1. 用了一段时间后 DSH 启动失败或白屏，日志里有 `Web authentication failed` 或 431；
2. 删掉 `%APPDATA%\@deepseek-ai\dsh-desktop\Network\Cookies` 就能起来；
3. 每次启动端口都不一样（`127.0.0.1:54516` → `:60218` → …）。

## 安装

要求：

- DSH 桌面版（`0.2.1-rc.x` 同代插件 API）
- Node.js >= 22（用到 `node:sqlite`；DSH 自带的是 Node 24）

**推荐**：把本仓库放到 `C:\Users\<你>\.dsh\plugins\cookie-sweep`，然后在 DSH 里让 agent 执行

```
plugin_manager action=install_bundle target=C:\Users\<你>\.dsh\plugins\cookie-sweep
```

它会代做依赖与 `bundles` 注册，比手改 profile 安全。

也可以走 GUI：**设置 → 插件 → 从本地路径安装**，选这个目录。

装完**重启 DSH**（退出再开）——插件只在宿主启动时布置哨兵。

> 不要手改 `profiles\desktop\package.json`。真要改，先备份，改完跑 `node bin/check-config.mjs`，
> 不绿不要重启（启动链上任何一个文件带 BOM 都会让 DSH 起不来）。

## 验证

退出 DSH，等 45–120 秒，再打开，然后看：

```powershell
Get-Content "$env:USERPROFILE\.dsh\cookie-sweep\last-report.json" -Raw
Get-Content "$env:USERPROFILE\.dsh\cookie-sweep\sweep.log" -Tail 5
```

正常应该看到：

```
14:30 [vbs] targets gone, sweeping
14:30 清掉 4 条登录 cookie，释放约 1.1 KB
14:30 [vbs] sentinel done
```

`last-report.json` 里是 `deleted` / `freed` / `failed` 与每个库的明细、备份路径。
（示例见 `docs/example-report.json`、`docs/example-sweep.log`。）

## 配置

在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里给这一条加 `config`：

```yaml
- id: dsh-cookie-sweep
  config:
    enabled: true
    scope: auth        # auth=只删 dsh-auth-*；local=连本机 host 的其它 cookie 一起删
    keepBackups: 5     # 每个库留几份备份，0 = 不备份
    timeoutHours: 12   # 哨兵死线，到点自退
```

## 命令行（不装插件也能用）

```bash
node bin/helper.mjs status        # 每个库多少条、占多少字节
node bin/helper.mjs dry-run       # 只算不清
node bin/helper.mjs apply         # 真清（先备份）
node bin/helper.mjs apply --scope local --vacuum
node bin/helper.mjs --help
```

DSH 正在跑时库是被锁的，`apply` 会提示「多半是 DSH 还在跑」——这是正常的，所以插件用「退出后清」这个时机。

## 卸载

```
plugin_manager action=remove_bundle target=dsh-cookie-sweep
```

再删 `~/.dsh/cookie-sweep/`。里面是整库备份（含账号 cookie，Chrome 加密存储），**别外传**。

## 原理与算术

- `dsh-client-connection` 的 `cookieName(authority) = "dsh-auth-" + base64url(sha256(authority))`，名字 52 字符；
- HTTP 下 `requestAudience()` 返回 `url.host`（含端口），端口每次启动重掷；
- cookie 值 `v1.<base64url(JSON{version,authority,issuedAt,expiresAt})>.<base64url(hmac)>` 约 161 字符；
- 一条 cookie 的请求头 ≈ 216 字节（52 + 161 + 分隔），`16384 / 216 ≈ 75` 次启动；
- 只在 `GET /?token=<launchToken>` 时签发，30 天后过期，主窗口 session 无人清理。

## 和 dsh-cookie-cleaner 的区别

| | dsh-cookie-cleaner | 本项目 |
| --- | --- | --- |
| 扫描范围 | 默认 `Network\Cookies` | 默认库 **+ 所有 `Partitions\*\Network\Cookies`** |
| 删除范围 | 本机 host 的全部 cookie | 默认只删 `dsh-auth-*` |
| 备份 | 整库副本 | 整库副本（可按 `keepBackups` 关闭） |
| 常驻 | 隐藏的 `wscript`（约 5MB） | 同上，12 小时死线自退 |
| 失败报告 | 有 | 有（失败也写 `last-report.json`） |

两个都能用，选哪个看你要「按 host 全清」还是「只清这一种 cookie」。

## 测试

```bash
node test/sweep.test.mjs       # 22 项
node test/sentinel.test.mjs    # 15 项
node bin/check-config.mjs      # 如果你还带着工作区的配置体检脚本
```

## 踩过的坑（维护者笔记）

1. **`watch.vbs` 必须纯 ASCII**。WSH 在没有 BOM 时按 ANSI 读，中文注释会变成
   `'loop' 语句缺少 'do'`，哨兵一启动就死，日志里什么都不留。
2. 判定退出别只盯 pid：Electron 是多进程，pid 换得比进程名快。现在用「pid 全没了 + 45 秒」，
   应用名也没了立刻清，应用名还在最多等 120 秒照清。
3. 新实例启动时**不要杀**上一轮还在等的哨兵，否则「退出后马上重开」这一轮就永远清不掉。
4. 备份按文件名排序，别按 mtime——刚建的那份会把自己当成旧的删掉。

## License

MIT
