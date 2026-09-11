# 桌面生命周期隔离验收

自动化通过不等于签名桌面的权限、原生确认框和真实更新已通过。分别记录每一项证据。

## 账号清理与网络恢复

```sh
cargo build -p coflux-supervisor -p coflux-worker -p coflux-relay
node --import tsx scripts/verify-desktop-account-lifecycle.mjs
```

脚本使用 harness 创建临时数据库、两台真实 daemon 和临时目录。中心监听 8878，可用
`COFLUX_ACCOUNT_ACCEPTANCE_PORT` 修改。二进制路径支持与黑盒相同的
`COFLUX_SUPERVISOR_BIN`、`COFLUX_WORKER_BIN`、`COFLUX_RELAY_BIN`。

脚本验证真实 WebSocket 账号控制、离线本地清理、重建组件后的 outbox 重试、旧 token 撤销、
另一设备的活终端和项目文件保留。它直接组装桌面账号组件，存储使用测试替身，
所以不属于 `tests/src` 的黑盒测试，也不替代 GUI 登出确认和 safeStorage 验收。

## 签名应用与真实更新

1. 准备本机测试中心、临时数据库及账号，创建独立的 `COFLUX_HOME` 和
   `COFLUX_DESKTOP_USER_DATA`，后者的 `settings.json` 指向测试中心。
2. 从构建产物复制两份应用，使用独立测试 bundle ID（例如 `dev.coflux.acceptance`），
   旧、新版本保持同一签名身份。不得覆盖 `/Applications/Coflux.app`。
   `CFBundleName` 和 package 的 `productName` 保持 `Coflux`，否则 Electron 无法找到 Helper。
3. 两份应用的 `Info.plist` 写入隔离目录的 `LSEnvironment`，保证更新器重启时仍使用隔离数据。
   修改 asar 后必须更新 `ElectronAsarIntegrity`，签名后执行
   `codesign --verify --deep --strict`。本地 Apple Development 验证与 Developer ID 公证分开记录。
4. 在 `Contents/Resources/app-update.yml` 设置本机 generic feed，使用独立
   `updaterCacheDirName`。用 `ditto -c -k --sequesterRsrc --keepParent` 打包新版本；
   `latest-mac.yml` 的版本、zip 文件名、size、SHA-512 必须与实际文件一致。
   HTTP 服务只监听 `127.0.0.1`，只开放测试 manifest 和 zip。
5. 用 LaunchServices 启动旧应用，不能直接 spawn 主可执行文件来推断权限归属。
   直接 spawn 可能继承启动终端的 TCC responsibility。
   显式传隔离环境，且不要修改 `HOME`：

   ```sh
   open -n -a "$ACCEPTANCE_APP" \
     --env "COFLUX_HOME=$ACCEPTANCE_HOME" \
     --env "COFLUX_DESKTOP_USER_DATA=$ACCEPTANCE_USER_DATA" \
     --env COFLUX_LOCAL_GATEWAY_PORT=0
   ```

6. 登录、创建终端，在终端中执行：

   ```sh
   COFLUX_CHECK=preserved
   printf 'BEFORE=%s PID=%s\n' "$COFLUX_CHECK" "$$"
   ```

   记录 `runtime.sock` 的 status：instanceId、runtimeId、sessionId、taskId、PID。
   UDS 响应必须累计到换行后解析，不能假定第一次 data 事件就是完整 JSON。
7. 放出新 manifest，等待内置更新器下载，点击应用里的“更新”。确认经历了
   Squirrel 替换和重启，启动版本变化且 userData 仍是测试目录。
   在同一终端再次打印变量及 PID，必须与更新前一致，再比较 runtime status。
   仅强杀重启、重新 attach 或看到历史画面均不算真实更新通过。

## 窗口、退出、登出与权限

- 点击窗口红色关闭按钮：应用、内核和 shell 继续存活；从 Dock/LaunchServices 再次打开能继续输入。
  `Cmd+W` 是终端 Tab 的关闭快捷键，不能用来替代关窗测试。
- 活终端下 `Cmd+Q`：取消后变量/PID 不变；确认后应用、内核和终端结束。
- 活终端下账号菜单“登出”：取消继续运行；确认后回登录页，本机终端及明文凭据消失，
  云端本机终端清理、旧会话失效，其他设备不受影响。无活终端登出须单独记录。
- 完全磁盘访问仅添加测试 `.app`，不得添加 supervisor 或使用真实安装作替身。
  用实际终端执行 `/bin/ls "$HOME/Library/Safari" >/dev/null`，只记录退出码。
  授权前、授权后、更新后分别验证。其他服务的 TCC 日志（例如 ScreenCapture/AppleEvents）
  不能证明终端的完全磁盘访问归属。
- 自动化工具若只返回菜单 AX 节点而没有截图，点击后也没有状态变化，该动作应记为未验证，
  由实际 UI 操作补齐，不猜测点击成功或据此认定应用失效。

## 清理

先通过隔离 `runtime.sock` 向精确 instanceId 发送 stop，再停止测试应用、feed 和测试中心，
让 harness 清理临时数据库。确认没有进程仍使用临时应用后再删目录。
只清理本次独立的 updater/ShipIt 缓存，不能清理正式应用缓存、真实服务或其他工作区。
如保留待用户完成权限验收的环境，明确记录仍在运行的测试实例，不宣称已经清理。
