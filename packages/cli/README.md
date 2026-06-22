# cofluxd

coflux daemon 的管理 CLI。daemon 是预编译的 Rust 二进制（supervisor 持 PTY + worker 频繁热升级，**零 node 运行时**）；本 CLI 只负责装/起/停/升级——node 仅在你偶尔跑命令时用一下。

## 安装

```sh
npm i -g cofluxd
```

## 用法

```sh
cofluxd                 # 首次=交互式引导（问服务器/登记密钥/设备名），之后=看状态
cofluxd onboard         # 显式重新走交互式配置
cofluxd up --enroll-key <KEY>   # 非交互（web「添加设备」给的命令）
cofluxd status          # 服务器/登记/服务状态
cofluxd logs -f         # 看 daemon 日志
cofluxd update          # 更新二进制并重启（worker 另可由 server 远程热升级）
cofluxd reload          # 改了 settings.json 后重启生效
cofluxd down            # 停止
cofluxd uninstall [--purge]   # 卸载（--purge 连二进制/配置/凭证一并删）
```

默认连公共服务 `wss://api.coflux.dev/daemon`（自托管用 `--server` 改）。登记密钥从 web 控制台「添加设备」获取。

## 配置

所有配置在 `~/.coflux/settings.json`（`serverUrl` / `enrollKey` / `deviceName` / `shell`，含密钥故权限 600），**daemon 直接读这个文件**。手改后 `cofluxd reload` 生效。

支持 macOS（launchd）/ Linux（systemd user service）；服务崩溃自启、开机自启。

更多见 [coflux 仓库](https://github.com/myWsq/coflux)。
