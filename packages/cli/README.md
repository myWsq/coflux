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
cofluxd doctor          # 分层连通性自检（DNS→TCP→TLS→WS 升级）+ 本地状态汇总
cofluxd logs -f         # 看 daemon 日志
cofluxd update          # 更新本地 supervisor 二进制并重启（worker 由 server 自动热升级）
cofluxd down            # 停止
cofluxd uninstall [--purge]   # 卸载（--purge 连二进制/配置/凭证一并删）
```

默认连公共服务 `wss://api.coflux.dev/daemon`（自托管用 `--server` 改；已保存的地址继续生效，非默认时会有醒目提示）。

`cofluxd up` 起服务后会打印一个一次性授权链接，在浏览器用已登录的账号打开确认即可（链接可在任意设备打开，包括无头设备），无需先去 web 控制台生成密钥。已登记设备重跑 `up` 不会重新触发授权。

连不上时用 `cofluxd doctor` 逐层排查（DNS 解析 → TCP 连接 → TLS 握手 → WS 升级握手），失败层会给出具体指向；各层都通但仍未连接说明问题在认证层，查 `cofluxd logs`。

> `onboard`、`reload` 命令已移除：onboard 并入零参数 `up`，reload 并入幂等化后的 `up`（重跑 `up` 即按 settings.json 重装服务并重启）。

## 配置

所有配置在 `~/.coflux/settings.json`（`serverUrl` / `deviceName` / `shell`），**daemon 直接读这个文件**。手改后重跑 `cofluxd up` 生效。

支持 macOS（launchd）/ Linux（systemd user service）；服务崩溃自启、开机自启。

更多见 [coflux 仓库](https://github.com/myWsq/coflux)。
