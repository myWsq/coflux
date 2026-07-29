# Plan 065: 独立 relay 第二片 —— 多节点就近：中心下发列表、daemon 探测选 home、rendezvous 按 home 指路

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat bd88f86..HEAD -- crates/relay/ crates/worker/ apps/server/src/ proto/coflux/v1/daemon.proto tests/src/ docs/architecture.md`

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: none（前置 043 独立 relay 第一片已 DONE）
- Category: feature
- Execution: agent:codex
- Planned at: `bd88f86`, 2026-07-29

## Requirement

plan 043 把 relay 数据面剥离成了独立单二进制（`crates/relay`），但生产只有一个
relay 节点：中心 rendezvous 从单一 `COFLUX_RELAY_URL`（`apps/server/src/config.ts:79`）
取地址签 token。用户在多地时，远端 client↔daemon 仍可能绕远路。

本片完成后（Tailscale home-DERP 同款模型）：

1. 中心配置**多个** relay 节点（静态列表），经 daemon 控制 WS 在认证完成后下发。
2. daemon 对各节点做 HTTPS RTT 探测，选最近的作为自己的 **home relay** 上报中心；
   周期性重探，拨号失败立即重探。
3. rendezvous 时中心把 client 和 daemon 都指到**该 daemon 的 home relay**——一条
   channel 两端必须落同一节点（relay 按 channelId 配对、节点间无互联），home 模型
   天然满足；daemon 未上报时回退列表首项。
4. client/web/iOS **零改动**：它们只消费 rendezvous 返回的 `relay_url`。

判别正确与相邻错误：改完后若「client 侧需要探测或收到节点列表」或「rendezvous
响应从单 URL 变成候选列表」或「relay 之间出现互联/转发」或「relay 节点信息进了
DB」，即为走错方向。单节点配置（只配 `COFLUX_RELAY_URL`）下行为必须与今天完全
一致。

## Decisions & tradeoffs

- **选点模型 = daemon home relay**：daemon 探测选 home 并上报，rendezvous 把两端
  都指到 daemon 的 home。Rejected: 双端探测+中心裁决（plan 043:223 的草案）——
  client 是浏览器/iOS，探测时机与缓存复杂，且 relay 贴 daemon 端时总延迟
  client→relay→daemon 已接近 client→daemon 直线，双端裁决收益极小。Rejected:
  relay mesh（DERP 完整形态）——多一跳、relay 不再零状态、要维护节点间拓扑。
  Based on: relay 按 channelId 配对两条 WS、无节点互联（`crates/relay/src/main.rs`）。
- **清单来源 = 中心静态配置**：新增 env `COFLUX_RELAY_NODES`（JSON 数组
  `[{id, url}]`，id 短稳定、url 为对外 wss 基址）；未配置时由既有
  `COFLUX_RELAY_URL` 合成单节点列表，行为与今天完全一致（含 dev 默认
  `ws://127.0.0.1:8790`）。列表首项 = 回退用主节点，文档写明。Rejected: DB 表 +
  管理界面——自用产品、节点个位数，过度设计。Rejected: relay 自注册——打破
  「relay 与中心之间没有任何连接/依赖」的既有架构性质
  （`docs/architecture.md:112-114`）。Based on: `apps/server/src/config.ts:79`。
- **探测机制 = relay 新增 `/healthz` + HTTPS GET 计时**：daemon 对每个节点的
  `/healthz` 计时、多次取中位数选最小；切换 home 需显著更优（滞后防抖，阈值执行
  者定，建议 ≥20ms 且 ≥20% 量级）；周期性重探（分钟级），relay 拨号失败立即触发
  重探。Rejected: TCP connect 计时——Caddy 活着而 relay 进程死了会误报健康。
  Rejected: 对 `/v1/pipe` 发无效 WS 握手计时——靠错误路径当探测，日志噪声。
  Based on: relay 现仅认 `/v1/pipe`，其余路径握手期 404（`crates/relay/src/main.rs:205`）。
- **故障切换 = 探测自愈、单 URL**：`DeviceRelayDial` / `DeviceRelayGrant` 协议
  **不动**（`proto/coflux/v1/device.proto:180-205`），rendezvous 仍下发单个
  relay_url。home 挂 → daemon 探测发现后切换并上报，下次 rendezvous 自动指新节
  点，自愈窗口≈探测周期；期间 client 重试 rendezvous 即可。Rejected: 下发有序候
  选列表两端按序尝试——proto/client/daemon 三处都要加一致性逻辑（两端必须落同一
  候选），复杂度明显上升，自用场景 relay 挂机是罕见事件。
- **下发/上报通道 = 既有 daemon 控制 WS**：`ServerToDaemon` oneof 新增节点列表消
  息（认证完成后下发一次；中心改配置=重启=全体 daemon 重连自动拿新列表，不需要热
  推送）；`DaemonToServer` oneof 新增 home 上报消息（home relay id，可附各节点
  RTT 供日志/展示；daemon 重连后重报）。home 存 `DaemonConn` 内存态
  （`apps/server/src/hub.ts:96-101`），零 DB、零新表。Based on: 信封定义
  `proto/coflux/v1/daemon.proto:88,216`；注册路径 `hub.ts:248 registerDaemonConn`。
- **兼容回退**：daemon 未上报 home（旧版本 worker、或探测尚未完成）→ rendezvous
  用列表首项。旧 worker 收到新 oneof 消息按 prost 未知字段语义忽略（执行时验证这
  一点，若旧 worker 会因未知 payload 断连则需版本门，先例：`supportsRelayDial`，
  `apps/server/src/relay-rendezvous.ts`）。
- **密钥 = 全节点共用**：所有 relay 节点用同一 `COFLUX_RELAY_PUBKEY`，中心一个签
  名种子，token 不绑节点。Rejected: per-node 密钥——token 已短时（TTL≤120s）+
  绑 channelId，节点级隔离无实际威胁模型收益，轮换成本翻倍。Based on:
  `apps/server/src/config.ts` relaySigningKeySeed 注释、`crates/relay/src/main.rs:133`。
- **worker 探测的 HTTP 实现保持 rustls 栈**：不引 openssl（交叉编译约束：
  `Cross.toml` + release 产物矩阵）。用最小可行方案（reqwest rustls feature 或手
  写 GET 均可，执行者定，倾向最小依赖）。Based on: worker 现无 HTTP client 依赖，
  WS 栈为 tokio-tungstenite rustls（`crates/worker/Cargo.toml`）。
- **(decided while planning) 探测地址推导**：探测 URL 由节点 `url`（ws/wss 基址）
  换 scheme 为 http/https 拼 `/healthz` 推导，不单独配探测地址——少一个配置项，
  且生产链路（Caddy 终结 TLS）下二者天然同源。

## Direction

数据流：中心启动解析节点列表 → daemon 认证完成后收到列表 → 探测循环选 home →
上报 → 中心存 presence → rendezvous 按 daemon home 签发两端 URL。分四个里程碑：

### Milestone 1: relay 支持 `/healthz`

relay 对明文 HTTP GET `/healthz` 返回 200（生产由 Caddy 终结 TLS 转明文；探测与
监控共用）。`/v1/pipe` 行为不变。
Validation: `cargo test -p coflux-relay` -> exit 0（含 healthz 响应与 pipe 回归
用例）。

### Milestone 2: proto + 中心侧

`daemon.proto` 新增两条消息并再生成产物；中心解析 `COFLUX_RELAY_NODES`（未配置
回退 `COFLUX_RELAY_URL` 单节点）、认证后下发列表、接收 home 上报入 presence、
rendezvous 按 home（无上报→首项）签发 URL。
Validation: `pnpm --filter @coflux/server build` -> exit 0；
`cd tests && node --import tsx --test src/relay-token.test.mjs src/relay-dial-version.test.mjs` -> exit 0（既有回归）。

### Milestone 3: worker 侧探测与上报

worker 收列表起探测循环（多次取中位数、滞后防抖、周期重探、拨号失败立即重探），
选 home 上报；列表为空或全部探测失败时不上报（中心自然回退首项）。
Validation: `cargo test -p coflux-worker && cargo build -p coflux-worker` -> exit 0。

### Milestone 4: 黑盒验收 + 文档

新增黑盒用例覆盖：双 relay 节点下 daemon 上报 home 且 rendezvous 双端 URL 指向
home；kill home 节点后探测自愈切换、下次 rendezvous 指向存活节点；未上报 home
（模拟旧 worker）回退列表首项。`docs/architecture.md` 更新多节点形态与
`COFLUX_RELAY_NODES` 部署说明（多地 VPS：coflux-relay 二进制 + Caddy + 同一公
钥）。
Validation: `cd tests && node --import tsx --test src/relay-multi-node.test.mjs`
-> exit 0（新用例文件名执行者可调整，README 状态行注明实际文件）。

## Landmines

- relay 的连接处理走 tokio-tungstenite WS 握手回调（`crates/relay/src/main.rs:199-206`），
  普通 HTTP GET 不是 Upgrade 请求——`/healthz` 需要在 WS accept 之前识别明文
  HTTP（peek/手解首行），不能指望握手回调天然放行。
- relay token TTL 上限 120s 必须 ≤ relay 侧 tombstone 窗口（`apps/server/src/config.ts`
  relayTokenTtlMs 注释）——本片不要动 TTL 相关常量。
- 旧 worker 对新 `ServerToDaemon` payload 的行为要实测：若未知 oneof 导致断连而
  非忽略，必须按 `supportsRelayDial`（`apps/server/src/relay-rendezvous.ts`）先例
  加版本门再下发列表。
- `pnpm dev:relay`（`package.json:12`）单节点 127.0.0.1:8790；黑盒双节点场景需在
  harness 里起第二个端口实例（参照 `tests/src/device-harness.mjs` 起 relay 的方
  式），不要改动既有 dev 脚本语义。
- proto 生成产物入库（`proto/gen/swift/` 可见 device.pb.swift）：改 `daemon.proto`
  后按仓库既有 codegen 流程再生成全部产物一并提交；iOS 不消费 daemon.proto，行为
  零影响，但生成物过期会脏 drift check。

## Scope

In scope:

- `crates/relay/`（healthz）
- `crates/worker/`（列表接收、探测、上报；`Cargo.toml` 允许为探测加最小 rustls 系依赖）
- `apps/server/src/`（config、hub、relay-rendezvous）
- `proto/coflux/v1/daemon.proto` 及其生成产物（TS/swift）
- `tests/src/`（新增多节点黑盒 + 既有 relay 用例回归性修补）
- `docs/architecture.md`、`plans/README.md`

Out of scope:

- `packages/client/`、`apps/web/`、`mobile/`、`ios/` —— client 零改动是本方向的判别条件
- `proto/coflux/v1/device.proto` 的 `DeviceRelayDial`/`DeviceRelayGrant` 语义 —— 协议不变
- relay 节点间互联/转发、P2P —— 记录在 ROADMAP 的后续方向
- DB schema —— home 是纯内存 presence
- 生产多地 VPS 的实际开通与 DNS —— 部署文档到位即可，实机操作由用户执行

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Rust 构建+单测 | `cargo build --workspace && cargo test -p coflux-relay -p coflux-worker` | exit 0 |
| server typecheck | `pnpm --filter @coflux/server build` | exit 0 |
| 定向黑盒（relay） | `cd tests && node --import tsx --test src/relay-*.test.mjs` | exit 0 |
| 全量黑盒 (acceptance) | `pnpm --dir tests test` | exit 0（既有已知 flaky 基线见 plan 059 状态行） |

## Done criteria

- [ ] All listed commands pass.
- [ ] 双节点黑盒：rendezvous 双端 URL 指向 daemon 上报的 home；kill home 后自愈
      切换；未上报回退首项。
- [ ] 只配 `COFLUX_RELAY_URL`（不配 NODES）时行为与 bd88f86 完全一致。
- [ ] client/web/iOS 无任何文件变更。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- 旧 worker 收到新 payload 断连且版本门方案也无法兼容在线存量 daemon。

## Maintenance notes

- 加/换 relay 节点 = 改中心 `COFLUX_RELAY_NODES` 重启中心；daemon 重连自动拿新列
  表并重探。节点 `id` 保持稳定（上报与日志以 id 对账）。
- 列表首项兼有「未上报回退」职责，应始终配置为最稳的主节点。
- 公钥轮换流程沿用 plan 043 维护注记（先双公钥并存再撤旧），多节点时逐节点滚动。
- 自愈窗口 ≈ 探测周期；若未来觉得分钟级太慢，再考虑 rendezvous 下发候选列表（当
  时被拒的方案，复议入口在此）。
