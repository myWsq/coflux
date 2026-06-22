# 部署 coflux daemon（全 Rust）

daemon = **supervisor**（持 PTY，极少升级）+ **worker**（连服务器/认证/git/exec/fs，频繁升级）。
系统服务只看护 **supervisor**——worker 由 supervisor 自己起/管/重启/版本切换。

## 安装

```sh
# Linux(systemd user) / macOS(launchd LaunchAgent) 自动识别
deploy/install.sh --server ws://你的服务器:8787/daemon --enroll-key 你的登记密钥 [--name 设备名]
```

做的事：
1. `cargo build --release` 出 `coflux-supervisor` + `coflux-worker`（`--skip-build` 用已有产物）。
2. 装二进制到 `~/.local/bin`（`--prefix` 可改）。
3. 写 `~/.coflux/daemon.env`（600，含 server/enroll-key/worker 路径）+ `run-daemon.sh`（source env 后 exec supervisor，密钥只存 env 文件、不进单元）。
4. 写并 enable + start 服务：
   - Linux：`~/.config/systemd/user/coflux-daemon.service`（`Restart=always`）。开机自启（免登录）再跑 `loginctl enable-linger $USER`。
   - macOS：`~/Library/LaunchAgents/com.coflux.daemon.plist`（`RunAtLoad` + `KeepAlive`）。日志在 `~/.coflux/daemon.log`。

`--no-start` 只生成文件不启动（检查用）。

## 卸载

```sh
deploy/install.sh --uninstall   # 停服务、删单元/wrapper/env；保留二进制与 ~/.coflux/credentials.json
```

## 升级 daemon

- **worker**：热升级——supervisor 切到新版 worker、PTY 会话存活（见 [../docs/hot-upgrade-design.md](../docs/hot-upgrade-design.md)）。当前只在本地已知版本间切换；远程下载 + ed25519 验签是后续项（验签为启用前硬前置）。
- **supervisor**：重装并重启服务（非热升级，但极少发生）。
