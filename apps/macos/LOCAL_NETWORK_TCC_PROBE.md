# macOS Local Network TCC 验收入口

本入口只服务 plan 083 的 Local Network privacy 门，不是产品 UI，也不把 entitlement、loopback
或普通网络失败伪装成用户 Allow/Deny。Apple 在 TN3179 中明确说明：macOS 没有公开 API 显式弹出
Local Network alert，也不能可靠把权限恢复为 `undetermined`。因此每次验收使用两个从未启动过的
一次性 `.app` 身份；若要可重复的 clean-user 证据，必须恢复安装前 VM snapshot 或换全新 macOS
用户。

## 证据分层

| 层级 | 硬证据 | 能声称什么 |
|---|---|---|
| build-only | Apple Development、真实 Team ID、Hardened Runtime、Sandbox、`network.client`、Info.plist、两个不同 Mach-O UUID | 验收 app 构型正确；**没有**运行或产生 TCC 记录 |
| fresh bundle | 两个新 bundle ID，人工 Allow/Don’t Allow；Allow 为受控 peer nonce echo，Deny 为 `NWPath.unsatisfiedReason == .localNetworkDenied` | 当前系统 build 上 fresh bundle 的双路径；**不是** clean-user |
| new user / VM snapshot | 同上，但在从未运行 probe 的新用户或安装前 VM snapshot，并保留操作者/环境记录 | 可形成 clean-user TCC 双路径；context 参数本身不是自动证明 |
| remote worker + native relay | TCC Deny、远端 LAN worker 的 DataChannel 未 open、由同一 native client 走生产 relay Ping/Pong | 才能声称真实 native relay fallback |

当前 probe 的 coordinator 只绑定 `127.0.0.1`，用于回传结果和严格清理。它能证明 TCC Deny
没有阻断 loopback callback，但不能称为 relay。现有 WebRTC harness 的 Node `DeviceClient`
relay ping 证明的是 relay 服务/已有 relay channel 健康，也不是 native app 自动 fallback。

## 运行

先在第二台、同一物理 Wi-Fi/Ethernet LAN 的受控 Mac 上启动 echo peer：

```sh
node apps/macos/scripts/local-network-tcc-peer.mjs --host 0.0.0.0 --port 0
```

记录 sentinel 中的端口，并取该 Mac 的非 loopback LAN IPv4。验收机先做无 TCC 副作用的
构建/签名审计：

```sh
node apps/macos/scripts/local-network-tcc-acceptance.mjs --build-only
```

然后运行一次性人工验收：

```sh
node apps/macos/scripts/local-network-tcc-acceptance.mjs \
  --acceptance \
  --peer-host 192.168.1.23 \
  --peer-port 49152 \
  --context fresh-bundle
```

脚本会拒绝 loopback、自机地址、非 RFC1918/link-local IPv4、非物理 Wi-Fi/Ethernet route、不同
子网、未响应随机挑战的 peer，以及系统级
`AllowedEthernetLocalNetworkAddresses` / `AllowedWiFiLocalNetworkAddresses` 例外。它只在 Finder
中定位 app；操作者必须逐个双击，目视真实系统 alert，按窗口要求分别选择“允许”与“不允许”，再
用第二条新连接验证。harness 还要求 app 由 LaunchServices/launchd 托管、所有 callback 来自同一
PID；直接从 Terminal 执行主 Mach-O 会失败。首次连接只负责触发 prompt，因为 alert 未回应时的
临时 policy denial 不能单独证明用户选择了 Deny。

只有以下两个结果算通过：

- Allow：`NWConnection.ready` 后，实际 `NWPath` 使用 Wi-Fi/Ethernet，第二台受控 peer 以同一
  peer process ID 原样回显本次随机 nonce；
- Deny：新连接进入 waiting，且 `currentPath.unsatisfiedReason` 明确为 `localNetworkDenied`。

每个 variant 前后都会重新检查 route、接口/硬件口、peer ID 与随机挑战；人工等待期间切 VPN、换网
或重启 peer 会使本次验收失败，不会沿用旧的预检结果。

timeout、DNS/route、普通 POSIX/TLS 错误、peer 不可达或没有 prompt 一律是 `INCONCLUSIVE`。

## 人工与清理边界

禁止自动点击系统 alert、`osascript`/System Events、XCUITest 私有自动化、`tccutil`、操作
`TCC.db`、杀 `tccd`、写 `com.apple.network.local-network` defaults 或使用 `sudo`。Terminal/SSH
的命令行工具及子进程可能被系统自动允许，所以主 app 必须从 Finder 启动，不能直接执行其 Mach-O。

SIGINT、SIGTERM 与 SIGHUP 会中断人工 wait 并进入同一 finally。finally 只终止临时目录内精确匹配
的 probe PID，并删除本次 DerivedData/app；不会碰真实 Coflux、
用户凭据、工作区或其他 TCC 条目。两个一次性 bundle ID 的 Allow/Deny 记录会留在系统中，这是
macOS 无合法 reset 的已知边界。下次必须生成新 ID，或恢复 VM/new-user 干净上下文。

本机当前仅能完成 build-only：没有第二台受控 LAN peer、Intel Mac、macOS 14 或 Developer ID
身份。macOS 27 beta 的结果也不能代替正式 macOS 版本矩阵。
