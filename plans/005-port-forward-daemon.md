# Plan 005: daemon 侧 —— PTY 进程树端口探测 + TCP 隧道桥

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 451f113..HEAD -- crates/worker crates/protocol Cargo.toml Cargo.lock`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: plans/004-port-forward-protocol.md
- Category: feature
- Execution: subagent sonnet
- Planned at: `451f113`, 2026-07-10

## Requirement

worker(`crates/worker`)获得两项能力,协议契约以 plan 004 落地后的
`crates/protocol` 代码为真相源:

1. **端口探测**:周期性(约 2s)枚举每个存活 PTY 会话的进程树(根 = supervisor 上报
   的 shell pid)中处于 LISTEN 状态的 TCP 端口,集合发生变化时向 server 全量上报
   `ports.update`(仅含有端口的 session)。会话退出、端口关闭都会在下一轮扫描中
   自然消失。探测失败(平台不支持/权限不足)静默降级为空集,绝不影响既有功能。
2. **TCP 隧道桥**:响应 server 下发的 `proxy.open { connId, port }`——连接本机
   `127.0.0.1:port`,成功回 `proxy.opened {ok:true}`,失败回 `{ok:false,error}`;
   之后把该 TCP 连接与 kind=4 ProxyData 帧(按 connId 多路复用)双向对拼;
   TCP 侧关闭/出错发 `proxy.closed`,收到 server 的 `proxy.close` 则关 TCP 并清理。
   多条并发连接互不干扰;server WS 断线时全部隧道连接关闭、状态清零。

正确性的分界:探测**只**覆盖 PTY 会话子进程树打开的端口——机器上其它进程
(系统服务、用户手动跑的进程)的端口绝不上报,这是产品的安全边界,不是优化。

## Decisions & tradeoffs

- **探测根 = PTY shell pid,沿进程树向下枚举**:pid 来源是 UDS 的
  `SessionStarted.pid` 与 `ResyncList`(004 已扩展携带 pid)。Rejected: 扫描全机监听
  端口再过滤 —— 无法可靠归属到会话,且违反「只暴露任务自己起的服务」边界。
  Based on: `crates/protocol/src/ipc.rs` 的 `SessionStarted`/`SessionInfo`(004 落地)。
- **平台实现:Linux 走 /proc 手撸,macOS 走 libproc**:Linux 由
  `/proc/<pid>/task/*/children` 递归取进程树、`/proc/net/tcp{,6}` 的 LISTEN 行与
  `/proc/<pid>/fd` 的 socket inode 匹配归属;macOS 用 `libproc` crate
  (proc_listchildpids + socket fd info)。均为同 uid 无特权操作。其它平台返回空集。
  Rejected: 调用 `lsof` 子进程 —— 最小化部署环境(容器)常无 lsof,且每 2s spawn
  进程的开销和解析脆弱性都更差。Rejected: 引入大而全的第三方探测 crate —— 依赖
  面大于需求,两平台手写量可控且可单测。
- **变化才上报,报则全量**:worker 维护上次上报的 `session→ports` 快照,集合相等
  不发;变化发全量。server 侧幂等(006)。重连成功(authed)后无条件补发一次当前
  全量,防 server 重启丢状态。Rejected: 每轮都发 —— 无谓噪声;增量 diff —— 两侧
  状态机复杂,幂等全量自愈性更好。
- **隧道数据帧按 ≤64KiB 分块透传,V1 不做 per-connection 流控**:读 TCP 一块发一帧。
  接受的已知取舍:单条大流量隧道可能把 `to_server` 通道推高、触发全局 PtyPause
  (见 Landmines);dev 预览场景流量小,先简单正确,per-conn credit 记为后续演进。
  Rejected: 首版实现窗口流控 —— 协议与两侧状态机成本高,当前场景收益不明。
  Based on: server 侧 `maxPayload` 4MiB(`apps/server/src/config.ts:68`),64KiB 远离
  上限;背压机制见 `crates/worker/src/main.rs:133-151`。
- **隧道状态全部活在单次 server 连接的生命周期内**:connId → 任务句柄/发送端的
  map 随 `run_server_connection` 退出而整体 abort + drop,无跨连接恢复。Rejected:
  断线重连后恢复隧道 —— 浏览器侧 TCP 早已断,恢复无意义。
  Based on: 既有连接生命周期模式(`crates/worker/src/main.rs:296-398`)。

## Direction

探测器与隧道各自成模块(如 `ports.rs`、`tunnel.rs`),挂进 worker 现有的
tokio select 事件循环;`route_authed` 新增对 `proxy.open`/`proxy.close` 的分支。
探测器需要拿到当前 alive 会话及 pid(004 适配后 worker 已持有),向 `to_server_tx`
发文本消息;隧道向 `to_server_tx` 发二进制帧。

### Milestone 1: 端口探测模块 + 单测

给定一个 pid,能枚举其进程树的 LISTEN TCP 端口。单测:测试内 spawn 一个子进程
(如 `std::net::TcpListener` 绑 127.0.0.1:0 后 fork 不现实,可 spawn
`python3/node -e` 起监听,或直接对自身 pid 断言测试内绑定的端口被发现)。
Validation: `cargo test -p coflux-worker` -> exit 0,探测用例在 macOS(本机)通过。

### Milestone 2: 周期扫描 + ports.update 上报接入事件循环

变化才发、authed 后补发全量;会话退出后端口消失。
Validation: `cargo build -p coflux-worker` 零警告;行为验证归 007 黑盒。

### Milestone 3: 隧道桥完整生命周期

proxy.open→连接→opened→双向字节透传→任一侧关闭→closed/清理;WS 断线全清。
**二进制帧分流**:来自 server 的 Binary 帧,首字节 1..=3 转 supervisor(现状),
kind=4 交隧道模块——这是对 `main.rs` 既有无条件转发的必要修改(见 Landmines)。
Validation: `cargo test -p coflux-worker && cargo build -p coflux-worker` -> exit 0
零警告(可为隧道写本地单测:mock 帧序列对拼一个本地 TcpListener)。

## Landmines

- `crates/worker/src/main.rs:382-387`:server 下发的 Binary 帧目前**无条件**
  `to_sup_tx` 转给 supervisor。不改这里,kind=4 帧会被打包成 UDS 记录塞给
  supervisor(supervisor 按 pty 帧解析失败丢弃),隧道完全不通且无报错。
- `crates/worker/src/main.rs:133-151`:全局背压监视 `to_server_tx` 水位,3/4 满即
  PtyPause 暂停全部 PTY。隧道大流量会触发它——这是已接受的 V1 取舍,但不要
  把隧道流量绕开这条通道另开 sink(会破坏 WS 写的单一出口与有序性)。
- `/proc/<pid>/task/*/children` 需要内核 CONFIG_PROC_CHILDREN(主流发行版均开);
  兜底可全量遍历 `/proc/*/stat` 的 ppid 建反向树,执行者取舍,但注意 2s 周期下
  全量遍历的成本。
- `/proc/net/tcp` 的 inode 匹配:同一 socket 可能被多个 fd 引用(fork 后),去重按
  端口集合;v6 监听(`::`)也要算(node/vite 默认常绑 v6 通配)——只报端口号,
  不区分地址族,daemon 连回环时先试 127.0.0.1 再试 [::1](或 `proxy.open` 直接
  连 localhost 交给系统解析,执行者决定,但要保证 v6-only 监听的服务可达)。
- 探测周期任务持锁读 `WorkerState.alive` 时注意别跨 await 持 `std::sync::Mutex`
  (现有代码风格是取快照即释放,见 `main.rs:315,448-457`)。

## Scope

In scope:
- `crates/worker/src/**`(新模块 + main.rs 事件循环/分流改动)
- `Cargo.toml` / `Cargo.lock`(仅新增 macOS 的 libproc 类依赖)

Out of scope:
- `crates/protocol` —— 契约已由 004 冻结;若发现缺口,STOP 上报而非自行扩协议
- `crates/supervisor` —— 隧道与探测均不涉 PTY
- `apps/server`、`apps/web`、`tests/`、docs —— 归 006/007

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Rust 单测 | `cargo test -p coflux-worker -p coflux-protocol` | exit 0 |
| 构建 | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0,零警告 |
| 黑盒回归 (acceptance) | `COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm -C tests test` | exit 0(既有用例不回归) |

## Done criteria

- [ ] All listed commands pass.
- [ ] 本机(macOS)单测证明:测试内起的监听端口能被以其父 pid 为根探测到;
      非子进程的端口不被探测到。
- [ ] Linux 路径代码完整(可编译,逻辑经 code review;运行验证归 007/Docker)。
- [ ] 隧道单测证明 connId 多路复用下双向字节透传与关闭传播正确。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- 004 落地的协议缺字段/缺消息,无法表达探测或隧道语义。
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- macOS 无特权探测走不通(libproc 拿不到他进程 socket 信息)——这推翻探测决策,
  需回报重新决策(如降级为「daemon 自身 uid 全量端口 ∩ 进程树」以外的方案)。

## Maintenance notes

per-connection 流控(credit/窗口)是已知欠账:单隧道大流量会暂停全部 PTY。
若未来支持任意 TCP 转发(非 HTTP 预览),必须先补流控。探测周期 2s 与 64KiB
分块都是经验值,可按实测调整,无协议影响。
