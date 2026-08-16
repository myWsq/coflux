# Plan 076: P2P 直连第一片——WebRTC DataChannel 作为第三 transport（web+worker）

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 50d8c69..HEAD -- proto/coflux/v1/device.proto crates/protocol crates/worker packages/protocol packages/client apps/server/src/hub.ts tests/src docs/architecture.md`

## Status

- Priority: P1
- Effort: L
- Risk: MED
- Depends on: none（前置 043 独立 relay、065 多节点均已 DONE 在 main）
- Category: feature
- Execution: self
- Planned at: `50d8c69`, 2026-08-16

## Requirement

对应 `docs/ROADMAP.md:68` 既定条目。用户没有更近的 relay 节点可开（065 的多节点
价值前提不存在），CN↔JP hairpin 的 relay 延迟是主痛点。目标：client 与 daemon 之间
建立 WebRTC DataChannel 端到端直连，作为 direct 槽位里 loopback 之后的第二候选；
relay 保持打洞失败的兜底层，语义零变化。

完成后为真：
- 非同机的在线设备，在双端 UDP 可达时（daemon 公网 VPS / 同 LAN / 打洞成功），
  terminal 与 Device RPC 热路径走 DataChannel，不经 relay 节点；侧栏 transport
  文案能区分 P2P 与 relay。
- 任一环节失败（ICE 不通、信令超时、DataChannel 中断）自动回落 relay，用户无感；
  P2P 恢复后按既有 transport generation promotion 升回。
- 30MB 上限的 DeviceEnvelope 帧（`fs.write` 上传）能完整过 DataChannel。
- supervisor 与 loopback gateway/grant 体系零改动——P2P 改动全在 worker，生产随
  热升级到达。

正确/错误解的分界：P2P 是**纯 transport**，不得触碰会话语义（holder/inputSeq/
mutation ledger/output sequence 全部 transport 无关，`docs/architecture.md:134-141`）；
不得为 P2P 新造授权体系（沿 relay rendezvous 的中心授权语义）；不得把 P2P 做成
与 direct/relay 并列的第三方竞争者（并入 direct 槽位，见决策）。

预期设定（写进文档，不许诺打洞成功率）：daemon 在公网 VPS 时近必成；CN↔CN 打洞
成功流量不出境（绕开 hairpin 与 GFW，收益最大场景）；跨境线路被 GFW 干扰时 P2P
与 relay 同样受影响（P2P 不解决 GFW）；对称 NAT/CGNAT 失败回落 relay 零损失。

## Decisions & tradeoffs

- **Router 结构：P2P 并入 direct 槽位，不加第三竞争方**。direct 槽位内部优先级
  loopback > P2P；槽位间仍是 direct vs relay 两方竞争 + 200ms hedge + generation
  promotion，全部复用。Rejected: openP2p 作为第三个 adapter 方法参与三方竞争——
  竞争/promotion 状态机要重写，收益为零。
  Based on: `packages/client/src/device-router.ts:115-122`（adapter 仅
  openDirect/openRelay 两方法）、`:974-991`（hedge 结构）。
- **信令：照抄 plan 043 rendezvous 三角，走中心控制 WS**。新增 P2P 消息对
  （client→server 申请携带 SDP offer；server→daemon 下发 offer + account/scopes；
  daemon→server→client 回 SDP answer），中心做归属校验后转发并授 scopes，daemon
  信任控制面（同 `DeviceRelayDial` 语义）。中心不签 token——P2P 不经过任何中心
  基础设施，身份由"信令经已认证控制 WS + SDP 内 DTLS fingerprint 绑定"保证
  （标准 WebRTC 安全模型）。Rejected: 复用 relay token——P2P 没有可验 token 的
  中间节点。Based on: `proto/coflux/v1/device.proto:184-211`。
- **vanilla ICE，不做 trickle**。两端各等 ICE gathering 完成后一次性交换完整 SDP，
  信令只需一问一答；建连慢 1-3s 由"relay 先行 + promotion 升级"掩盖，用户无感。
  Rejected: trickle ICE——信令消息变成双向多条流，中心转发复杂度翻倍，换来的建连
  提速在 promotion 模式下不可感知。慢于预期再迭代。
- **worker 侧 WebRTC 栈用 crates.io 的 `webrtc`（webrtc-rs 项目），版本执行时取
  最新稳定**。全家桶（ICE/DTLS/SCTP/DataChannel）、tokio 原生、API 类浏览器。
  Rejected: str0m（sans-IO，DataChannel 要自己泵 IO，工作量大）；
  node-datachannel/libdatachannel 绑定（跨语言原生依赖，与纯 Rust daemon 冲突）。
- **PeerConnection per-daemon 常驻（route 有 full demand 时建立并保持），
  DataChannel per logical channel**。Rejected: per-channel PeerConnection——
  ICE+DTLS 每次 1-3s 重付；零驻留（学 relay）——P2P 建连太贵，断开即毁会导致
  每次 lane 切换重打洞。仅测量需求（侧栏读数）的 route 不建 PeerConnection，
  沿用现有"非 full demand 走纯 relay 短路"。
  Based on: `device-router.ts:964-972`（routeHasFullDemand 短路）。
- **中心断开时 worker 主动关闭全部 P2P 连接，与 relay 语义一致**。P2P 的授权来自
  中心 rendezvous（在线授权），中心断开则权威消失。Rejected: P2P 跨中心断开存活
  ——那需要把 loopback 的 offline grant 体系泛化到 P2P，是另一个 plan 的事。
  Based on: `crates/worker/src/relay_dial.rs:1-6`（relay 断开收敛语义）、
  `docs/architecture.md:108-109`。
- **分帧层：DataChannel 消息 = 长度前缀分片流**。DeviceEnvelope 帧上限 30MB
  （`crates/protocol/src/lib.rs:62`），Chrome DataChannel 单消息接收上限 256KB，
  必须分片。格式：4 字节大端 length prefix + 按固定 chunk（≤64KB，取安全值）切分，
  SCTP reliable+ordered 下等价字节流，接收端按前缀重组。chunk 尺寸与格式常量进
  `packages/protocol` / `crates/protocol` 共享（TS/Rust 各自实现分帧逻辑）。
  发送端必须依 bufferedAmount 背压（bufferedAmountLowThreshold 事件/轮询），
  不许一次灌 30MB 进 SCTP 缓冲。Rejected: SCTP max-message-size 协商大消息——
  Chrome 宣告 256KB 是硬上限，不可协商绕过。
- **ICE servers（STUN）由中心 env `COFLUX_STUN_URLS` 配置、随控制面下发两端；
  默认空 = 纯 host candidate**。空配置下 VPS（daemon host candidate 即公网 IP，
  client 出站方向 connectivity check 可成）与同 LAN 场景已可用，STUN 只为跨 NAT
  打洞增益。STUN 自建 owo-jp-gw（coturn stun-only），出部署文档，实机操作按惯例
  用户执行，不阻塞本 plan 验收。无 TURN——coflux relay 就是兜底层。
  Rejected: 硬编码公共 STUN（Google STUN 大陆不可达，第三方不可控）。
- **黑盒测试的 client 侧对端用 werift（纯 TS WebRTC，tests devDependency）**，
  与 worker 的 webrtc-rs 跨栈互通跑全链路（信令→建连→分帧→回落→promotion）。
  预设降级路径：若 werift↔webrtc-rs 互通存在无法合理修复的兼容坑（执行时判断，
  两次尝试为限），黑盒降级为"信令转发正确性 + P2P 失败回落 relay + worker 侧
  answer 生成"三件，DataChannel 数据面留给浏览器实机走查（按惯例用户执行），
  并在 plan 状态行记录降级。Rejected: node-datachannel（原生依赖进 CI）。
- **mobile 与 iOS 零改动**。mobile 冻结且 relay-only（`enableLocalTransport` 关闭
  即不进 direct 槽位，P2P 天然不启用）；iOS 是 Swift 栈需 WebRTC.framework，
  后续单独立项。Based on: `docs/architecture.md:131-132`。
- **(decided while planning) client 侧 RTCPeerConnection 经 router 既有窄边界
  注入**：`device-router.ts` 的测试哲学是生产用全局对象、单测注入纯内存实现
  （`:112` 注释），P2P 沿此模式，不为 node 环境在生产代码里做 polyfill 分支。

## Direction

信令与数据流：client（offerer，createDataChannel 触发）等 gathering 完成→ 经控制
WS 发 offer → 中心校验 daemon 归属、附 account/scopes 转发 → worker 建
PeerConnection、等 gathering 完成回 answer → 原路返回 → ICE/DTLS 建连 →
per-channel DataChannel 上跑分帧后的 DeviceEnvelope，worker 侧泵接
`DeviceRuntime`（open/close/handle_frame 语义对齐 relay 路径，含
`CHANNEL_QUEUE_BYTES` 背压，`crates/worker/src/device.rs:28`）。

### Milestone 1: 协议契约落地

proto 新增 P2P 信令消息（buf breaking 兼容，学 043 的 reserved 纪律）+ 分帧常量
进 TS/Rust protocol 包。三端生成产物零 diff。
Validation: `buf lint` + `buf generate` 后 `git status` 生成目录零脏 →
`cargo build -p coflux-protocol` + `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` exit 0。

### Milestone 2: worker P2P 栈

webrtc-rs 引入；新模块（形态照抄 `relay_dial.rs`：per-connection spawn、
ChannelReceiver 泵出、入向帧交回 DeviceRuntime、断开收敛）；answer 生成；
分帧收发含背压；控制 WS 断开关闭全部 P2P。分帧逻辑有 Rust 单测（含 >256KB
帧的切分重组与畸形前缀拒收）。
Validation: `cargo build -p coflux-supervisor -p coflux-worker` 零警告 +
`cargo test -p coflux-worker` exit 0。

### Milestone 3: server 信令转发

hub.ts 转发 offer/answer、归属校验复用 rendezvous 的校验、scopes 授予同
`DeviceRelayDial`、`COFLUX_STUN_URLS` 解析并随控制面下发两端。
Validation: server tsc --noEmit exit 0（行为由 M5 黑盒覆盖）。

### Milestone 4: client P2P transport

direct 槽位内部扩展：loopback（有 grant 且同机可达）失败或无 grant 时尝试 P2P；
分帧层；transport 文案区分（侧栏 detail 用语对齐既有 direct/relay 文案风格）；
promotion 复用验证。router 内写死"direct=loopback/仅同机"的注释与短路逻辑
（`device-router.ts:964-966、:1228、:1896` 附近）一致更新。
Validation: `pnpm -C packages/client test`（若无独立脚本则
`node --test` 对应单测文件）+ web/client tsc --noEmit exit 0。

### Milestone 5: 黑盒全链路

新用例文件（独占端口，遵循 `tests/src` 端口惯例）：werift 对端走完
信令→建连→帧收发→大帧（>256KB）分片重组→P2P 断开回落 relay→relay 先行后
promotion 升 P2P。负向验证：抽掉 server 转发后用例必须红。
Validation: `node --test tests/src/<新文件>` exit 0 → 全量 `pnpm -C tests test`
不低于既有基线（唯二 cli-doctor 环境基线失败为已知）。

### Milestone 6: 文档

`docs/architecture.md` DeviceTransport 节补 P2P（含预期设定与"不解决 GFW"），
STUN/coturn 部署文档（含 `COFLUX_STUN_URLS` 配置）进 architecture.md 部署段或
独立 docs 文件，`docs/ROADMAP.md:68` 条目更新。
Validation: 人工读查（无命令）。

## Landmines

- **交叉编译**：daemon 多平台发版走 `Cross.toml`；webrtc-rs 的 crypto 依赖链
  （ring 等）必须在全部发版 target 上可编译。065 有先例教训：tokio-rustls 默认
  features 拖进 aws-lc。引入依赖后**尽早**对发版 target 跑一次 cross build，
  失败即触发 STOP 复议（换 features 或换栈）。
- **Chrome SCTP 上限是接收方向宣告的硬限**：发端（webrtc-rs）超过对端 SDP 宣告
  的 max-message-size 会静默断 channel。chunk 尺寸必须取 ≤64KB 安全值，不许
  依赖协商放大。
- **vanilla ICE 在 Chrome 侧**：需等 `icegatheringstatechange === 'complete'` 再取
  localDescription；ICE servers 为空时 gathering 立即完成，配了不可达 STUN 则要
  等超时——client 侧信令整体超时要覆盖这个最坏情况。
- **router 的"direct=同机"假设散布在注释与短路里**（`device-router.ts:964-966`、
  `:1228`、`:1896`）：P2P 推翻"非同机不试 direct"的前提，漏改会导致 P2P 对远程
  设备根本不被尝试；但"仅测量 route 不进 direct"的短路必须保留（否则侧栏为每台
  设备建 PeerConnection）。
- **黑盒 harness 哲学**：`tests/src/device-harness.mjs:1-6` 故意不 import 应用
  代码。werift 对端同样直连 protobuf 真相源 + 分帧格式的内联重实现，不得 import
  `packages/client` 的分帧实现（否则测试与被测物共享缺陷）。
- **worker 泵接背压**：`CHANNEL_QUEUE_BYTES = MAX_DEVICE_FRAME_BYTES + 2MB`
  （`device.rs:28`）是既有 channel 语义，P2P 入向不得绕过；出向 30MB 帧灌
  DataChannel 必须走 bufferedAmount 门控，否则 SCTP 缓冲爆内存。
- **测试 PG/Docker**：全套黑盒大面积超时先查 OrbStack/Docker 半死
  （`docker ps` 挂不挂），别当代码回归；本机黑盒 PG 就是 5432。

## Scope

In scope:
- `proto/coflux/v1/device.proto`（+ buf 生成产物 `proto/gen/**`、
  `packages/protocol/src`、`crates/protocol/src`）
- `crates/worker/src/**`（新 P2P 模块 + device.rs 泵接 + main.rs 装配）
- `Cargo.toml` / `Cargo.lock`（webrtc-rs 依赖）
- `apps/server/src/hub.ts`（信令转发 + STUN 配置下发；连带的小型 server 装配文件）
- `packages/client/src/device-router.ts`（+ 其单测）
- `apps/web` 仅限侧栏 transport 文案消费面（如有）
- `tests/src/`（新黑盒用例 + `tests/package.json` 加 werift devDependency）
- `docs/architecture.md`、`docs/ROADMAP.md`、`plans/README.md`

Out of scope:
- `crates/supervisor/**` —— supervisor 不动纪律，P2P 全在 worker
- `crates/relay/**`、065 多节点发版 —— relay 语义零变化
- `apps/mobile/**`（冻结）、iOS Swift 端（后续单独立项）
- loopback gateway/grant/local_auth 体系 —— P2P 不走 loopback 授权
- trickle ICE、P2P 跨中心断开存活、TURN —— 明确后续迭代
- STUN 实机部署（owo-jp-gw 装 coturn）—— 文档产出在内，操作由用户执行

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| proto 契约 | `buf lint && buf generate` 后生成目录零脏 | exit 0 |
| Rust 构建 | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0 零警告 |
| Rust 单测 | `cargo test -p coflux-worker -p coflux-protocol` | exit 0 |
| server 类型 | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| 全量黑盒 (acceptance) | `pnpm -C tests test` | 不低于既有基线（唯二 cli-doctor 环境项为已知） |
| 交叉编译抽查 | 对发版 target 的 cross build（见 `Cross.toml`/RELEASING） | exit 0 |

## Done criteria

- [ ] All listed commands pass.
- [ ] 黑盒新用例覆盖：P2P 建连收发、>256KB 大帧重组、P2P 失败回落 relay、
      relay→P2P promotion；且做过负向验证（抽掉 server 转发即红）。
- [ ] 同机黑盒环境里禁用 loopback（无 grant/占端口）时 transport 落 P2P 而非 relay。
- [ ] `COFLUX_STUN_URLS` 未设时全链路可用（纯 host candidate）。
- [ ] supervisor、relay、mobile、loopback 授权体系零 diff。
- [ ] Implementation follows every entry in Decisions & tradeoffs（含 werift
      降级路径被触发时按决策记录）。
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- webrtc-rs 在任一发版 target 交叉编译失败且无低成本 features 修复。
- werift 互通失败**且**降级后的三件套黑盒也无法证明信令/回落正确性。
- 实现 P2P 需要触碰 supervisor 或 loopback 授权体系。
- 一条 Decisions & tradeoffs 引用的代码事实已不成立。
- 验证命令在一次合理修复后仍连续失败两次。

## Maintenance notes

- P2P 与 relay 共享"中心在线才有授权"语义；未来若做"中心离线 P2P 存活"，入口
  是把 loopback 的 offline grant 泛化，勿在 rendezvous 语义上打补丁。
- chunk 尺寸/分帧格式一旦发版即是线上契约（新旧 worker/web 混布），改格式需带
  版本协商，protocol 包常量旁应有注释警示。
- 打洞成功率生产实测后回填文档；若 CN↔CN 场景成功率低于预期，下一步是 trickle
  ICE 与 srflx 增强，而不是 TURN。
