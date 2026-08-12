# Plan 072: 项目默认分支由 daemon 自愈，不再导入时写死一次

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat ce9de7a..HEAD -- proto crates/worker/src/git.rs crates/worker/src/main.rs apps/server/src/hub.ts apps/server/src/store.ts tests/src/lifecycle.test.mjs`

## Status

- Priority: P3
- Effort: S
- Risk: LOW
- Depends on: none
- Category: bug
- Execution: self
- Planned at: `ce9de7a`, 2026-08-12

## Requirement

`projects.default_branch` 是 diff 统计基准（`merge-base(default_branch, HEAD)`），
但它只在**导入项目那一刻**由 daemon 探测一次写死，此后没有任何自愈或人工修正入口
（`apps/server/src/store.ts:789` 的 INSERT 是全代码唯一写入点）。

这个值错了**不会报错**，只让侧栏 diff 数字悄悄失真（主干工作区被标出上万行"变更"，
实为主干相对某 feature 分叉点的累计提交），是最难被反馈上来的一类 bug：

- 2026-08-01 生产库 `haolin` 存成 `HEAD`、`aohun/maxkb` 存成 `feature/sso-default-application-chat`，手写 SQL 修复。
- 2026-08-12 又发现 `interview-evals` 存成 `HEAD`、`wangshuaiqi.com/data-analysis` 存成 `chore/lightweight-repository-structure`，再次手写 SQL 修复。
- PR #29（`6261c54`）修好了新导入路径的探测，但存量不自愈；且仓库把 `master` 迁到 `main` 后同样会失真。

**做完之后为真**：daemon 每次收到工作区清单下发时都会核对本地 `origin/HEAD`，
与 server 记录不符就上报纠正，server 落库并重推清单。存量错值在 daemon 下次重连
（重启 / 网络抖动 / worker 热升级）后自动修正，无需人工介入，也不再需要手写 SQL。

判断"相邻的错误解法"：**不是**加 UI 让人手动改（错了没人知道要改，等于没修）；
**不是**在已有 3s 轮询里每轮探测（常态开销换不来价值，默认分支变更是极低频事件）；
**不是**把探测失败当成"应该清空"（无 remote 的本地仓库会被误清）。

## Decisions & tradeoffs

- **纠正方向：daemon 上报纠正 server，而非 server 下发权威值**。真相只在 daemon 本地的
  `git symbolic-ref refs/remotes/origin/HEAD`，server 无从验证。因此 server DB 是**缓存**，
  daemon 是**真相源**。`apps/server/src/hub.ts:292` 注释里「server 侧权威值，worker 不自行猜测」
  与 `proto/coflux/v1/daemon.proto:268-270` 的同义表述都是错误定位，必须一并改正。
  形态上与既有的 `workspaceBranch`（`hub.ts:930`）/`workspaceDiff`（`hub.ts:942`）一致——
  那两处注释已经写对了："真相源在设备侧，DB 只做镜像 + 广播"。
  Based on: `crates/worker/src/git.rs:169` `detect_default_branch` 只在 daemon 本地可执行。

- **自愈而非 UI 手改入口**：不加任何让用户手选默认分支的界面。这个字段的语义是
  「仓库的默认分支」，不是「用户想比较的基准」，语义上就该跟 remote 一致，没有用户自定义余地。
  Rejected: 项目设置里加分支下拉 —— 值错了不报错、用户根本不知道要去改，人工入口修不了
  这个 bug 的本质（两次生产事故都是我方主动发现，不是用户报上来的）。
  **明确不引入 `default_branch_pinned` 之类的标志位**：那是为"故意拿非主干当基准"这个
  当前不存在的需求付结构成本；将来真要「自定义 diff 基准」，那是另一个字段、另一个功能。

- **探测时机：收到 `workspaceList` 时探一次，不进 3s 轮询**。`pushWorkspaceList`
  （`hub.ts:295`）在 daemon 连接时和工作区增删时全量下发，worker 借这个既有时机核对即可。
  Rejected: 塞进 `crates/worker/src/main.rs:341` 那个 3s 分支/diff 轮询 —— 每 3s 给每个
  工作区多起一个 git 子进程，换来的只是"默认分支变更能在 3 秒内被发现"，而默认分支变更
  是以月计的低频事件。
  接受的代价：daemon 长期不重连且不增删工作区时，`master`→`main` 迁移不会被立刻发现。P3 可接受。
  Based on: `apps/server/src/hub.ts:292-303` pushWorkspaceList 的调用时机。

- **探测不到时不上报，保持现值**：`detect_default_branch` 返回 `None`（无 remote、非 clone 仓库）
  时**不发任何消息**。Rejected: 上报空串让 server 清空 —— 会把无 remote 的本地仓库的
  默认分支抹成空，而空值在 worker 侧的语义是"目录工作区，跳过 git 轮询"
  （`crates/worker/src/main.rs:356-358`），等于连 diff 统计一起废掉。
  Based on: `crates/worker/src/git.rs:169-177` 探测失败返回 None 的现有契约。

- **上报按 workspace 粒度，project 归属由 server 反查**：`WorkspaceRef`
  （`proto/coflux/v1/daemon.proto:271-275`）只有 `workspace_id`/`path`/`default_branch`，
  没有 project_id，worker 无从知道 project 归属。上报 `{workspace_id, default_branch}`，
  server 用 `getWorkspace(workspaceId).projectId` 反查。
  Rejected: 给 `WorkspaceRef` 加 project_id —— 为一条低频消息扩宽下行清单的每一项。

- **同 project 多工作区重复上报由 server 幂等吸收**：worker 侧不做去重（它不知道谁跟谁同 project）。
  server 侧比对现值，相同就直接 return、不写库不重推——与 `workspaceDiff` handler
  （`hub.ts:942-950`）先比对再落库的既有形态一致。这是 daemon 连接时的一次性开销，可忽略。

- **收敛性（decided while planning）**：worker 探到不符 → 上报 → server 落库 → 重推
  `workspaceList` → worker 再探，此时值已相同 → 不再上报。第二轮即收敛，无消息风暴。
  重推是必需的，否则 worker 手里仍是旧值，`diff_stat` 会继续按错基准算。

- **广播用 `projectCreated`（decided while planning）**：项目变更的既有广播形态就是它
  （`hub.ts:764`），前端按 id upsert，无需新增消息类型。

## Direction

数据流：`worker 收 workspaceList` → 逐个 repo 工作区探 `origin/HEAD` → 与下发值不符则
`send_d2s(WorkspaceDefaultBranch{workspace_id, default_branch})` → `hub` 反查 project →
落库 + `broadcast(projectCreated)` + `pushWorkspaceList` 重推。

### Milestone 1: 协议新增上报消息，三端产物一致

`DaemonToServer` 新增一条 worker→server 的消息（承载 `workspace_id` + 探测到的
`default_branch`），放在 `WorkspaceBranch`/`WorkspaceDiff` 附近，tag 取当前 oneof 未用的号
（现最大为 29 `relay_home`）。同时改正 `daemon.proto` 里 `WorkspaceList` 上方那段
「server 侧权威值，worker 不自行猜测」的注释。

Validation: `cd proto && buf lint && buf generate && git diff --exit-code -- ../packages/protocol/src/gen ../crates/protocol/src/gen gen/swift` -> exit 0（即：产物已随本次改动提交，重跑生成零 diff）。

### Milestone 2: worker 收到清单时核对并上报

worker 处理 `WorkspaceList` 时，对每个 `default_branch` 非空的工作区探测 `origin/HEAD`，
探到且与下发值不同才上报；探不到不发消息。

Validation: `cargo build --release -p coflux-worker` -> exit 0（CI 用 `-D warnings`，本地同样不得有 warning）。

### Milestone 3: server 落库、广播、重推清单

hub 处理新消息：校验 workspace 归属本连接 daemon（同 `workspaceBranch` 的 `ws.daemonId !== conn.daemonId` 守卫），
反查 project，值相同则直接返回；不同则落库、广播 `projectCreated`、重推该 daemon 的 workspaceList。
store 新增更新 `projects.default_branch` 的方法。一并改正 `hub.ts:292` 的注释定位。

Validation: `pnpm -r typecheck`（或仓库既有的类型检查命令）-> exit 0。

### Milestone 4: 黑盒测试覆盖自愈路径

在 `tests/src/lifecycle.test.mjs` 既有「导入项目：默认分支取 origin/HEAD」用例旁增加自愈用例：
导入一个 origin/HEAD 与当前记录不符的仓库，触发一次 workspaceList 下发（新增工作区即可，
见 `pushWorkspaceList` 的调用时机），断言 `project.defaultBranch` 被纠正。
`plans/README.md` 的 Backlog 节移除「项目默认分支可改」条目（本 plan 即其兑现）。

Validation: `node --test tests/src/lifecycle.test.mjs`（或仓库既有的黑盒测试命令）-> exit 0。

## Landmines

- **CI 卡生成产物零 diff**：`.github/workflows/ci.yml:50-51` 跑 `buf generate` 后
  `git diff --exit-code` 校验三端产物。TS 产物里 `fileDesc(...)` 是整个 .proto 的
  base64 二进制描述符（见 `packages/protocol/src/gen/coflux/v1/device_pb.ts:19`），
  **手写 gen 文件绝无可能**，必须跑 `buf generate`（`buf` 1.71.0 已装）并提交
  TS/Rust/Swift 三份产物。`buf breaking --against main` 也在 CI 上，新增字段/消息兼容、不会被拦。

- **`WorkspaceList` 的处理块持着同步锁，不能在里面 await**：
  `crates/worker/src/main.rs:876-881` 是 `state.lock().unwrap()` 的同步块，而
  `detect_default_branch` 是 async（起 git 子进程）。必须把探测挪出锁块——先在锁内取完
  待探测清单再释放，或另 spawn 一个 task 做探测上报。在锁内 await 会死锁或触发
  `MutexGuard` 跨 await 的编译错误。

- **`default_branch` 为空 = 目录工作区（无 repo 终端），必须跳过**：即使该目录恰好落在某个
  git 仓库内（如 dotfiles 管理的 HOME）也不该探测上报。与既有 3s 轮询的过滤保持一致，
  见 `crates/worker/src/main.rs:356-358` 的注释与 filter。

- **worktree 能读到 origin/HEAD**：`refs/remotes/` 由主仓库与所有 worktree 共享，所以每个
  工作区都能探到同一个值——这正是"同 project 多工作区会重复上报"的成因，靠 server 幂等吸收。

- **不要给 `WorkspaceBranch` 复用/塞字段**：那条消息是 worktree 当前分支（每个工作区各不相同），
  与项目默认分支是两个语义，混用会让 `hub.ts:930` 的 handler 同时承担两种真相。

## Scope

In scope:
- `proto/coflux/v1/daemon.proto`
- `packages/protocol/src/gen/`、`crates/protocol/src/gen/`、`proto/gen/swift/`（`buf generate` 产物）
- `crates/worker/src/main.rs`、`crates/worker/src/git.rs`
- `apps/server/src/hub.ts`、`apps/server/src/store.ts`
- `tests/src/lifecycle.test.mjs`
- `plans/README.md`（状态 + 移除 Backlog 条目）

Out of scope:
- 任何前端改动（`apps/web`、`apps/mobile`、`apps/ios`）—— 侧栏已经显示 `project.defaultBranch`
  （`apps/web/src/components/workbench/sidebar.tsx:318`），值被纠正后自动跟随，无需改 UI。
- `default_branch` 的用户可编辑入口 —— 见 Decisions，明确不做。
- 存量脏数据的批量回填脚本 —— 2026-08-12 已手工修完，且自愈上线后 daemon 重连即覆盖。
- `origin/HEAD` 本身过期的情况（remote 改了默认分支但本地 `git remote set-head` 没跑）——
  沿用 `crates/worker/src/git.rs:168` 已记的 `ponytail:` 说明，真不准时再补 `ls-remote --symref`。

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 协议 lint + 产物一致性 | `cd proto && buf lint && buf generate && git diff --exit-code -- ../packages/protocol/src/gen ../crates/protocol/src/gen gen/swift` | exit 0 |
| Rust 构建（CI 用 `-D warnings`） | `cargo build --release -p coflux-worker` | exit 0 |
| Rust 单测 | `cargo test -p coflux-protocol` | exit 0 |
| TS 类型检查 | 仓库既有 typecheck 命令（见 `AGENTS.md` / `.github/workflows/ci.yml`） | exit 0 |
| 黑盒测试 (acceptance) | 仓库既有黑盒测试命令（`tests/`，依赖 CI 内置 Postgres service） | exit 0 |

## Done criteria

- [ ] All listed commands pass.
- [ ] daemon 收到工作区清单后，本地 `origin/HEAD` 与 server 记录不符时会上报纠正，server 落库、广播、并重推清单；相符时零消息。
- [ ] 探测不到 `origin/HEAD` 时不上报，`projects.default_branch` 保持原值不被清空。
- [ ] `default_branch` 为空的目录工作区不参与探测。
- [ ] `hub.ts` 与 `daemon.proto` 中「server 侧权威值 / worker 不自行猜测」的注释已改正为「daemon 是真相源、DB 是缓存」。
- [ ] 黑盒测试新增自愈用例并断言了纠正后的值（不只是断言不崩）。
- [ ] `plans/README.md` 状态已更新，Backlog 里「项目默认分支可改」条目已移除。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- `buf breaking` 拦下本次协议变更（说明改法不是纯新增，需重新设计）。
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- 出现 worker↔server 反复互相纠正（不收敛）的迹象——说明 server 落库后重推的值与 worker 探测值口径不一致。

## Maintenance notes

- 这条自愈链路的正确性依赖一个不变量：**server 存的是缓存，daemon 本地 `origin/HEAD` 是真相**。
  今后若有人再想把 `default_branch` 做成"用户可配置的 diff 基准"，那是引入了第二个真相源，
  必须先解决"用户设定"与"自动探测"谁覆盖谁，不能直接加个可写入口了事。
- `origin/HEAD` 只在 `git clone` 时自动写入，之后不跟随 remote 变化。remote 把默认分支从
  `master` 迁到 `main` 后，用户需在本地跑一次 `git remote set-head origin -a` 才能被探到。
  若这成为反复出现的问题，再考虑补 `git ls-remote --symref`（有网络开销，故当前不做）。
- 上报时机绑在 `pushWorkspaceList` 上。今后若改动它的触发条件（`hub.ts:295` 现为 daemon 连接时 +
  工作区增删时），自愈频率会随之改变——减少它的调用会让自愈变慢甚至失效。
