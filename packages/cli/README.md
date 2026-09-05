# cofluxd

coflux daemon 的管理 CLI。daemon 是预编译的 Rust 二进制（supervisor 持 PTY + worker 频繁热升级，**零 node 运行时**）；本 CLI 只负责装/起/停/升级——node 仅在你偶尔跑命令时用一下。

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

## 给 agent 的能力面：只有 MCP

跑在 coflux 终端里的 claude/codex 把工作外化成用户在 web/手机上**看得见、能接管**的东西——开真实终端跑命令、读输出、等退出、输入、播报进度、叫人、拿预览 URL、开子工作区——**一律经中心托管的 `coflux` MCP（16 个 tools）**，一次 OAuth 授权即可触达整个账号：

```sh
claude mcp add --transport http coflux "$COFLUX_MCP_URL"   # Claude Code
codex mcp add coflux --url "$COFLUX_MCP_URL"               # Codex
```

`cofluxd` 自 plan 093 起**不再承载任何 agent 能力**：`cofluxd terminal/notify/progress/ports` 已删，老入口只打印「已并入 coflux MCP，对应 tool 是 …」并非零退出。保留的 `cofluxd hook <claude|codex>` 只是 hook 事件信使（活动状态判定），不是 agent 命令。

每个 coflux 开出来的 PTY 会话里注入了一组 `COFLUX_*` 环境变量（由 supervisor 组装，中心只下发 id）：`COFLUX_DEVICE_ID` / `COFLUX_PROJECT_ID`（目录工作区为空串）/ `COFLUX_WORKSPACE_ID` / `COFLUX_TASK_ID` / `COFLUX_SESSION_ID` / `COFLUX_MCP_URL`。agent 读它们就知道自己在哪台设备、哪个项目/工作区/终端，值与中心 MCP `list_*` 返回的 id 完全一致，直接传给 MCP tools（自己的终端就是 `$COFLUX_TASK_ID`，`notify_user` / `report_progress` 用它寻址）。supervisor 不走热升级，旧机器要 `cofluxd update && cofluxd restart` 之后会话里才有这些变量。

配套的 skill 在 `skills/coflux/SKILL.md`（随包分发），装给 Claude Code（coflux 插件用户不用装——插件自带同一份 skill 与 `.mcp.json`）：

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
