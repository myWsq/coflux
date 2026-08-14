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

默认连公共服务 `wss://api.coflux.dev/daemon`（自托管用 `--server` 改；已保存的地址继续生效，非默认时会有醒目提示）。

## 给 agent 用的命令

跑在 coflux 终端里的 claude/codex 可以用下面几条，把工作外化成用户在 web/手机上**看得见、能接管**的东西——而不是在自己的 Bash 里后台起一个谁也看不见的进程：

```sh
cofluxd terminal new --title "跑单测" --cmd "pnpm test"   # 开真实终端，用户可接管
cofluxd terminal list                                     # 本工作区的终端 + 状态/退出码
cofluxd terminal read <taskId> [--lines N]                # 读终端内容（纯文本，已退出也能读）
cofluxd notify "需要你定一下用哪个方案"                    # 叫人：侧栏转「等待交互」
cofluxd ports                                             # 端口 + 可直接打开的预览 URL
```

不需要任何凭证：daemon 用调用方 pid 反查进程树确认它属于哪个会话，**coflux 会话之外的进程一律拒绝**，权限也天然限定在该会话所属的工作区内。

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
