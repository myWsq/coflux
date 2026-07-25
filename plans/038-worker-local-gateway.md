# Plan 038: worker loopback gateway + 双 transport

> 本计划是 outcome contract，不是逐函数脚本。理解需求与已记录决策后，针对实时代码自行
> 设计实现。遇到 STOP condition 必须停止。完成后更新 `plans/README.md`。
>
> Drift check: `git diff --stat febdd62..HEAD -- crates/worker/src crates/worker/Cargo.toml crates/protocol/src crates/supervisor/src/main.rs packages/cli/cofluxd.mjs`

## Status

- Priority: P1
- Effort: L
- Risk: HIGH
- Depends on: plans/036-local-first-session-device-contract.md
- Category: feature
- Execution: self
- Planned at: `febdd62`, 2026-07-24

## Requirement

让频繁升级的 Rust worker 同时承载固定 loopback gateway 与现有中心连接，把本地和 relay
channel 归一为同一 Device RPC runtime，并通过 plan 036 IPC 驱动 sessiond。gateway 必须在
中心断开时依靠持久 browser grant 重新认证已配对页面，只开放离线 session scope；中心在线
时用短期 lease 开放完整 daemon RPC。worker 崩溃/升级后应重绑端口、恢复 grant 并从
supervisor resync，而不影响 PTY。

## Decisions & tradeoffs

- **gateway 放 worker，不放 supervisor**：HTTP/WS、Origin、WebCrypto 对应验证、中心 lease 与
  git/fs/exec 都是频繁演进逻辑；稳定 supervisor 只暴露受保护 UDS。当前发布本来只含两个
  Rust 二进制（`packages/cli/cofluxd.mjs:1-4`, `.github/workflows/release.yml:95-104`），不新增
  第三个常驻进程。
- **只绑定 loopback 固定端口**：默认 8788，同时尝试明确的 IPv4/IPv6 loopback，不监听 LAN；
  dev/test 可 env 覆盖或绑定 0。bind 失败只使 direct degraded，中心连接必须继续工作。
- **严格 Origin + 双向 challenge**：握手前拒绝非中心下发/持久化 allowlist 的 Origin；gateway
  用持久 P-256 key 签 hello，browser 用已安装 grant key 签 transcript；nonce 单次使用且有
  TTL/rate limit。拒绝 wildcard CORS、query token 与“localhost 即可信”。
- **grant 持久、elevated lease 易失**：gateway key 与 browser grant 原子落 `$COFLUX_HOME`、
  mode 0600；online lease 只在内存且中心连接断开立即降权。显式解绑前 offline session grant
  有效，接受中心撤销在离线期间延迟。
- **中心 token 不进入 loopback**：浏览器账号 token、daemon deviceToken 均不得出现在本地
  handshake、URL、日志或 Device frame。
- **统一 router**：project validate/worktree、session、exec/fs、ports 等已有 worker 能力都由同一
  request ID/op ID router 调用；direct 与 relay 只提供 principal/channel，不复制业务 handler。
  当前这些 handler 集中在 `route_authed`（`crates/worker/src/main.rs:745-804`），应演进而不是复制。
- **离线 scope 硬门控**：中心连接状态与 lease 同时决定 elevated 权限；离线只能 list/attach/
  input/resize/stop 已存活 session，不能 project/task CRUD、任意 exec/fs 或新建 PTY。
- **每 channel 独立背压**：worker 向中心、loopback client、checkpoint 的队列分别有界；慢 channel
  丢 delta/标 gap。拒绝当前根据 `to_server` 总容量向 supervisor 发全局 pause
  （`crates/worker/src/main.rs:239-260`）。
- **checkpoint 是 coalescing side channel**：dirty session 生成有界 viewport/recent-tail 快照，
  中心上行只保留最新待发 checkpoint；绝不阻塞 local/relay terminal stream。

## Direction

### Milestone 1: 本地身份存储与握手

gateway/device key、grant store、Origin allowlist、nonce transcript 与 P-256 双向验证有正负单测；
重启加载后仍可认证，篡改、重放、错误 origin/daemon/key 均拒绝。Validation:
`cargo test -p coflux-worker local_auth` -> exit 0。

### Milestone 2: loopback gateway 生命周期

worker 启动即尝试绑定，bind 失败降级不退出；worker restart 在固定端口恢复服务；协议版本不兼容
明确拒绝并允许 web 回退。Validation: `cargo test -p coflux-worker local_gateway` -> exit 0。

### Milestone 3: 统一 Device router 与 scope

local/relay request 进入同一 router；offline grant 与 online lease 的权限矩阵、request/op 去重、
response correlation、stream channel/gap 都有单测。Validation:
`cargo test -p coflux-worker device_router` -> exit 0。

### Milestone 4: sessiond resync 与独立背压

worker 与 supervisor 重连后重建 catalog/channel；中心断开或 queue 满不会向 sessiond 发全局
pause；checkpoint 合并且恢复后可发送最新序列。Validation:
`cargo test -p coflux-worker transport_backpressure` -> exit 0。

## Landmines

- `server_loop` 当前是主任务，中心连接内同时持有 receiver（`crates/worker/src/main.rs:489-525`）；
  gateway 不能被它的重连/backoff 生命周期包住。
- worker 目前把 `authed` 同时当作“可做后台观测”和“可路由 server 命令”的总开关
  （`crates/worker/src/main.rs:727-741`）；local offline session 能力需要独立状态机。
- 当前 supervisor UDS 只有一个物理 worker 连接是可接受的；不要为 logical client 开多个 UDS，
  应在同一连接内 multiplex channel。socket 至少要 0600，并防旧连接清掉新连接。
- `settings.json` 只含 server/device/shell（`packages/cli/cofluxd.mjs:20-27`）；gateway key、grant 与
  lease 不应混进用户可编辑 settings。
- WebSocket Origin 是安全输入，必须取 upgrade header，不信 Device payload 自报。

## Scope

In scope:
- `crates/worker/src/**`
- plan 036 已冻结依赖下的 worker 单元/夹具

Out of scope:
- server 持久化/授权 API
- web WebCrypto/transport router
- LAN/P2P、本地 UI assets、service worker
- public preview 域名替换；本地 reverse proxy 留给集成后的独立增强

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Worker tests | `cargo test -p coflux-worker` | exit 0，零 warning |
| Protocol tests | `cargo test -p coflux-protocol` | exit 0 |
| Daemon build | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0，零 warning |

## Done criteria

- [ ] 所有列出的 commands 通过。
- [ ] gateway bind/认证失败不影响中心 relay 可用性。
- [ ] 正确配对页面可在中心断开后重新建立 local session channel。
- [ ] 离线 elevated RPC 全拒，在线 lease 下完整 Device router 可用。
- [ ] 两种 transport 共享 handler、request/op 去重与 session stream 语义。
- [ ] worker/中心慢或断开不会暂停 supervisor PTY。
- [ ] secret 文件 0600，敏感值不进日志。
- [ ] 实现遵循所有 Decisions & tradeoffs。
- [ ] 未修改 out-of-scope 文件。
- [ ] `plans/README.md` 状态已更新。

## STOP conditions

- 主流 browser 与 Rust P-256 signature 格式无法互操作且合同需变更。
- `ws://` loopback server 无法在目标 Rust 平台构建或会迫使 supervisor 暴露网络端口。
- 完整 RPC router 需要信任 browser 提供未被中心同步的任意 workspace root。
- validation 在一次合理修复后连续失败两次。

## Maintenance notes

gateway 是中心页面的本地 transport，不是新的匿名 localhost API。以后扩展本机预览代理或 LAN
直连时，必须复用同一 principal/scope/lease，不能开旁路端口绕过授权。
