# Plan 116: executor 引擎与通路——内置 pi agent，agent 经 `cofluxd executor` 甩子任务，桌面 utilityProcess 执行、Seatbelt 锁在工作区内

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 7deedfb..HEAD -- proto/coflux/v1/device.proto crates/worker/src/agent_ctl.rs crates/worker/src/hook.rs crates/worker/src/agents.rs crates/worker/src/device.rs crates/worker/src/gateway.rs crates/cli/src/commands.rs crates/cli/src/gateway.rs crates/cli/src/main.rs apps/desktop/src/main apps/desktop/electron-builder.yml apps/desktop/package.json packages/client/src/device-router.ts apps/desktop/src/renderer/components/workbench/workbench.tsx apps/desktop/src/renderer/components/workbench/account-footer.tsx packages/cli/skills/coflux/SKILL.md`

## Status

- Priority: P2
- Effort: L
- Risk: HIGH（新增跨 daemon/桌面的执行通路 + 仓库内首个 `utilityProcess` + Seatbelt 沙箱策略 + 一条已确认的沙箱逃逸向量要堵）
- Depends on: none
- Category: feature
- Execution: subagent（宿主通用子 agent，`model: opus`；出发检查 2026-09-12 在 dev:explore 记录：连续自动推进、中途不再确认；push / PR / 合 main / 发版仍需用户明确要求）
- Planned at: `7deedfb`, 2026-09-12

## Requirement

在 coflux 终端里工作的 agent（Claude Code / Codex）现在没有任何「把子任务甩出去」的办法。边界清楚、机械、但啰嗦的活
（跑测试并按报错修、批量改文件、机械重构）只能自己做，把上下文烧在与主线无关的往返上。开子终端再起一个 `claude` 不解决问题：
那是另一个全功能 agent，要配置、要授权、上下文也不共享，重得不成比例。

完成后，coflux 自带一个轻量 executor。agent 用一条零凭证本地命令发起：

```sh
cofluxd executor run --prompt="把 crates/worker 的 clippy 警告清掉" --write
```

命令阻塞到任务结束，打印 executor 的最终回复与它改了哪些文件。executor 是一次性的：没有会话、没有续聊，要改就再发一次。
它在**发起它的那个工作区**里干活，被内核级沙箱限制在该工作区目录内，改不到工作区外的任何文件，也连不上本机的 daemon
回环端点。模型由用户在桌面 app 里全局配一次（provider / model / API key），system prompt 由 coflux 写死，agent 只能传
prompt 和读写模式两样东西。

### 产品结论（探索阶段已与用户逐条确认，勿再问、勿再改）

1. **消费者只有「用户的 agent 经插件发起」**。不做桌面端手动发起入口，不做「用户自己敲一个 executor 任务」的 UI。
2. **一次性任务：prompt 进、结果出，不续聊**。对应 Codex 那套 MCP 只有 `codex` 而不给 `codex-reply`。
3. **入参只有 prompt + 读写模式**（只读 / 可写）。不给 model 覆盖参数——一旦给了，agent 就得知道用户配了哪些模型，
   还要再开一个查询入口，全局配置的意义也被打穿。
4. **只支持桌面 app 所在本机的工作区**。远程 daemon 上的 agent 调不到，**app 关了任务就中断**——这是已接受的代价，
   不是待解决的缺陷。
5. **并发：同一工作区写模式互斥**（第二个写请求被拒并说明原因），只读可并发（设总数封顶）。
6. **配置入口**：账号菜单加一项「Executor 设置…」开对话框，与现有「服务器地址…」「本机 daemon」同构。桌面没有设置页，
   不为此新造一个。
7. **本片不做 UI**。agent 经 CLI 拿结果就算闭环。桌面那个只读悬浮小窗（右下角玻璃卡片、点击放大看完整转录、停止按钮、
   多任务堆叠）**另立第二片 plan**，不在本片范围。

### 验收（用户人工，前端不由 Claude 走查）

- 在一个 coflux 终端里跑 `cofluxd executor run --prompt="..." --write`，命令阻塞若干分钟后打印结果，文件确实被改了。
- 只读模式下 executor 能读能跑测试，但写文件被拒，且错误信息说得清是沙箱拒的。
- executor 试图写工作区外的文件（比如 `~/x.txt`）失败；试图 `curl` 本机 daemon 回环端口失败；外网与 DNS 正常。
- 同一工作区连发两个 `--write`，第二个被拒并给出可读原因。
- 桌面 app 退出后，在跑的任务中断，CLI 侧拿到明确的终态而不是永久挂起。
- 未配置 provider/model 时发起，CLI 立刻返回一句可读的「去桌面配置」而不是超时。

## Decisions & tradeoffs

- **pi 进程住桌面 app 的 `utilityProcess`，不住 daemon**。Rejected: daemon spawn pi 子进程 —— 三条硬证据挡死：
  ① `apps/desktop/electron-builder.yml:19` 的 `runAsNode: false` 是 plan 103 安全基线，签名前翻转、Gatekeeper 保证之后翻不回去，
  所以「复用已安装的 Electron 二进制当 Node、零额外体积」不可行，daemon 方案必须另行交付一份签名公证过的 Node 运行时；
  ② `crates/supervisor/src/manager.rs:808` 热升级直接 `Child::kill()` 掉 worker，没有 drain、没有子进程移交，跑几分钟的 pi
  挂在频繁热升级的 worker 下必成孤儿，改挂 supervisor 又等于把最需要快速迭代的新代码塞进「极少升级」的组件；
  ③ provider 密钥存在桌面 `safeStorage`（`apps/desktop/src/main/token-store.ts:5`），daemon 侧的 runner 读不到，等于为这个功能
  新造一条凭证分发链路。Based on: `apps/desktop/electron-builder.yml:18-27`、`crates/supervisor/src/manager.rs:808`、
  `docs/hot-upgrade-design.md` 第 1 节、`apps/desktop/src/main/token-store.ts:5`。
  注意同一段 electron-builder 注释写明「关 RunAsNode 后 `child_process.fork` 失效（后台任务用 `utilityProcess`）」——
  `utilityProcess` 是仓库认可的路径，但**仓库内尚无先例**（`grep -rn utilityProcess apps/desktop/src` 零命中），属新范式。

- **通路不新造反向 RPC，用既有推送 + 普通上行**。Rejected: 在 device 协议里造「device 向 client 发请求并等响应」的新语义 ——
  没必要：daemon 往已连通道推帧是既有能力（`pty_output` 每天在做），而 `packages/client/src/device-router.ts:1647` 已经能分派
  非应答消息，不要求每条入站消息配对一个 pending request。daemon 推工单、桌面用普通上行消息回报状态与终态即可。
  Based on: `proto/coflux/v1/device.proto:667` 的 oneof、`packages/client/src/device-router.ts:1647`。

- **桌面对本机 daemon 做独立常驻 `retainDevice`**。Rejected: 依赖用户当前选中的工作区所带来的连接 —— `retainDevice` 是引用计数的
  （`packages/client/src/device-router.ts:2312`），而 `apps/desktop/src/renderer/components/workbench/workbench.tsx:376` 现在
  对非选中设备只做 `measureOnly`，那种 lane **刻意跳过 direct 走 relay**。executor 服务必须独立 retain 本机 daemon，不能
  依赖用户此刻在看哪个工作区。retain 本身不授予 executor 能力，能力声明与收发分派要另外加。
  Based on: `packages/client/src/device-router.ts:2312-2322`、`apps/desktop/src/renderer/components/workbench/workbench.tsx:376`。

- **CLI 走零凭证本地命令，不走中心 MCP**。Rejected: 中心 MCP 工具 —— executor 完全本地闭环，按仓库已确立的设计原则
  （plan 093「MCP 单轨」正是因此撤回）本地能闭环的 agent 操作绝不经中心。新增 `AgentAction` 变体即可，
  `crates/worker/src/agent_ctl.rs:206` 的 `handle()` 已经靠 `agents::session_of_pid` 认会话、靠 `resolve_scope` 由 cwd 解析有效工作区。
  Based on: `crates/worker/src/agent_ctl.rs:84`（枚举）与 `:206`（分发）、`packages/cli/skills/coflux/SKILL.md` 的两轨规则。

- **长任务用 submit → runId → status/result 的 CLI 侧轮询**。Rejected: 让 `/agent` 单请求一直挂着 —— 服务端上限 25 秒
  （`crates/cli/src/gateway.rs:19-20`，`AGENT_TIMEOUT_MS = 30_000`），executor 一跑几分钟必然超时。必须套 `terminal wait` 同款范式：
  `AgentAction::TerminalStatus` 就是既有的轮询原语，CLI 侧轮询见 `crates/cli/src/commands.rs:236`。提交超时**不得盲目重发**，
  内部生成稳定 submission id 去重，不向用户增加入参。Based on: `crates/cli/src/gateway.rs:19-20`、`crates/worker/src/agent_ctl.rs:95-98`。

- **作业表与写锁在桌面主进程，daemon 只留状态与终态**。Rejected: 把作业表放 worker —— worker 的内存态热升级即丢
  （`crates/worker/src/main.rs:99` 的命令日志索引注释已明说，`WorkerState` 的 ledger/workspaces、`crates/worker/src/device.rs:796`
  的 operation 账本同理），`docs/architecture.md:195` 也明确普通 mutation 不提供跨 worker replacement 去重。daemon 侧只保留
  供 CLI 轮询的状态与最终结果。已有通道在渲染层，**加一条窄 IPC 桥到主进程即可，不必为本片重建主进程 DeviceRouter**。
  Based on: `crates/worker/src/main.rs:99`、`crates/worker/src/device.rs:796`、`docs/architecture.md:195`。

- **MVP 保留六件、砍掉七件**。保留：host 注册（本机 daemon 绑定**一个**桌面实例 + hostEpoch，不是任意已连 client 都能执行）、
  推送与接受回执（daemon 推 runId + prompt + mode + **已解析的 workspace id 与真实 root**，主进程接受或拒绝）、runId 去重与
  工作区写互斥、重连对账（worker 重启或 channel 换代后桌面重报运行中任务与未确认终态）、结果保留到 daemon 确认接收、取消幂等。
  砍掉：待办长轮询、竞争认领、租约调度、执行者自动迁移、跨 app 重启续跑、通用双向 RPC 抽象、逐 token 经 daemon 中转。
  **故障边界**：channel 断了不等于 app 死了，**不得重派 writer**；旧 host 状态不明时返回「结果未知 / 等待重连」，**不得自动重跑**。
  Rejected: 租约超时后把任务交给新 host —— 租约失效不证明旧 writer 已停止，会造成双写。

- **v1 executor 不 commit，git 元数据只读**。Rejected: 放行整个主仓 `.git` 再挖掉 hooks 与 config —— 这个折中经实测确实能让
  add/commit 可用且挡住写 hook 与改 config（见下方实测表），但它没堵住的还有一串：`extensions.worktreeConfig` 启用时的
  worktree 级 config、实际生效的 `core.hooksPath`、其他 worktree 的管理目录、`rebase-merge/git-rebase-todo` 里可以塞 `exec`、
  submodule 的 `.git/modules/**/config`、`info/exclude|attributes`、refs/reflog/objects。把这些做成精确 allowlist 是笔不小的工程，
  v1 不做。`git status` / `git diff` 仍然可用（只读模式建议带 `GIT_OPTIONAL_LOCKS=0` 减少可选 index 写入）。
  **这条对 agent 可见**：SKILL 里要写明 executor 不会提交，改动由发起方 agent 自己 review 并提交。

- **沙箱定档「防失误」，不是「防敌手」**。基线 `(allow default)` 加文件写 deny 与网络 deny，能挡住越界写与回环逃逸。
  Rejected: 照搬 Codex 那套默认拒绝的基础策略逐项放行系统服务 —— 工程量与维护成本大一个量级。**代价必须在文档里说清**：
  Mach/XPC 与 Apple Events 不在 `deny network*` 的覆盖范围内，`allow default` 基线下它们仍然开着。威胁模型是「被搞糊涂的
  agent 走错路」，不是「有敌意的攻击者」——用户本机跑的 Claude Code 本来就完全没有沙箱，这个档位已经严于现状。
  **不得把它宣传成完整隔离或工作区事务隔离。**

- **pi 必须用封闭 ResourceLoader**。Rejected: 用 `DefaultResourceLoader` 只覆盖 system prompt —— 它默认会发现并加载项目级与
  全局的 extensions / skills / prompts / 配置，工作区里放一个 `.pi/` 目录就能让 executor 执行任意代码，等于沙箱之外开了个后门。
  必须显式指定 model、工具清单、凭证来源与 session 存储，用 `SessionManager.inMemory()` 不落盘，不读用户既有的 `~/.pi` 状态，
  不加载工作区里的可执行扩展；system prompt 经 `systemPromptOverride` 给。Based on: pi SDK 文档的资源发现默认行为（上游 0.85.1）。

- **停止按进程组，且终态要分类**。pi 的 bash 工具在非 Windows 上用 `detached: true` 起 shell，**杀 pi 的 pid 甚至它自己的进程组
  都不保证那些 bash 组已经退出**。先协作 abort，再有界强杀；自定义工具后端要登记每个 shell 的进程组；确认工具子进程真的停了
  才释放写锁。另外**不得把 `prompt()` 返回或进程 exit 0 直接当成功**——终态要区分成功 / 模型错误 / 工具失败 / 被中断 / 结果未知。

- **（decided while planning）工具进程默认不联网**。工具 profile 用 `(deny network*)`，模型调用发生在 runner 里而 runner 不进沙箱，
  所以不受影响。代价是 executor 跑不了 `npm install` / `cargo fetch` 这类要拉依赖的命令。Rejected: 放行一个本机下载代理端口 ——
  「放开某个 loopback 端口」会把下面那条逃逸向量重新打开，而做一个会在 DNS 解析与重定向后重新校验目标的受控代理是独立的
  一摊工程。**这条限制必须写进 SKILL**，让发起方 agent 知道要先把依赖装好再甩任务。

### 实测数据（planning 阶段在本机 macOS 26 / Darwin 27 实跑，直接采信，不要重测）

在临时 git 仓库 + `git worktree add` 出来的工作区下，`sandbox-exec` 的实际行为：

| profile 规则 | 结果 |
| --- | --- |
| 只放行 worktree 目录 | `git status` rc=0、改文件 rc=0；`git add`/`commit` rc=128，卡在 `<main>/.git/worktrees/<name>/index.lock` |
| 追加放行 `<main>/.git/worktrees/<name>` | 仍然失败（`git add` 报「更新文件失败」） |
| 放行整个 `<main>/.git` | add/commit rc=0；写 `<main>/leak.txt` 仍被拒 |
| 再 deny `.git/hooks` 子树 + `.git/config` 字面量 | add/commit 仍 rc=0；写 pre-commit 被拒；`git config core.fsmonitor evil` rc=4 |
| `(deny network* (remote ip "localhost:*"))` | loopback TCP 拒；DNS 正常；外网 HTTPS 正常 |
| 再加 `(deny network-outbound (remote unix-socket))` | UDS 拒，但**系统域名解析一起断**（`getaddrinfo` 经 UDS 找 mDNSResponder，curl 报 Could not resolve host） |
| 改为按路径 `(deny network-outbound (literal "<具体 sock 路径>"))` | UDS 拒 + DNS 正常 + 外网 200 + loopback 拒，三项全中 |

两个会让人白查半天的静默坑：

- **profile 里必须写 `realpath` 解析后的真实路径**。`/var/...` 写进去规则形同不存在（`/var` 是指向 `/private/var` 的符号链接），
  表现是「允许规则像没写一样」，不报错。
- **`-D` 参数配 `(param "X")` 实测没生效**，直接把字面量路径拼进 profile 才行。

## Direction

四条主线，依赖关系是 M1 → M2 → M3，M4 与 M2/M3 无交集可并行，M5 收尾要等前面都在。

**架构一句话**：agent 打 `cofluxd executor` → daemon 的 `/agent` 端点认会话、解析工作区、登记 run → daemon 往已注册的本机
桌面 client 推工单 → 桌面主进程起 `utilityProcess` 跑 pi（封闭 loader，bash 后端每条命令套 `sandbox-exec`）→ 终态回报 daemon →
CLI 轮询拿到结果。转录留在桌面内部，不经 daemon。

### Milestone 1: 协议与 daemon 侧通路

完成后：`proto` 里有 executor 的工单推送与上行回报消息，且 `buf breaking` 通过；worker 有 run 账本（提交、查状态、取结果、取消），
`/agent` 新增对应 `AgentAction`；没有已注册 executor host 时，提交立刻返回一句可读错误而不是挂起；host 注册绑定单个桌面实例
与 hostEpoch。daemon 侧能力名沿用 `apps/server/src/daemon-capabilities.ts` 的按名门禁范式。

Validation: `cargo test -p coflux-protocol` -> exit 0；`cargo build -p coflux-supervisor -p coflux-worker` -> exit 0。

### Milestone 2: 桌面 host 注册与作业表

完成后：桌面主进程持有作业表与工作区写锁（写互斥、只读封顶），渲染层对本机 daemon 独立常驻 retain 并声明 executor 能力，
窄 IPC 桥把工单送进主进程、把状态送回；runId 去重、取消幂等、重连对账都在；app 退出时在跑的任务被置为明确终态。
此时 runner 可以先用一个假的回显实现占位。

Validation: `pnpm -C apps/desktop typecheck` -> exit 0；`pnpm -C apps/desktop test` -> exit 0（含作业表状态机与写锁的纯函数单测）。

### Milestone 3: runner 与 Seatbelt 收口

完成后：`utilityProcess` 里跑真 pi（锁死 0.85.1，封闭 ResourceLoader，`SessionManager.inMemory()`，system prompt 由 coflux 给）；
结构化文件工具按解析后的工作区根做路径校验；bash 工具后端每条命令套 `sandbox-exec`，profile 由工作区根 + `git worktree list --porcelain`
的排除清单生成，网络段封 loopback、按路径封 supervisor UDS 与 Docker/Podman/SSH agent socket、工具进程 `(deny network*)`；
停止走「协作 abort → 有界强杀进程组」；终态分类成功/模型错误/工具失败/中断/结果未知。

Validation: `pnpm -C apps/desktop typecheck` -> exit 0；`pnpm -C apps/desktop test` -> exit 0（含 profile 生成的纯函数单测：
真实路径解析、嵌套 worktree 排除、git 元数据只读、网络段成形）。

### Milestone 4: 全局配置与凭证

完成后：账号菜单多一项「Executor 设置…」，对话框可配 provider、model 与 API key；key 经 `safeStorage` 加密落 userData，
非敏感项走配置文件；未配置时 executor 提交被拒并给可读原因。key 只经专用 IPC 进 runner，不进 `settings.json`、不进工具进程 env、
不进转录与日志。与 M2/M3 无文件交集，可并行。

Validation: `pnpm -C apps/desktop typecheck` -> exit 0；`pnpm -C apps/desktop test` -> exit 0。

### Milestone 5: CLI 命令、SKILL 与文档

完成后：`cofluxd executor run --prompt=... [--write]` 可用，内部 submit + 轮询、稳定 submission id 去重、错误一句话可读；
SKILL 里加 executor 一节（**全英文**，不重复 MCP 已有内容），写明它是一次性的、不 commit、工具进程不联网、只在桌面 app 所在本机可用；
`docs/architecture.md` 补一段执行通路；`.claude-plugin/plugin.json` 提 version。

Validation: `cargo build -p coflux-supervisor -p coflux-worker` -> exit 0；`node scripts/sync-claude-plugin.mjs` -> exit 0 且两份 SKILL 一致；
`pnpm -C tests test` -> 除下方已知 flaky 外全绿。

## Landmines

1. **沙箱逃逸向量（最重要，不堵则沙箱形同虚设）**：沙箱内的工具进程可以直接打 daemon 的回环 `/agent`，用 `terminal.new` 让
   完全不受沙箱约束的 daemon 替它执行任意命令。`crates/worker/src/hook.rs:251` 的 pid/ppid **来自请求体**，
   `crates/worker/src/agents.rs:77` 只核对这个 pid 在不在某个会话进程树里——它验证的是「报上来的 pid 属于谁」，
   而不是「这条 HTTP 连接确实由该进程发出」。工具 profile 必须封掉 loopback、supervisor UDS、Docker/Podman socket、
   SSH agent 与 ControlMaster socket。
2. **嵌套 worktree**：本仓库 `git worktree list --porcelain` 现在显示 `.claude/worktrees/` 下有**两层嵌套**的 worktree
   （含 plan 114 spike 与 plan 115 两份尚未合并的工作）。executor 若在主工作区跑，一条朴素的「放行工作区整个子树」会让另外
   五个 worktree 一起变可写。profile 生成必须跑 `git worktree list --porcelain` 并 deny 掉其他所有已登记 worktree。
   还要考虑父目录 rename 与符号链接别名，不能只测原路径上的 write。
3. **凭证不得外泄**：provider key 存 `safeStorage`、经专用 IPC 进 runner，**不得进 `settings.json`、不得进工具进程 env、
   不得进转录**。注意 `apps/desktop/src/main/settings.ts:37` 现在只认 `serverUrl` 一个键，非敏感配置要扩展它而不是另起炉灶。
4. **cwd 固定时机**：`crates/worker/src/agent_ctl.rs` 的 `resolve_scope` 按请求 cwd 选有效工作区、未匹配时退回归属工作区。
   executor 必须在**提交那一刻**固定已解析的 workspace id 与真实 root 并随工单下发，父 agent 之后 `cd` 或进 worktree 挪窝
   **不得改变已在跑任务的边界**。
5. **pi 版本与依赖**：锁死 `@earendil-works/pi-coding-agent@0.85.1`，**不要用 `^`**。MIT，engines `node>=22.19.0`；依赖全是纯 JS
   （`@silvia-odwyer/photon-node` 是 WASM 不是原生 addon，无 node-gyp，无 ABI 问题），Electron 44.3.0 内置 Node 24.20.0 满足要求。
   包已从 `@mariozechner/*` 迁到 `@earendil-works/*`，旧 scope 冻结在 0.73.1 并标 deprecated，别装错。
6. **SKILL 唯一源**是 `packages/cli/skills/coflux/SKILL.md`，改完必须跑 `node scripts/sync-claude-plugin.mjs` 同步到
   `integrations/claude-plugin/skills/coflux/SKILL.md`，**CI 校验两份一致**（见 `AGENTS.md`）。插件目录的 SKILL **必须全英文**。
7. **UI 规范**（本片虽不做小窗，配置对话框仍受约束）：`docs/design-guidelines.md` 规定悬浮提示用 `Tooltip` 组件不用原生 `title`；
   活动指示用 `ActivityDots` 点阵，**禁止 `LoaderCircle` / 转圈 / Unicode 盲文**；图标用 lucide-react。
8. **Bash 守卫**：会话切进 worktree 后守卫会拦 `git -C ..`、`$(git …)`、算术与复杂模板等复合写法，也会拦提交信息或 heredoc 里
   含 worktree 删除字样的内容；拆成单条命令，或用 Edit 工具 / `git commit -F <file>` 绕开。`set -e` 在 Bash 工具的 zsh 下**不生效**，
   多步脚本用 `&&` 串联或显式判退出码。
9. **发版链路（本片不做）**：worker 侧改动要下一个 `v*` tag 才随热升级到达 daemon；桌面走 `desktop-v*` tag；npm `cofluxd` 要发新版
   才有新子命令；插件要把 SHA 交给 builder 会话。**本片只做到可合 main，不发版**——发版是用户的决定。

## Scope

In scope:
- `proto/coflux/v1/device.proto` 及其三端生成产物（`crates/protocol/src/gen/**`、`packages/protocol/src/gen/**`、
  `packages/swift-client/Sources/CofluxProtocol/Generated/**`）——生成产物由 buf 重新生成，不手改
- `crates/worker/src/agent_ctl.rs`（或拆成 `agent_ctl/` 模块目录）、`crates/worker/src/device.rs`、
  `crates/worker/src/gateway.rs`、`crates/worker/src/hook.rs`（`/agent` 端点解析与分发新 action）——executor 通路所需的最小改动
- `crates/cli/src/commands.rs`、`crates/cli/src/main.rs`、`crates/cli/src/args.rs`
- `apps/desktop/src/main/**`（host 注册、作业表、写锁、runner、Seatbelt profile、配置与凭证）
- `apps/desktop/src/preload/**`、`apps/desktop/src/shared/**`（窄桥接类型）
- `apps/desktop/src/renderer/components/workbench/account-footer.tsx`、`workbench.tsx`（菜单项与常驻 retain）
- `apps/desktop/package.json`（pi 依赖）
- `packages/client/src/device-router.ts`（executor 消息分派）
- `packages/cli/skills/coflux/SKILL.md` 与同步产物、`integrations/claude-plugin/.claude-plugin/plugin.json`
- `docs/architecture.md`、`plans/README.md`
- 对应单测与黑盒用例

Out of scope:
- 桌面只读悬浮小窗 UI（转录展示、停止按钮、多任务堆叠）—— 另立第二片 plan
- 远程 daemon 上的 executor —— 产品结论第 4 条已排除
- executor 自己 git commit —— 决策已排除，需要精确 allowlist，另议
- 工具进程联网与受控下载代理 —— 决策已排除，另议
- Mach/XPC 与 Apple Events 层的收口 —— 沙箱档位已定为「防失误」
- 中心 MCP 暴露 executor —— 违反本地优先原则
- 发版（`v*` / `desktop-v*` tag、npm、插件市场）—— 用户的决定

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Rust 单测 | `cargo test -p coflux-protocol` | exit 0 |
| daemon 构建 | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0 |
| 桌面类型检查 | `pnpm -C apps/desktop typecheck` | exit 0 |
| 桌面单测 | `pnpm -C apps/desktop test` | exit 0 |
| 桌面构建 | `pnpm -C apps/desktop build` | exit 0 |
| SKILL 同步 | `node scripts/sync-claude-plugin.mjs` | exit 0，两份一致 |
| 黑盒集成 (acceptance) | `pnpm -C tests test` | 除已知 flaky 外全绿 |

已知 flaky 与环境基线失败，**不要为它们调阈值或改测试**：

- `cofluxd doctor` 两例在本机是环境基线失败（装了 cofluxd 但服务没跑，走另一条输出分支），与本片无关。
- auto-update / local-first / signed-upgrade 偶发红；本地单跑一红两绿即定性 flaky。
- agent-activity 的 presence/hook 三条在装了 coflux 的本机**必定假红**（靠进程树认 claude 进程，被真实会话污染）且会卡住整套。
- 前端改动不需要 Claude 做 UI 走查，交用户人工验证。

## Done criteria

- [ ] 上表除 acceptance 行外全部通过。
- [ ] `cofluxd executor run --prompt=... --write` 在 coflux 终端里能跑通并打印结果与改动文件。
- [ ] 只读模式下写文件被拒；越界写（工作区外）被拒；连 daemon 回环被拒；外网与 DNS 正常。
- [ ] 同一工作区第二个写模式请求被拒并给出可读原因。
- [ ] 未配置 provider/model 时提交立刻返回可读错误，不超时。
- [ ] 桌面 app 退出后在跑任务落到明确终态，CLI 不永久挂起。
- [ ] profile 生成有纯函数单测覆盖：真实路径解析、嵌套 worktree 排除、git 元数据只读、网络段成形。
- [ ] SKILL 两份一致且为英文，写明一次性 / 不 commit / 工具不联网 / 仅本机。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Decisions & tradeoffs 里引用的事实不再成立（特别是 `electron-builder.yml` 的 `runAsNode` fuse、`manager.rs` 的 `Child::kill()`
  热升级方式、`device-router.ts` 的非应答消息分派能力）。
- 实现需要改 Scope 之外的文件。
- 某条验证命令在一次合理修复后仍连续失败两次。
- pi 0.85.1 在 `utilityProcess` 里跑不起来（例如 ESM 加载、WASM 初始化或 Electron 的 Node 环境差异），这会动摇 D1 的前提——
  停下报告，不要退回 daemon 方案自行决定。
- Seatbelt profile 在真实工作区上误伤到无法工作（比如常用构建命令全挂），说明档位需要复议——停下报告。

## Maintenance notes

- **沙箱档位**是「防失误」不是「防敌手」：Mach/XPC 与 Apple Events 在 `allow default` 基线下仍然开着。任何把 executor
  宣传成安全隔离的文案都是错的。要升级档位得照 Codex 那套默认拒绝的基础策略重做，属独立工程。
- **`sandbox-exec` 已被 Apple 标记 deprecated 多年**但当前可用。真正的成本在未来兼容性——每次 macOS 大版本后要重跑
  profile 验收。
- **pi 是上游快速迭代的项目**（8 月到 9 月初每 1-2 周一个 release）。版本锁死，升级前先核对 `DefaultResourceLoader`
  与 bash 工具 `detached` 行为有没有变，这两处是本片两条决策的依据。
- executor 与发起它的 agent、用户编辑器、普通终端**并不互斥**：写锁只保证 executor writer 之间互斥，不提供工作区事务隔离。
  只读任务与 writer 并发时也没有一致性快照。SKILL 里要把这个边界说清楚。
- 第二片（悬浮小窗）会需要转录的增量流。本片把转录留在桌面主进程内，设计时给它留一个可订阅的出口，但不要为此把逐 token
  数据推过 daemon。
