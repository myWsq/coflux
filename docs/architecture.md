# coflux 架构设计

> 状态：本地优先架构已实现。supervisor/sessiond 是唯一 PTY、VT、history、holder 与 sequence
> authority；同机 web 优先直连 loopback gateway，中心只负责账号、设备、项目/task 编排、opaque
> relay 与有界 checkpoint。远端或本地直连不可用时自动走中心 relay。

## 1. 产品形态

coflux 在用户任意节点运行 daemon，在本机 PTY 中驱动 Claude Code、Codex CLI、Vim 等终端程序。
web client 既可以经中心触达远端 daemon，也可以在 client 与 daemon 同机时直接连接 daemon：

```text
                                     远端 / direct 不可用
Web ── /client control WS ──▶ Server ── opaque Device relay ──▶ Worker
 │                              │                                 │
 │                              ├─ Postgres：账号/设备/项目/task   │ UDS
 │                              └─ 最近一个派生 checkpoint         ▼
 │                                                            Supervisor
 └──── ws://127.0.0.1:8788 ─────── direct Device channel ──────▶ / sessiond
                                                                  │
                                                                  └─ PTY + VT + history
```

daemon 仍主动外连中心，因此 NAT 后的远端设备不需要开放入站端口。loopback gateway 只监听本机，
不会把 daemon 暴露到 LAN 或公网。

## 2. Authority 边界

| 状态 | 唯一 authority | 其它层职责 |
|---|---|---|
| PTY 进程、VT、history、输出序号 | supervisor/sessiond | worker 只转发 DeviceEnvelope；server 不接收 raw PTY |
| holder、holder epoch、input cursor | supervisor/sessiond | client 保存待确认 input；transport 可重建 |
| Device RPC 与 mutation 去重 | worker/sessiond | direct 与 relay 共用同一 logical client、request/operation id |
| 账号、设备、Project、Workspace、Task | server/Postgres | daemon catalog 用来收敛本机事实，不反向伪造退出 |
| 离线可见画面 | server 的最新 checkpoint | 只用于展示；不裁决 holder，也不能替代首次 live snapshot |
| 浏览器终端渲染 | xterm.js | 收到 attach snapshot 后应用连续 output delta |

关键不变量：

- server、worker、transport 断开都不能停止 PTY reader 或反压本地进程。
- local catalog 缺席不等于 session 已退出；未知 live session 是 orphan，等待业务层对账。
- session 退出只由 sessiond 的 exit fact/tombstone 收敛，不由中心连通性推断。
- server 不维护实时 xterm、raw replay、viewer/holder 或全局 PTY pause。

## 3. 为什么像 tmux，又不等于 tmux

tmux 的“随时连上就恢复现场”并不是恢复进程，而是让进程从未离开：

1. 每个用户有一个长寿命 tmux server，本地 client 通过 Unix socket attach。
2. tmux server 持有 PTY master、pane/window、screen grid 与 history；client 只是视图和输入端。
3. client detach、SSH 断线或终端关闭不会影响 server 与 PTY。再次 attach 时，server 发送当前 screen
   state，之后继续增量输出，因此不需要中心服务器重放全量字节。
4. tmux server 或 OS 真正退出后，PTY/子进程也随之消失。tmux-resurrect 一类插件只能保存布局、命令和
   部分 buffer，不能把任意进程内存“复活”。

coflux 把这个核心边界映射为 `supervisor/sessiond = tmux server`，把浏览器映射为 attach client：

| 能力 | tmux | coflux |
|---|---|---|
| session authority | 本机 tmux server | 本机 supervisor/sessiond |
| 本机 attach | Unix socket | loopback WebSocket + DeviceEnvelope |
| 远端 attach | 通常先 SSH 到机器 | 中心 opaque relay，无需入站端口 |
| 重连画面 | tmux grid/history | sessiond ANSI snapshot + sequence delta |
| 写控制 | 可多 client 交互 | 单 logical holder；另一 client 必须显式 takeover |
| 中心依赖 | 无 | 首次登录/配对、冷启动、编排需要；cached direct 热路径不需要 |
| server/OS 重启后保活 | 不保证 | 不保证 |

因此产品边界是：已加载且已配对的页面，在中心完全停止后仍可对存活 session 做 catalog、attach、
snapshot、input、resize 与 stop；不承诺中心离线后的刷新/冷启动，也不承诺 supervisor 或 OS 重启后
恢复活进程。

## 4. 进程与本地 IPC

daemon 全 Rust、零 Node 运行时，分成两个进程：

- `coflux-supervisor`：极少升级；持有 PTY、VT/history、holder/sequence、exit tombstone；管理 worker
  版本与观察期回滚。
- `coflux-worker`：频繁热升级；负责中心 WS、loopback gateway、本地授权、git/exec/fs、Device RPC、
  relay 与 checkpoint。

二者通过权限为 `0600` 的 UDS 通信。内部帧中：

- kind 1 保留为 session dirty 通知，只携带 session id，不携带 raw PTY；
- kind 2/3 是已删除的 input/replay 编号，永久保留并拒绝解码；
- kind 5 承载 transport-neutral DeviceEnvelope。

worker 重启时 supervisor 与 PTY 不动；新 worker 通过 resync/catalog 重新建立 transport 与派生缓存。

## 5. DeviceTransport

### 5.1 direct

desktop web 默认尝试 `ws://127.0.0.1:8788`。首次配对由已认证中心连接协助安装 Origin 绑定的持久
grant；之后浏览器身份、grant 与 generation 可在中心离线时复用。gateway 只接受精确 Origin，握手
校验签名、nonce、期限和速率限制。

cached direct 的 terminal 与普通 Device RPC 不等待中心：browser → loopback gateway → worker → UDS
→ sessiond。中心仍可并行承载低频 control 和 checkpoint，但不在热路径上。

### 5.2 relay 与自动切换

无缓存、固定端口占用、Origin/LNA/loopback permission 拒绝或 direct 故障时，DeviceRouter 立即使用
中心 relay。server 的 `DeviceRelayRouter` 只按账号/daemon/channel 路由 opaque frame，不解析终端或
RPC 载荷。direct 恢复后，router 用更高 transport generation 自动 promotion；同一 logical client、
holder 与 input queue 不变。

mobile 已冻结，不启用 loopback direct；它使用同一 DeviceRouter 的 relay-only 配置，因此没有旧
`taskAttach/ptyInput/ptyOutput/clientExec/clientFs*` 兼容路径。

### 5.3 顺序、去重与背压

- input 带 `holderEpoch + inputSeq`。sessiond 只顺序应用，重复项返回累计 ACK，gap 不越级执行。
- client 只用累计 `PtyInputAck.appliedThroughSeq` 清理队列；ACK 丢失后在新 transport 原序重投。
- mutation 使用 operation id 与有界 ledger，direct/relay 重投只产生一次外部 effect。
- output 带单调 sequence。发现 gap 时 client 重新 attach/snapshot，不把缺口静默拼接。
- 每 channel 有记录数和字节数上限；gap 有独立优先槽。checkpoint 同一 session 只保留最新值，慢/断
  中心不会积压 PTY。

## 6. Attach 与现场恢复

attach 在 session mutex 内完成 holder 校验、resize、snapshot 与订阅建立：

```text
DeviceSessionAttach(resumeFromSeq?, clientInstanceId, generation)
  ├─ 可连续恢复：DeviceSessionAttached + replay delta
  └─ history 不足/首次 attach：DeviceSessionAttached(ansiSnapshot, snapshotSeq)
       后续只接受 fromSeq = snapshotSeq + 1 的 DevicePtyOutput
```

snapshot 是 sessiond 当前 VT/history 的 ANSI 重建，不是 raw byte replay。独立 `@xterm/headless` 6 oracle
把原始录制流喂给终端 A、snapshot 喂给全新终端 B，再追加相同 tail，比较公开 buffer/cell/mode 状态。
CI fixture 包含脱敏 Claude CLI、Codex CLI 与 Vim/TUI 录制。

首版 fidelity 契约：

| 保证恢复 | 明确不保证 |
|---|---|
| Unicode 宽字/组合字、完整逻辑行 history、wrap | sixel/kitty/iTerm images |
| cursor 位置与可见性 | OSC 8 link metadata、title/icon name |
| normal/alternate screen | cursor shape/color |
| application cursor/keypad、bracketed paste | blink/strike/invisible/underline variants |
| 16/256/RGB 前后景、bold/dim/italic/underline/inverse | focus/mouse/kitty keyboard state |

“不保证”表示 attach 后可能丢失该元数据或模式，不表示相关 escape sequence 会导致 session 崩溃。

## 7. 中心控制面与 checkpoint

中心保存 Account → Device → Project → Workspace → Task 元数据，并处理登录、设备授权、task create、
worktree、端口预览、升级与 prepared operation。Session 本身不落盘。

worker 至多每 2 秒请求脏 session 的当前 snapshot，并通过独立 coalescing outbox 上报。server 每 session
只持最近一个 `snapshotSeq/capturedAt/cols/rows/ansiSnapshot`，单份上限 512 KiB：

- daemon 离线时 client 可展示最近画面；
- checkpoint 永远不能授予 holder、清 input queue 或跳过 live attach；
- 较旧或重复 sequence 被丢弃；task/session 归属不匹配的上报被拒绝。

旧 server xterm live mirror、raw `ptyOutput/ptyReplay`、`TaskAttach/TaskDetached` 与 server-routed exec/fs
协议已经删除，原字段编号和名称在 protobuf 中永久 `reserved`。

## 8. 生命周期与故障语义

| 故障 | 行为 |
|---|---|
| client→server control 断开 | cached direct session lane 继续；冷启动与新业务编排不可用 |
| direct 失败/权限拒绝 | 自动 relay；不把 daemon 误报为 offline |
| relay/中心失败 | direct 已建立时继续 catalog/attach/input/resize/stop |
| worker 重启 | supervisor/PTY 存活；generation 增加并重建 channel/catalog |
| server 重启 | Postgres 元数据 + daemon catalog/checkpoint 对账；不杀 unknown orphan |
| 慢中心 | relay/checkpoint 可丢弃或滞后；本地 PTY 与 direct channel继续 |
| supervisor/OS 重启 | 不保证活进程恢复，明确超出 V1 范围 |

Task 创建和首次 session create 属于中心编排；本地 stop 是 sessiond 事实，中心 task 删除是独立的
业务元数据操作。中心不可达时 stop 仍成功，exit tombstone 会在重连后收敛；若要永久删除 task，用户在
控制面恢复后另行执行。

## 9. 端口预览

worker 只探测 PTY 进程树内的 LISTEN 端口，上报中心生成 `<shortId>.<proxyHost>`。浏览器先换一次性授权
code，再由账号 cookie 进入代理。HTTP/SSE/WebSocket 都通过 `ProxyData` 隧道；这类远端端口流量明确
经过中心，不属于 local-first terminal/RPC 热路径。

## 10. 认证与安全边界

- daemon 通过浏览器一次性授权换取服务器签发的每设备凭证；token 在 server 只存 sha256 hash。
- client token 绑定账号；所有 control、relay、checkpoint 与 proxy 都校验账号/daemon 归属。
- loopback identity/grant store 与 daemon 凭证落在 `COFLUX_HOME`，权限 `0600`；`cofluxd doctor` 不输出
  私钥、grant id、token 或凭证内容。
- exec/fs 由 worker 根据中心同步的 workspace id 解析 root，并做 realpath 锚定；不信任 browser 自报 cwd。
- 信任模型仍是单用户自有机器；coflux 不是多租户代码执行沙箱。

## 11. 诊断与发布证据

`cofluxd doctor` 分开报告：

1. 中心 DNS、TCP、TLS、WebSocket；
2. gateway bind；
3. 持久 grant/Origin 数量；
4. loopback WebSocket 主机侧可达性；
5. daemon→中心连接状态。

本地项失败结论是“直连降级，中心 relay 仍可用”，中心失败但本地正常则明确 cached direct 仍可用。

2026-07-25 在 Apple M1 Pro、`a3592ff` debug daemon、默认 2000 行 history（本次最大 snapshot
98,939 bytes）上的可复现 benchmark（Node v26.3.0 + `@xterm/headless` 6，不含 DOM renderer；
20 warmup + 100 samples，`performance.now()`）：

| 指标 | p95 | 发布门 |
|---|---:|---:|
| cached direct PTY echo | 0.589 ms | < 20 ms |
| Device attach + 全新 xterm 6 解析到可用画面 | 64.820 ms | < 100 ms |
| timed direct path 中心 `deviceRelayFrame` 增量 | 0 | = 0 |

2026-07-25 在 `a89476b` 上二次复现同一 benchmark：echo p95 0.771 ms、attach p95 59.838 ms、
中心帧增量 0，SLO 仍全部通过（采样波动在门限内）。

浏览器实机矩阵是独立发布门：macOS 当前稳定版 Chrome、Safari、Firefox 都要覆盖 cached direct、首次
relay+pair、permission denied、fallback/promotion、worker restart、server outage。本轮记录：

| 浏览器 | 版本 | 结果 |
|---|---|---|
| Chrome stable | 本机 Chrome 150.0.7871.187（CDP 控真实实例，非 headless shell） | PASS，6 场景全过；发现 3 个 UI/收敛缺陷（见下表） |
| Safari stable | 本机 Safari 27.0（macOS 27.0 build 26A5378n） | 本轮不做（2026-07-25 决定）：自动化需手动开启「开发 → 允许 Apple 事件的 JavaScript」或 `safaridriver --enable` |
| Firefox stable | 未安装 | 本轮不做（2026-07-25 决定） |

矩阵门范围因此收窄为 Chrome：本地优先直连在 Safari/Firefox 上未经实机验证，两者的 loopback
WebSocket、LNA/permission 行为都属未知，不得据本表宣称跨浏览器可用。要扩回三浏览器时，
按上表 6 个场景逐项复跑并补记版本与结果。

2026-07-25 Chrome 150 实机结果（dev 栈：vite 5273 + server 8787 + `.coflux-dev` daemon，
gateway 8788；transport mode 取自 sidebar 设备行 `title`，direct 由 `lsof` 确认 Chrome↔worker
loopback TCP，输入副作用用 append-only 文件计数）：

| 场景 | 观测 |
|---|---|
| cached direct | 设备行 `同机 Device 数据直连本地 daemon`；Chrome PID↔`coflux-worker` `127.0.0.1:8788` ESTABLISHED；输入副作用恰好一次 |
| 首次无缓存 relay+pair | 清 IndexedDB 后：probing 341 ms → `中心 opaque relay` 425 ms → `本机直连` 525 ms（后台 pair 完成即升直连） |
| loopback 被拒 | 注入 `WebSocket` 对 `:8788` 抛 `SecurityError`：立即 relay，detail 带拒因，无 loopback TCP；relay 下 attach/input/resize 全部可用（36×132 → 37×118） |
| relay fallback（真实） | 先占满 `127.0.0.1`/`::1` 的 gateway 端口使 worker bind 失败：328 ms 落 relay；释放端口后 worker 自动重试 bind 成功 |
| worker restart | `kill -9` worker（supervisor 存活）：`本地 gateway 连接已关闭` → 探测 → 直连恢复，全程 591 ms；PTY pid 不变、历史完整、输入不重复 |
| server outage | `kill -9` server：detail 转 `中心离线；本地 session read/control 仍可用` 且仍是直连；list/attach（snapshot 全量恢复）/input/resize（37×118 → 39×160）/stop（PTY 真退出）全部成立；中心重启后横幅自动消失 |

同一轮实机暴露 3 个缺陷（黑盒 wire 测试结构上覆盖不到：它只验证协议行为、不渲染 DOM），
均已在同一轮修复并实机复验：

1. 中心离线横幅 `fixed top-0 h-7` 压住终端 tab 栏（tab 矩形 y=4..32），`elementFromPoint`
   命中横幅——中心离线期间鼠标点不到任何终端 tab 与关闭按钮，与「中心离线仍可 attach/stop」
   相抵。修复：断线时根容器同步 `pt-7` 给横幅留白（终端 fit 由 ResizeObserver 跟随）。
   复验：断线横幅在场时 tab 落到 y=32，四个 tab 的 `elementFromPoint` 全部命中自身。
2. `closeTask()` 在 `stopSession` 抛错时直接中止，不再删 catalog task：daemon/supervisor
   重启后残留的 task（PTY 已不存在）永远关不掉。根因在 router——`session_not_found` 不 reject
   holder 等待，调用方只能空等到 holder 超时、拿到无从判定的原因。修复：router 收到
   `session_not_found` 立即带 code 拒掉 holder waiter（`device-router.test.ts` 有回归用例），
   `closeTask` 见此 code 时继续删 task。复验：实机点关闭，僵尸 tab 全部可清。
3. 同一函数在 `controlAuthenticated` 为 false 时静默跳过 `taskRemove` 且不排队补偿。
   修复：中心离线时记账，`authOk` 后按序补投（`logout` 清空，避免跨账号误删）。
   复验：中心停止时关终端 → PTY 立即退出、tab 暂留；中心重启后 tab 自动消失。

已知次要项（未修）：中心恢复后 device transport detail 仍停留在 `中心离线；本地 session
read/control 仍可用`（未 republish，直连本身正常）；缓存 grant 里的 gateway 端口与实际监听
端口不一致时不刷新 grant，direct 只在 gateway 回到 grant 记录端口后才恢复（默认端口固定，
触发面窄）。

实机结果不能用 Playwright 模拟替代：本轮的 6 个场景都在真实 Chrome 与真实 daemon/server 进程上跑。

## 12. 仓库结构与验证

```text
apps/server       中心 control / opaque relay / checkpoint / Postgres
apps/web          desktop React + xterm.js（默认迭代对象，启用 direct）
apps/mobile       冻结的 relay-only client
packages/client   control store + DeviceRouter
packages/protocol TS protobuf 绑定
crates/protocol   Rust protobuf、UDS frame/IPC
crates/supervisor PTY/sessiond authority
crates/worker     gateway、relay、RPC、checkpoint、升级 adapter
tests             真实进程 + WebSocket 黑盒 harness
```

协议真相源是 `proto/`，Buf 生成 TS/Rust/Swift。发布门包括 Buf lint/codegen、client 状态机、server/web
typecheck、mobile build、Rust test/build、独立 VT oracle、全黑盒、benchmark、浏览器矩阵和
`git diff --check`。黑盒只用临时 `COFLUX_HOME`、端口、数据库 schema 与进程组，不触碰真实 daemon。
