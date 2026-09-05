# coflux 架构设计

> 状态：本地优先架构已实现；relay 数据面已剥离为可多节点部署的独立服务（plan 043/065）；
> 非同机设备可经 P2P WebRTC DataChannel 端到端直连（plan 076）。supervisor/sessiond
> 是唯一 PTY、VT、history、holder 与 sequence authority；同机 web 优先直连 loopback gateway，
> 中心只负责账号、设备、项目/task 编排、relay/P2P rendezvous 与有界 checkpoint。
> 直连（loopback 或 P2P）不可用时自动经独立部署的 `coflux-relay` 中转。

## 1. 产品形态

coflux 在用户任意节点运行 daemon，在本机 PTY 中驱动 Claude Code、Codex CLI、Vim 等终端程序。
web client 既可以经中心触达远端 daemon，也可以在 client 与 daemon 同机时直接连接 daemon：

```text
Web ── /client control WS ──▶ Server ──(rendezvous：签 token / 转 SDP+通知拨号)──▶ Worker
 │                              ├─ Postgres：账号/设备/项目/task            │
 │        直连均不可用           └─ 最近一个派生 checkpoint                 │ UDS
 ├── wss://relay/…?token ──▶ coflux-relay ◀── wss 拨号 ───────────────────┤
 │        （每 channel 一条 WS，opaque DeviceEnvelope bytes，零解析）        ▼
 ├──── WebRTC DataChannel ── P2P 端到端直连（不经任何中间节点）──────────▶ Supervisor
 │                                                                     / sessiond
 └──── ws://127.0.0.1:8788 ─────── direct Device channel（同机）───────▶   │
                                                                        └─ PTY + VT + history
```

daemon 仍主动外连中心，因此 NAT 后的远端设备不需要开放入站端口。loopback gateway 只监听本机，
不会把 daemon 暴露到 LAN 或公网；P2P 的 UDP socket 由 ICE/DTLS 保护，只与信令认证过的对端
握手。

## 2. Authority 边界

| 状态 | 唯一 authority | 其它层职责 |
|---|---|---|
| PTY 进程、VT、history、输出序号 | supervisor/sessiond | worker 只转发 DeviceEnvelope；server 不接收 raw PTY |
| holder、holder epoch、input cursor | supervisor/sessiond | client 保存待确认 input；transport 可重建 |
| Device RPC 与 mutation 去重 | 当前 worker runtime / 当前 supervisor runtime 内的 sessiond | direct 与 relay 共用同一 logical client、request/operation id；生命周期边界见 5.3 |
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
| 远端 attach | 通常先 SSH 到机器 | 中心 rendezvous + 独立 opaque relay，无需入站端口 |
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

### 5.1 direct 槽位：loopback 与 P2P

direct 槽位内部有两个候选，优先级 loopback > P2P；槽位整体与 relay 竞争（hedge + generation
promotion，见 5.2）。

**loopback**：desktop web 默认尝试 `ws://127.0.0.1:8788`。首次配对由已认证中心连接协助安装
Origin 绑定的持久 grant；之后浏览器身份、grant 与 generation 可在中心离线时复用。gateway 只
接受精确 Origin，握手校验签名、nonce、期限和速率限制。cached direct 的 terminal 与普通
Device RPC 不等待中心：browser → loopback gateway → worker → UDS → sessiond。中心仍可并行
承载低频 control 和 checkpoint，但不在热路径上。

**P2P（WebRTC DataChannel，plan 076）**：非同机设备的直连主路径。信令照 relay rendezvous
三角走中心控制 WS（client 带完整 offer SDP → 中心校验归属并附 account/scopes 转发 → worker
回 answer），vanilla ICE（两端各等 gathering 完成一次性交换，不做 trickle——建连 1-3s 由
relay 先行 + promotion 掩盖）；中心不签 token，对端身份由信令信道已认证 + SDP 内 DTLS
fingerprint 绑定保证。PeerConnection 按 daemon 常驻（client 有完整需求时建立），DataChannel
按 logical channel（label == channelId），channel 级 scopes 仍由中心逐 channel 授予。帧走
长度前缀分片流（`P2P_CHUNK_BYTES` = 16KiB，取 webrtc-rs 接收上限与 Chrome 256KiB 的交集），
出向有 SCTP 缓冲背压。**P2P 属在线授权语义**：worker 自己的 `/daemon` 控制连接断开时立即
关闭全部 PeerConnection（relay 同理），它没有 loopback grant 那样的离线存活。浏览器的
`/client` 是另一条独立控制连接：普通 transport 短断并不证明 worker 授权已失效，client 会立即
停止新 rendezvous、撤 online lease/control waiter/elevated lane，但给已经建立的 relay/P2P
session lane 15 秒有界宽限；同凭据 `authOk` 窗口内恢复则复用原 channel，超时或 authError、
clientOutdated、换凭据、reset/destroy/logout 等 hard revoke 立即关闭。

worker 侧经 `webrtc`（webrtc-rs）实现 answer 端：枚举全部非 loopback 接口（LAN/Tailscale/
公网 v4v6）作 host candidates（该库不做接口枚举，bind 什么地址 candidate 就是什么），answer
的 DTLS 角色显式设 passive（对端做 client——双方实现互通性最好的路径）。STUN 列表由中心
`COFLUX_STUN_URLS` 下发两端（authOk / deviceP2pDial），默认空 = 纯 host candidate。

预期设定：daemon 在有公网 IP 的 VPS 上时建连近必成（client 出站方向 connectivity check 即可
配对）；同 LAN host candidate 直连；CN↔CN 打洞成功时流量不出境（绕开 hairpin 与 GFW）；
**P2P 不解决 GFW 干扰**——跨境线路被掐时它与 relay 走同样的 IP 路径同样受影响；对称 NAT/
CGNAT 打洞失败自动回落 relay，零损失。打洞成功率待生产实测回填。

（历史：2026-08-25 macOS native probe 曾用 M151 libwebrtc offerer 与 `webrtc-rs 0.20.2`
worker 验证跨栈互通；项目已于 2026-08-26 撤回，证据见
`plans/083-macos-native-client-feasibility-gates.md` 与 git 历史。其中对现行架构仍有效的
结论——Router 判活必须同时依赖 control disconnect 与 application ping/timeout，不能只看
transport 回调——已由 plan 080 的心跳判死落地。）

### 5.2 relay 与自动切换

无缓存、固定端口占用、Origin/LNA/loopback permission 拒绝或 direct 槽位（loopback 与 P2P）
故障时，DeviceRouter 立即走 relay；P2P 建连慢于 200ms hedge，常态是 relay 先赢、P2P 就绪后
以更高 generation 自动 promotion。relay 是独立部署的 `crates/relay` 单二进制（plan 043）：中心在 rendezvous 阶段校验账号/
daemon 归属后给两端各签一张短时（≤120s）单次 ed25519 token 并拼出完整拨号 URL；client 与 worker
各自拨一条 channel 专属 WS，relay 按 channelId 配对成 opaque 字节管道——零解析 DeviceEnvelope、
无账号 DB、限速限量与旧中心内嵌 relay 相同。数据帧从此不经过中心控制 WS；中心零 channel 状态，
channel 断开由 client 重新 rendezvous。daemon 侧零驻留连接（按需拨号）；worker 在中心控制连接
断开时主动关闭全部 relay channel（语义与旧路径一致）。direct 恢复后，router 用更高 transport
generation 自动 promotion；同一 logical client、holder 与 input queue 不变。

多节点使用 daemon home relay 模型：中心在 daemon 认证后下发静态节点清单；worker 把每个 ws/wss
基址换成 http/https 后 GET `/healthz`，多次采样取 RTT 中位数并带滞后选择 home，周期重探，relay
拨号失败时立即重探。daemon 上报 home id 后，中心把同一 channel 的 client 与 daemon **都**指向该
节点；尚未上报时回退清单首项。relay 节点之间没有互联或转发，client/web/iOS 也不接收清单、不做
探测，只消费 rendezvous 返回的单个 `relay_url`。home 是在线连接的纯内存 presence，不进入数据库。

生产可在多地 VPS 各运行一份 `coflux-relay`，由当地 Caddy 终结 TLS 并把 `/healthz`、`/v1/pipe`
反代到 relay 的明文监听端口。所有节点注入同一个 `COFLUX_RELAY_PUBKEY`；中心保留对应的单一
`COFLUX_RELAY_SIGNING_KEY`，并配置按优先回退顺序排列的节点列表：

```sh
COFLUX_RELAY_NODES='[{"id":"jp","url":"wss://relay-jp.example.com"},{"id":"us","url":"wss://relay-us.example.com"}]'
```

`id` 应短、稳定且唯一；列表首项必须是最稳的主节点，因为旧 worker、刚连接尚未完成探测的 worker
都回退到它。改清单后重启中心，daemon 随控制 WS 重连取得新列表。只部署单节点时可继续只设
`COFLUX_RELAY_URL`，中心会合成 `id=default` 的单项清单，拨号行为与原来一致。relay 仍不向中心注册，
也不持账号/节点数据库；两者之间没有连接，耦合面只有共享签名密钥。

**STUN 部署（P2P 打洞增强，可选）**：不配 STUN 时 P2P 只用 host candidates——daemon 在公网
VPS / 与 client 同 LAN 的场景已可用；要覆盖双端都在 NAT 后的打洞才需要 STUN。在 relay 节点
（如 owo-jp-gw）旁跑标准 coturn 即可：

```sh
apt install coturn
# /etc/turnserver.conf 只需两行（纯 STUN，零认证零中继）：
#   stun-only
#   listening-port=3478
systemctl enable --now coturn
# VPS 防火墙放行 UDP 3478；中心配置并重启：
COFLUX_STUN_URLS=stun:relay-jp.coflux.dev:3478
```

中心把该列表随 authOk 下发 client、随 deviceP2pDial 下发 daemon；两端各自向 STUN 询问反射
地址生成 srflx candidates。无 TURN——coflux relay 本身就是打洞失败的兜底层。另注意 daemon
所在 VPS 的防火墙需放行**出站已建立的 UDP 会话**（ICE 的 UDP socket 是 ephemeral 端口；
worker 主动向 client candidate 发起 check，conntrack 放行回包即可，无需入站白名单）。

mobile 已冻结，不启用 loopback direct；它使用同一 DeviceRouter 的 relay-only 配置，因此没有旧
`taskAttach/ptyInput/ptyOutput/clientExec/clientFs*` 兼容路径。

### 5.3 顺序、去重与背压

- input 带 `holderEpoch + inputSeq`。sessiond 只顺序应用，重复项返回累计 ACK，gap 不越级执行。
- client 只用累计 `PtyInputAck.appliedThroughSeq` 清理队列；ACK 丢失后在新 transport 原序重投。
- 去重不提供跨任意故障域的 generic exactly-once，边界由持有 ledger 的 authority 决定：
  - PTY input 以及 session create/stop 由 sessiond 去重，可跨 direct/relay transport 与 worker
    replacement；ledger 不跨 supervisor/OS restart。
  - 其余 worker mutation（project/worktree/exec/fs 等）只在当前 worker runtime 内去重；worker
    replacement 后不能依赖同一 operation id 阻止外部 effect 再次发生。
- `execRun` 在 worker 崩溃后可能已经启动甚至完成外部命令，却来不及记录结果；此时结果未知，调用方
  不得自动重试非幂等命令，也不能宣称 exactly-once。
- 稳定路径的 `fs.write` 是全量覆盖：状态未知时以相同 path/data 重试可收敛到同一内容。这是基于
  最终结果的幂等，不是严格一次执行。
- worktree 操作可用稳定路径与 Git 状态做专用探测、恢复与收敛；这类语义必须由具体操作定义，不能
  从通用 operation ledger 推导。
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

### 7.1 中心发起的 prepared 执行（plan 091）

prepared operation 原本只有 browser 一种发起方：中心 prepare（落库）→ 经控制 WS 把模板装到 daemon →
安装确认后把帧交给浏览器 → 浏览器经 Device channel 投递 → daemon 校验帧与模板一致后执行 → 结果沿
`DeviceOperationReport` 回中心收敛。plan 091 让中心（MCP 写 tools）也能做发起方，差别只在「谁触发执行」
与「结果通知谁」，落库/校验/收敛/广播全部复用：

```text
MCP tool ──▶ hub 操作层（准入事务 + prepare(metadata.initiator = "server")）
   │              │ installed / restore→installed
   │              └──控制 WS──▶ PreparedDeviceOperationExecute{operation_id}
   │                                worker：取本地已安装模板 → Principal::Server + 合成 channel
   │                                `__coflux-server-<operation_id>` → 与 browser 同一条分派
   │              ◀──控制 WS── DeviceOperationReport → 同一个收敛事务落库 / 广播
   └── 完成原语（按 operationId / taskId 的有界 Deferred）──▶ tool 返回结果或可读错误
```

- **不做虚拟 channel**：数据帧仍不经中心控制 WS，中心零 channel 状态；只新增逐操作的控制消息。合成 channel
  不注册进 worker 的 channels 表，往它回的应答按既有逻辑丢弃，只有 OperationAck/Error 经 report 回中心。
- **幂等**：中心 restore（server 重启 / daemon 重连）会重装模板并再次 Execute；worker 对已执行的 operation_id
  只重发上次 report、在飞则忽略，绝不二次 `git worktree add` / 二次建会话。
- **命令终端**：`DeviceSessionCreate.command` 非空时 worker 在 authorize 通过后本地写包装脚本（登录 shell 执行、
  `tee` 落日志、跑完退出带退出码）并把 `shell` 填成脚本路径；路径按 operation_id 确定性派生，因为 sessiond
  账本的 canonical 请求含 `shell`，重放时路径若变会被判成 `operation_collision`。
- **读/写走直发**：`ServerAgentRequest/Result`（server→daemon 请求 + 回执，各带 oneof）承载无落库副作用的动作：
  读命令日志尾部/本地快照（设备离线退回中心 checkpoint）、经 `agent_send_input` 正门写输入（人类 holder 在场
  即拒，holder/input_seq/attach 语义零改动）。停止复用 `sessionClose`。
- **能力门禁**：daemon 认证/登记时宣告 `capabilities`（`prepared_execute`、`terminal_io`），中心按能力名而非版本号
  判定；缺失时写 tool 在 prepare **之前**返回「该设备的 daemon 需要升级」，不给旧 worker 留下永远不触发的
  installed 记录。旧 worker 对未知 ServerToDaemon 载荷静默丢弃，这是不能靠超时兜底的原因。
- **有界等待**：Claude Code 远程 MCP 单请求 60 秒；建/删操作等 30 秒、`wait_terminal` ≤ 50 秒，到期返回
  「已提交」或当前状态而不是挂着。daemon 断开/换代/撤销、任务删除、中心关闭都以可读错误唤醒等待者。

以后新增「中心自己要驱动 daemon 做事」的需求，先走这条路（prepare + Execute + 收敛），不要再开直发消息；
直发只留给无落库副作用的动作。

## 8. 生命周期与故障语义

| 故障 | 行为 |
|---|---|
| browser `/client` control 普通短断 | cached direct 继续；既有 relay/P2P session lane 最多保留 15 秒，同凭据 `authOk` 窗口内复用；online lease、elevated lane、新 rendezvous 与业务编排立即禁用，超时/hard revoke 关闭远端 lane |
| worker `/daemon` control 断开 | 立即关闭 relay/P2P channel；supervisor/PTY 继续，控制面恢复后重建 |
| direct 失败/权限拒绝 | loopback 失败续试 P2P，均败自动 rendezvous+relay；不把 daemon 误报为 offline |
| P2P 打洞失败/中断 | 回落 relay；relay 稳定后按退避重试 loopback→P2P promotion |
| relay/中心失败 | loopback direct 已建立时继续 catalog/attach/input/resize/stop；中心离线时无法开新 relay/P2P channel（rendezvous/信令依赖中心）；既有远端 channel 按上面两条独立控制连接的信号收敛 |
| worker 重启 | supervisor/PTY 存活；generation 增加并重建 channel/catalog |
| server 重启 | Postgres 元数据 + daemon catalog/checkpoint 对账；不杀 unknown orphan |
| 慢中心 | relay/checkpoint 可丢弃或滞后；本地 PTY 与 direct channel继续 |
| supervisor/OS 重启 | 不保证活进程恢复，明确超出 V1 范围 |

Task 创建和首次 session create 属于中心编排；本地 stop 是 sessiond 事实，中心 task 删除是独立的
业务元数据操作。中心不可达时 stop 仍成功，exit tombstone 会在重连后收敛；若要永久删除 task，用户在
控制面恢复后另行执行。

## 9. 端口预览

worker 只探测 PTY 进程树内的 LISTEN 端口，上报中心生成 `<shortId>-<proxyHost>`。浏览器先换一次性授权
code，再由账号 cookie 进入代理。HTTP/SSE/WebSocket 都通过 `ProxyData` 隧道；这类远端端口流量明确
经过中心，不属于 local-first terminal/RPC 热路径。

## 10. 认证与安全边界

- daemon 通过浏览器一次性授权换取服务器签发的每设备凭证；token 在 server 只存 sha256 hash。
- server 签发的 client 会话 token 绑定账号；所有 control、rendezvous、checkpoint 与 proxy 都校验账号/daemon 归属。
- relay 不持账号 DB：只验中心签发的短时单次 token（ed25519，domain 分离），同 channel+role 二连
  拒后到者，channel 结束后 tombstone 窗口内拒绝 token 重放。
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
| timed direct path relay 帧增量 | 0 | = 0 |

（plan 043 起中心控制 WS 上已无 relay 帧消息，该门的观测对象改为 relay transport 双向
帧计数——`tests/src/local-first-benchmark.mjs` 的 `relayFrameSnapshot`，语义不变：timed
direct 热路径零 relay 经手。）

2026-07-25 在 `a89476b` 上二次复现同一 benchmark：echo p95 0.771 ms、attach p95 59.838 ms、
中心帧增量 0，SLO 仍全部通过（采样波动在门限内）。

浏览器实机矩阵原始目标是在 macOS 当前稳定版 Chrome、Safari、Firefox 覆盖 cached direct、首次
relay+pair、permission denied、fallback/promotion、worker restart、server outage；当前阻断范围按
2026-07-25 决策收窄为 Chrome。本轮记录：

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
apps/server       中心 control / relay rendezvous / checkpoint / Postgres
apps/web          desktop React + xterm.js（默认迭代对象，启用 direct）
apps/mobile       冻结的 relay-only client
apps/ios          原生 iOS client（SwiftUI + SwiftTerm）
packages/core     TS 共享日志等基础设施
packages/client   control store + DeviceRouter
packages/protocol TS protobuf 绑定
packages/swift-client Swift protobuf、Client Core 与 Apple 平台 transport
packages/cli      cofluxd 安装/服务管理/doctor CLI
crates/protocol   Rust protobuf、UDS frame/IPC
crates/supervisor PTY/sessiond authority
crates/worker     gateway、relay 拨号、RPC、checkpoint、升级 adapter
crates/relay      独立 relay：token 验签 + channel 配对 + opaque 管道
tests             真实进程 + WebSocket 黑盒 harness
```

协议真相源是 `proto/`，Buf 生成 TS/Rust/Swift。自动发布门包括 Buf lint/codegen、TS/Swift client
状态机、server/web typecheck、web/mobile build、iOS build-for-testing、Rust test/build、独立 VT
oracle、全黑盒和 `git diff --check`；benchmark 与当前 Chrome 实机门仍需发布前人工签字。Safari/
Firefox 当前不是阻断门且可用性未知，原生 iOS 真机生产验收仍待用户。黑盒只用临时
`COFLUX_HOME`、端口、数据库与进程组，不触碰真实 daemon。
