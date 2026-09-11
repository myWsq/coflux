# cofluxd

coflux daemon 的管理 CLI。daemon 是预编译的 Rust 二进制（supervisor 持 PTY + worker 频繁热升级，**零 node 运行时**）；本 CLI 提供设备服务管理和面向 Agent 的账号操作——node 仅在你偶尔跑命令时用一下。

## 安装

```sh
npm i -g cofluxd
```

## 用法

```sh
cofluxd                 # 首次=up（起服务后打印浏览器授权链接），之后=看状态
cofluxd up              # 幂等：零参数即可装/起；已装则按当前配置重装服务并重启
cofluxd status          # 服务器/登记（含"等待授权"）/服务/连接状态
cofluxd doctor          # 中心网络 + gateway/grant/loopback + daemon 状态分层自检
cofluxd logs -f         # 看 daemon 日志
cofluxd update          # 下载新二进制（不重启；supervisor 有变化时提示用 restart 应用）
cofluxd restart         # 重启 daemon 应用新 supervisor（⚠ 结束本机所有活会话）
cofluxd down            # 停止
cofluxd uninstall [--purge]   # 卸载（--purge 连二进制/配置/凭证一并删）
```

从 `cofluxd@0.12.0` 起，远端安装/更新会用 npm 包内置的 ed25519 公钥同时验证
supervisor 与 worker 的 version/target/size/sha256/release statement；两个文件全部通过后才替换。
CLI 还会取自身与 worker 的持久 release floor 较大值拒绝远端降级。`--bin-dir` 仍是本机管理员
显式信任本地产物的开发/救援入口。

默认连公共服务 `wss://api.coflux.dev/daemon`（自托管用 `--server` 改；已保存的地址继续生效，非默认时会有醒目提示）。

## 账号与跨设备操作

桌面和 CLI 使用相同账号下的设备、工作区和终端。桌面内置 CLI 可经本机 `client.sock`
复用应用登录态，应用不会把 token 返回给 CLI；独立 CLI 用以下命令登录，密码只从标准输入读取。
会话凭据保存在权限为 0600 的 `COFLUX_HOME/cli-session.json`，不保存密码。

```sh
cofluxd login --username <账号> --password-stdin [--server https://api.coflux.dev]
cofluxd whoami
cofluxd device list
cofluxd project list [--device <设备ID>]
cofluxd workspace list [--device <设备ID>]
cofluxd workspace new --project <项目ID> --branch <分支名> [--existing-branch]
cofluxd workspace rename <工作区ID> --name <名称>
cofluxd terminal new --workspace <工作区ID> [--cmd <命令>] [--title <标题>]
cofluxd terminal list --workspace <工作区ID>
cofluxd terminal read <终端ID> --remote [--lines 200]
cofluxd terminal send <终端ID> --remote --text <文本> [--enter]
cofluxd terminal wait <终端ID> --remote [--timeout 30]
cofluxd terminal stop <终端ID> --remote
cofluxd terminal remove <终端ID> --remote
cofluxd ports --remote [--device <设备ID>]
cofluxd workspace remove <工作区ID>
cofluxd logout
```

账号命令输出 JSON，失败退出码非零；跨设备不需要 MCP。`--remote` 明确选择账号通道，
不代表目标一定在另一台机器。工作区 ID 已唯一确定设备。用户正在接管的终端拒绝 Agent 输入。
写请求超时应先查询结果，不要盲目重复创建。`wait` 上限 600 秒。

CLI 命令结束、SSH 断开或升级 CLI 不结束已运行的终端。独立 CLI 的 `logout` 撤销该 CLI 登录；
Linux 本机服务仍由 `up/down` 管理。桌面账号退出请在应用中执行，它会结束并清理本机终端。

## 给 agent 用的命令

跑在 coflux 终端里的 claude/codex 可以用下面几条，把工作外化成用户在 web/手机上**看得见、能接管**的东西——而不是在自己的 Bash 里后台起一个谁也看不见的进程：

```sh
cofluxd terminal new --title "跑单测" --cmd "pnpm test"   # 作业终端：跑完即退，带退出码
cofluxd terminal new --title "调试 shell"                 # 会话终端：不带命令 = 常驻登录 shell
cofluxd terminal list                                     # 本工作区的终端 + 状态/退出码
cofluxd terminal read <taskId> [--lines N]                # 读终端内容（纯文本，已退出也能读）
cofluxd terminal wait <taskId> [--timeout <秒>]           # 阻塞到退出，打印退出码
cofluxd terminal send <taskId> --text "y" --enter         # 往终端输入；用户正在接管时被拒
cofluxd progress "复现了，正在定位"                        # 播报进度：显示在工作区卡片上
cofluxd notify "需要你定一下用哪个方案"                    # 叫人：侧栏转「等待交互」
cofluxd ports                                             # 端口 + 可直接打开的预览 URL
```

`terminal new` 带不带 `--cmd` 是两种终端：带命令是**作业终端**，命令包成脚本交登录 shell 跑，跑完终端退出并带退出码，输出另落一份日志供 `read` 回读（代价是命令的 stdout 是管道而非 tty，颜色/进度条/全屏程序都没有）；不带命令是**会话终端**，等价于用户在侧栏点「新建终端」——工作区目录下的默认登录 shell，stdin/stdout 都是真 tty，不会自己退出，直到 agent 或用户输入 `exit`。会话终端没有命令日志，`read` 读的是当前画面（一屏），首次 `send` 前要先 `read` 等提示符。

不需要任何凭证：daemon 用调用方 pid 反查进程树确认它属于哪个会话，**coflux 会话之外的进程一律拒绝**，权限也天然限定在该会话所属的工作区内。**local-first**：send/read/wait/notify/progress 在 daemon 本地闭环、不经中心（归属与退出码来自 daemon 自己的会话账本，内容来自本地命令日志或 sessiond 快照）；只有 new/list/ports 由 daemon 代问中心——Task 要落库广播、预览 URL 由中心生成。早于 daemon 升级开出来的终端缺归属信息，本地命令会明确拒绝，重开即可。

每个 coflux 开出来的 PTY 会话里还注入了一组 `COFLUX_*` 环境变量（由 supervisor 组装，中心只下发 id）：`COFLUX_DEVICE_ID` / `COFLUX_PROJECT_ID`（目录工作区为空串）/ `COFLUX_WORKSPACE_ID` / `COFLUX_TASK_ID` / `COFLUX_SESSION_ID`。agent 读它们就知道自己在哪台设备、哪个项目/工作区/终端，值与账号 CLI 返回的 id 完全一致，可直接传给 账号命令。当前工作区优先使用零凭据本机命令，跨工作区和跨设备使用上述账号 CLI；不再提供 MCP 接入。

还有一个只读不写的约定变量 `COFLUX_CLAUDE_PLUGIN_DIR`（plan 115）：**值由注入方决定**，supervisor 不解析、不校验、不落盘，只按 shell 注入一段集成 rc，把它翻译成 `claude --plugin-dir <dir>`——coflux 终端里手敲 `claude` 就自动带上那份插件（hooks / skill 全生效，`/plugin` 里看不到，因为这是会话级加载而非安装）。**npm 这条线不写这个变量**：macOS 上写它的是 Coflux.app（值指向稳定运行目录中的插件，普通应用更新保留旧终端所用版本）；Linux/自建可以在自己的 systemd unit 里设同一个变量指向任意插件目录，supervisor 侧的 shell 集成照样生效。变量为空、或指向的目录不存在时，`claude` 的行为与没有这个集成时完全一致——这既是退化行为，也是关掉它的办法。

配套的 skill 在 `skills/coflux/SKILL.md`（随包分发），装给 Claude Code：

```sh
mkdir -p ~/.claude/skills && ln -sfn "$(npm root -g)/cofluxd/skills/coflux" ~/.claude/skills/coflux
```

`cofluxd up` 起服务后会打印一个一次性授权链接，在浏览器用已登录的账号打开确认即可（链接可在任意设备打开，包括无头设备），无需先去 web 控制台生成密钥。已登记设备重跑 `up` 不会重新触发授权。

## 本地优先与 doctor

desktop web 与 daemon 同机时，terminal/普通 Device RPC 优先连接本机固定 gateway（默认
`127.0.0.1:8788`）；失败会自动走中心 opaque relay。远端访问始终可走 relay。`cofluxd doctor` 把两条
路径分开诊断：

```text
中心：DNS → TCP → TLS → WebSocket
本地：gateway bind → 持久 grant/Origin → loopback WebSocket
状态：daemon → 中心的实际连接状态
```

- 本地项失败：结论是“直连降级”，只影响同机低延迟路径；中心 relay 正常时 daemon 仍在线可用。
- 中心项失败：已经加载、已经配对且 cached direct 可用的页面仍能控制存活 session；刷新/冷启动不保证。
- 网络层都通但 daemon 未连接：查看 `cofluxd logs`，通常是认证、版本或服务进程问题。

doctor 只读取 gateway store 的结构、grant/Origin 数量和 bind 状态，不打印 browser 私钥、grant id、
device token 或其它凭证。它的 loopback 检查只做主机侧 WebSocket upgrade；浏览器自身的 LNA/permission
仍以 Chrome/Safari/Firefox 页面实测为准。

> `onboard`、`reload` 命令已移除：onboard 并入零参数 `up`，reload 并入幂等化后的 `up`（重跑 `up` 即按 settings.json 重装服务并重启）。

## 配置

所有配置在 `~/.coflux/settings.json`（`serverUrl` / `deviceName` / `shell`），**daemon 直接读这个文件**。手改后重跑 `cofluxd up` 生效。

支持 macOS（launchd）/ Linux（systemd user service）；服务崩溃自启、开机自启。

更多见 [coflux 仓库](https://github.com/myWsq/coflux)。
