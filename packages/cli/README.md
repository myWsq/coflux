# Coflux 命令行

桌面、命令行和运行内核使用同一产品版本。安装 `npm i -g cofluxd` 后获得两个独立入口：

- `cofluxd`：无界面设备宿主。安装、启动、停止、更新运行内核，与 Coflux 桌面应用承担同一层职责。
- `coflux`：统一操作工具。登录、查看设备、创建工作区、操作本地或远端终端，供人和 Agent 使用。

桌面自带零 Node 依赖的 Rust `coflux`，注入本机终端 PATH；不需要另装 npm 包。
两个命令不互相转发，旧的 `cofluxd terminal` 等业务命令已经移除。

```sh
npm i -g cofluxd
cofluxd up                    # 安装、启动设备宿主，并按链接授权设备
coflux login --username <账号> --password-stdin
coflux device list
coflux workspace list
coflux terminal new --workspace <id> --cmd 'pwd'
coflux terminal read <id> --remote
```

在 Coflux 终端中，`coflux terminal new|list|read|send|wait`、`workspace`、`progress`、`notify`、`ports`
可使用本地通道；跨设备操作使用账号通道。桌面内 CLI 可复用应用登录，独立 CLI 可自行登录。
详细参数见 `coflux --help` 和 `cofluxd --help`，Agent 指引见 [SKILL.md](skills/coflux/SKILL.md)。

升级命令行包不会结束终端；`cofluxd update` 下载内核产物，不重启持有终端的组件。
`cofluxd restart`、`down` 会结束本机终端；运行中的 Supervisor 升级可等任务结束后再应用。
桌面正常后台运行保持在线，完全退出或退出桌面账号则结束本机终端。

开发：`node packages/cli/coflux.mjs --help`；桌面 Rust 实现为 `cargo build -p coflux-cli` 产出的 `coflux`。
发布与签名校验见 [RELEASING.md](../../docs/RELEASING.md)。
