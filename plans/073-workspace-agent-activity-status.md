# Plan 073: 侧栏工作区 Agent 活动状态——正在执行 / 等待交互一眼可辨

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat bc3005f..HEAD -- proto crates/worker/src apps/server/src/hub.ts packages/client/src/store.ts apps/web/src/components/workbench/sidebar.tsx tests/src`

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: none
- Category: feature
- Execution: self
- Planned at: `bc3005f`, 2026-08-14

## Requirement

用户痛点：多工作区并行跑 claude/codex 时，侧栏看不出**哪个工作区正在执行任务、
哪个在等人回复**，只能挨个点进去看终端。产品定位是「Agent 指挥中心——人监督、随时接管」
（`docs/ROADMAP.md` 待办 1），这个状态盲区直接违背定位。

**做完之后为真**：侧栏每个工作区行能一眼分辨三态——

- **正在执行**（绿）：该工作区有 RUNNING session 最近几秒内有 PTY 输出（不限 agent，
  跑构建/测试也算在干活）；
- **等待交互**（琥珀）：该工作区有 RUNNING session 的 PTY 进程树里存在 claude/codex
  进程、但输出已安静 ≥ 约 10s（agent 停下来等人了）；
- **中性**（现状外观）：其余情况（空闲 shell、无任务、设备离线）。

状态在**页面刷新后依然成立**（不依赖本 tab 曾观察到"活跃→安静"的转变），在**没打开该
工作区终端时依然更新**（信号走中心广播，不依赖 attach）。tooltip 里能看到 agent 名字
（如「claude 等待输入」）。

判断"相邻的错误解法"：**不是**纯前端启发式（刷新即丢"曾经活跃"记录，用户已明确拒绝，
要求进程树检测一步到位）；**不是**把 Task 状态机加一档（RUNNING 之下的活跃度是易变的
派生运行时事实，不该进 Postgres 持久状态机）；**不是**在 supervisor/sessiond 里解析
VT 捕 BEL/OSC（supervisor 刻意极少升级，见 `AGENTS.md`）。

## Decisions & tradeoffs

- **「等待交互」判定 = agent 进程在 PTY 进程树内 + 输出安静**，一步到位做进程树检测。
  Rejected: 纯 client 启发式（checkpoint 新鲜度 + 活跃→安静转变）—— 用户在 dev-explore
  中明确选了进程树方案；刷新后无法区分「agent 等你」与「空闲 shell」。
  Based on: worker 已为端口探测实现完整 PTY 进程树枚举（`crates/worker/src/ports.rs:14`
  `listening_ports` / `imp::process_tree`，macOS libproc + Linux /proc，同 uid 无特权）。

- **「正在执行」判定 = checkpoint 新鲜度，不新增输出侧协议**。worker 对每个有输出的
  session ≤2s 上报一次 checkpoint（`crates/worker/src/device.rs:30` `CHECKPOINT_INTERVAL`，
  dirty 标记来自 supervisor 的 kind-1 输出通知，与是否有客户端 attach 无关，
  `crates/worker/src/main.rs:513-515`）；server 广播给账号内全部订阅客户端
  （`apps/server/src/hub.ts:439`）且订阅时补发存量（`hub.ts:1180`），client store 已存
  `sessionCheckpoints[sessionId].capturedAt`（`packages/client/src/store.ts:495-503`）。
  Rejected: 合流已 attach session 的实时输出流做双信号 —— 2s 粒度对侧栏指示灯足够，
  双信号增加复杂度不增加价值。

- **agent 识别：worker 内置名单（claude、codex），匹配进程名或命令行**。claude 可能以
  node/bun 包装运行，光看可执行名会漏；匹配规则：comm/可执行名 == 名单项，或
  basename(argv[0]) == 名单项，或 argv[0] 是解释器（node/bun/deno/python/sh 类）时
  basename(argv[1]) == 名单项。树内任一进程命中即算存在。
  Rejected: 可配置名单 —— 用户明确不需要；将来要再说。
  Rejected: 只报 bool —— 用户要 tooltip 显示 agent 名字，wire 上报检测到的名称字符串。

- **上报形态照抄端口探测的既有模式**：2s 周期、spawn_blocking 出 async 执行器、
  「变化才发全量」、认证成功后无条件补发一次防 server 重启丢状态。
  Based on: `crates/worker/src/main.rs:183-216`（`report_ports_if_changed` /
  `force_report_ports`）与 `main.rs:396-407`（2s tick）。session→(taskId,pid) 来自
  `WorkerState.alive`（`main.rs:75`）。同一轮扫描里 agent 检测与端口探测都要走进程树，
  是否复用同一次 `process_tree` 遍历由执行者定夺（每 2s 每 session 两次 BFS 也可接受）。

- **server 侧：内存 presence，不落库**。agent 存在性是易变派生运行时事实（同 relay home
  的"纯内存 presence，不进数据库"哲学，`docs/architecture.md` 5.2）。daemon 连接断开时
  必须清空该 daemon 的 agent presence 并广播清空——否则设备掉线后琥珀点永久残留。
  Rejected: 存 Postgres —— agent 起停即写库，且 daemon 崩溃后无人清理。

- **server→client 下发：新增广播消息 + 订阅/快照补发当前全量**。粒度（逐 session 增量
  或按 daemon 全量）由执行者定夺，但契约必须满足：a) 能表达"清空"（agent 退出、daemon
  断开）；b) 新订阅的 client 能立即拿到当前全量（跟 checkpoint 在 `clientSubscribe` 后
  补发同一形态，或进 `StateSnapshot` 新字段均可）；c) 消息携带 session_id、task_id 与
  agent 名称，client 能 join 到 workspace（task.workspaceId）。

- **改协议两侧同改**：`proto/` 是真相源，`buf generate` 出 TS/Rust/Swift 三端产物并全部
  提交；`crates/protocol` 与 `packages/protocol` 线格式必须一致（`AGENTS.md` 改动纪律）。
  oneof tag 取当前未用号（DaemonToServer 现最大 30，ServerToClient 现最大 33，见
  `proto/coflux/v1/daemon.proto:100-123` / `client.proto:241-265`）。

- **UI 形态（用户已拍板）**：工作区行现有 `GitBranch` 图标（`sidebar.tsx:349`）**原位替换**
  为状态图标——与设备行「direct 时闪电取代圆点」同一手法（`sidebar.tsx:523-530` 固定
  槽位注释）；**中性态保留 GitBranch 原样**（含主工作区 `text-warning` 着色）。tooltip
  沿用现有 `workspaceTooltip`（`sidebar.tsx:300-323`）加一行状态（含 agent 名）。
  Rejected: 图标槽常显状态 / 加独立状态点 / 项目折叠行聚合 / 浏览器 title 徽标 /
  桌面通知 —— 用户逐项明确不要（后三者可做后续片）。

- **阈值与优先级（decided while planning）**：绿 = 距最后输出 ≤ 5s（2s checkpoint 节奏
  ×2 + 余量）；琥珀 = agent 在树内且距最后输出 ≥ 10s；**agent 在树内且安静 5–10s 之间
  维持绿**，避免绿→中性→琥珀闪烁。同工作区多 session 状态冲突时**琥珀优先于绿**——
  「等你」是可行动信号，正是本需求的痛点。设备 `!daemon.online` 时一律中性（presence
  已不可信）。

- **时钟口径（decided while planning）**：`capturedAt` 是 daemon 侧时钟，与浏览器直接
  相减受时钟偏差影响。client 对**广播到达**的 checkpoint 用本地 `Date.now()` 记
  receivedAt 判新鲜度；订阅补发的存量 checkpoint 才退回 capturedAt 兜底。侧栏需要
  周期性重算（秒级 tick），实现方式由执行者定夺。

## Direction

数据流（新增部分加粗）：

```text
supervisor(kind-1 输出通知，已有) → worker dirty → checkpoint ≤2s（已有）→ server 广播（已有）
                                                    ↘ client sessionCheckpoints.capturedAt/receivedAt = 最后输出时间
worker 2s 周期扫 alive session 进程树 → **命中 claude/codex → SessionAgents 上报（变化才发）**
  → **server 内存 presence + 账号广播 + 订阅补发** → **client store sessionAgents**
sidebar：per workspace 聚合其 RUNNING task 的 session →（agent 在树 + 安静≥10s → 琥珀）
  |（最后输出 ≤5s，或 agent 在树且 <10s → 绿）| 否则中性；`!daemon.online` 强制中性
```

### Milestone 1: 协议契约，三端产物一致

daemon.proto 新增 worker→server 的 agent presence 上报消息；client.proto（或 common.proto）
新增 server→client 广播/快照承载。语义注释写明「派生运行时事实，server 只做内存镜像 +
广播，daemon 断开即清空」。

Validation: `cd proto && buf lint && buf generate && git diff --exit-code -- ../packages/protocol/src/gen ../crates/protocol/src/gen gen/swift` -> exit 0（产物已提交，重跑零 diff）。

### Milestone 2: worker 探测与上报

agent 名单匹配（按 Decisions 的三条规则）+ 2s 周期扫描 + 变化才发 + 认证后补发。
探测失败（进程已退、平台不支持）静默降级为"无 agent"，绝不 panic（与 ports.rs 同一契约）。

Validation: `cargo build --release -p coflux-worker` -> exit 0（CI 零警告）；`cargo test -p coflux-protocol` -> exit 0。

### Milestone 3: server 内存 presence + 广播 + 生命周期

hub 校验消息来源 daemon 归属（同 `workspaceBranch` handler 的守卫形态），维护内存
presence，变化广播账号内订阅客户端，`clientSubscribe` 时补发当前全量；daemon 断开、
task 删除时清理并广播清空。

Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0。

### Milestone 4: client store + 侧栏 UI

store 新增 sessionAgents 状态与消息处理（含 receivedAt 口径）；sidebar 工作区行按
Decisions 的阈值/优先级/门槛计算三态，GitBranch 原位替换状态图标（lucide，绿可用既有
`animate-pulse-alive`，琥珀 `text-warning`），tooltip 加状态行。图标语义遵循
`docs/design-guidelines.md`（Tooltip 组件、lucide 复用优先）。

Validation: `node_modules/.bin/tsc -b apps/web/tsconfig.json` -> exit 0；mobile 已冻结，
若 `packages/client` 变更弄坏其构建仅做最小修复（`AGENTS.md`）。

### Milestone 5: 黑盒测试

新测试文件（独占端口）：起 stack → 建 project/workspace/task 起 session → 在 PTY 里
启动假 agent（临时目录写一个名为 `claude` 的可执行脚本，内容 sleep 循环——Linux 下
comm 即 "claude"，macOS 下 argv 含该 basename，两平台都命中匹配规则）→ 断言 client
收到 agent presence（agent === "claude"）；杀掉假 agent → 断言 presence 清空。
负向：纯 shell session 不产生 presence。做一次负向验证（注释掉 server handler 或
worker 上报，确认用例确实失败）。

Validation: `node --test tests/src/<新文件>` -> exit 0。

## Landmines

- **CI 卡生成产物零 diff**：`.github/workflows/ci.yml` 跑 `buf generate` 后
  `git diff --exit-code` 校验三端产物；TS 产物内嵌 base64 描述符，**手写 gen 文件绝无
  可能**，必须真跑 `buf generate` 并提交 TS/Rust/Swift 三份。`buf breaking` 对纯新增
  字段/消息放行。

- **checkpoint 有静默丢弃路径，"绿"可能骗人**：快照超 512KiB 上限直接丢
  （`crates/worker/src/device.rs:1172`），中心离线时 checkpoint 不上报
  （`main.rs:702-704` 只在 connection_authed 后发送）。已知限制，不在本 plan 修——
  中心离线本就有全局横幅，超限快照历史上从未观测到（实测最大 ~99KB，
  `docs/architecture.md` §11）。

- **worker 的 3s git 轮询与 2s 端口轮询是两个独立 spawn 的 loop**
  （`crates/worker/src/main.rs:341` / `main.rs:396`），agent 探测别混进 git 那个（它按
  workspace 不按 session）。取 `alive` 快照即释放锁再 spawn_blocking，不跨扫描持锁
  （照 `main.rs:187` 的注释模式）。

- **`exec -a` 只改 argv[0] 不改 comm**：Linux comm 跟随被 exec 文件的 basename。
  测试用"脚本文件本身命名为 claude"最稳（两平台至少各命中一条匹配规则）；不要依赖
  `exec -a claude sleep` 这种只在部分平台命中的写法。

- **server 广播先于快照的乱序窗口**：`clientSubscribe` handler 刻意先查齐数据、最后才置
  `subscribed=true`（`apps/server/src/hub.ts:1165-1182` 注释）。agent presence 的补发
  必须进同一原子序列，不能在窗口期被并发广播抢先。

- **client store 一条消息一次 setState**：`packages/client/src/store.ts:318-320` 注释的
  原子提交约定；presence 更新别拆多次 setState。session 退出时 store 已有
  `markSessionExited` 清 inputStates 的先例（`store.ts:210-211`），sessionAgents 同样
  要在退出/任务删除路径清理，防僵尸琥珀。

- **tests 端口独占**：每个 `*.test.mjs` 顶部 `const PORT` 各用一个未占用端口
  （`AGENTS.md` 测试 harness 节），抄现有文件选新端口。黑盒本地跑需
  `COFLUX_TEST_PG_URL` 指 54322（supavisor 池化口 5432 会报 no tenant identifier）。

- **侧栏行右端已有 hover 遮罩/删除按钮联动**（`sidebar.tsx:351-390`），只动左端图标槽，
  别碰右端布局；图标槽尺寸 size-3，替换时保持槽位尺寸避免行内跳动（设备行
  `sidebar.tsx:523-524` 固定槽位注释是先例）。

## Scope

In scope:
- `proto/coflux/v1/daemon.proto`、`proto/coflux/v1/client.proto`、`proto/coflux/v1/common.proto`（如需共享消息）
- `packages/protocol/src/gen/`、`crates/protocol/src/gen/`、`proto/gen/swift/`（buf 产物）
- `crates/worker/src/`（探测模块新文件 + main.rs 挂周期/上报；ports.rs 如复用遍历可改）
- `apps/server/src/hub.ts`
- `packages/client/src/store.ts`
- `apps/web/src/components/workbench/sidebar.tsx`（及同目录新增小 hook 文件，如需秒级 tick）
- `tests/src/`（新测试文件）
- `plans/README.md`（登记 + 状态）

Out of scope:
- `crates/supervisor/`、`crates/relay/` —— 不动 session authority；dirty→checkpoint 链路已够用
- `apps/mobile`、`apps/ios` —— mobile 已冻结不加功能；仅共享层弄坏构建时最小修复
- 终端 Tab（terminal-pane.tsx）的活动状态 —— Tab 已有控制权图标，本片只做侧栏
- 项目折叠行聚合、浏览器 title/favicon 徽标、桌面通知 —— 用户明确不要 / 留后续片
- agent 名单可配置化 —— 明确不做
- `apps/server/src/store.ts` —— presence 不落库

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 协议 lint + 产物一致性 | `cd proto && buf lint && buf generate && git diff --exit-code -- ../packages/protocol/src/gen ../crates/protocol/src/gen gen/swift` | exit 0 |
| Rust 构建（CI 零警告） | `cargo build --release -p coflux-worker -p coflux-supervisor` | exit 0 |
| Rust 单测 | `cargo test -p coflux-protocol` | exit 0 |
| server 类型检查 | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| web 类型检查 | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| 黑盒测试 (acceptance) | `COFLUX_TEST_PG_URL="postgres://postgres:postgres@127.0.0.1:54322/postgres" pnpm -C tests test` | exit 0（或仅既有 baseline 失败） |

## Done criteria

- [ ] All listed commands pass.
- [ ] 黑盒断言成立：PTY 内跑名为 claude 的进程 → client 经中心广播收到 agent presence；进程退出 → presence 清空；纯 shell 无 presence。
- [ ] daemon 断开后 server 清空该 daemon 的 presence 并广播（黑盒或代码评审确认路径存在）。
- [ ] 侧栏三态按 Decisions 的阈值/优先级/`daemon.online` 门槛渲染，中性态与现状外观一致（GitBranch 原样，含主工作区着色）。
- [ ] tooltip 含状态行且显示 agent 名。
- [ ] 页面刷新后（订阅补发路径）琥珀/绿状态无需重新观察转变即可恢复。
- [ ] Required tests exist and assert meaningful behavior（做过负向验证）。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- `buf breaking` 拦下协议变更（说明改法不是纯新增，需重新设计）。
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- 进程树/进程名探测在 CI（Linux）上无法稳定命中假 agent（说明匹配规则假设错误，回来修订 plan 而不是硬调）。

## Maintenance notes

- 「等待交互」语义依赖一个经验事实：claude/codex 干活时 spinner 持续重绘（≥1 次/s），
  停下等人即输出静止。若未来某 agent CLI 工作期长时间零输出，会被误判为琥珀——阈值
  常量集中定义，便于调。
- agent presence 是内存派生事实，任何持久化企图（落库、进 Task 状态机）都在制造第二
  真相源，参考 plan 072 的教训先想清谁覆盖谁。
- 名单写死 claude/codex；加新 agent 名是 worker 一处常量改动 + 发版（worker 热升级
  可达，无需动 supervisor）。
