# Plan 012: 导入项目两步向导（设备 → 远程文件树选文件夹）

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Stop on any STOP condition. When complete,
> update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 214560e..HEAD -- proto apps/server/src/hub.ts crates/worker/src apps/web`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: feature
- Execution: self
- Planned at: `214560e`, 2026-07-17

## Requirement

现导入项目要手填远程绝对路径，易错且不可发现。改为两步向导：

1. **第一步选设备**：列出在线设备；一台在线设备时可默认选中。无在线设备时
   显示空态引导「先登记设备」（复用现有 EnrollmentDialog 流）。
2. **第二步浏览远程文件树选文件夹**：从设备用户 home 起步，面包屑 + 子目录
   列表逐级下钻（每次进入目录发一次列目录请求），选中文件夹后确认导入。

正确性判别：全程不需要手打路径；选错非 git 目录时依赖既有 `ProjectValidate`
报错兜底（error toast 已有）；无在线设备/浏览中设备掉线均有明确提示不悬挂。

## Decisions & tradeoffs

- **复用 FsList 中继链路，不新增消息对**。`ClientFsList` 加
  `optional string daemon_id = 4`：daemon_id 模式下 server 校验设备属于本账号
  （对照 `workspaceForClient` 的等价物），root 下发 `"~"`；workspace_id 模式
  行为不变。Rejected: 新建 ClientBrowseDevice 消息——与 FsList 语义重复。
  Based on: 中继机制 `pendingRelays`（hub.ts:806-813）、Rust `ops::list_dir`
  的 root 锚定 + `safe_resolve` 越界校验（ops.rs:62-66）均已存在。
- **daemon 侧 root=`"~"` 展开为用户 home**（worker main.rs FsList 分支，
  展开后仍走 safe_resolve）。Rejected: server 下发绝对 home 路径——server
  不知道各设备的 home。浏览范围因此锚定 home 及以下，不提供全盘浏览（安全
  面收窄是特性不是缺陷）。
- **proto 向后兼容演进**：只加 optional 字段，wire 不破坏；regen 命令
  `cd proto && buf generate`（TS → packages/protocol/src/gen，Rust →
  crates/protocol/src/gen）。
- **UI 用 Astryx 组件写**（Dialog/Selector/Button/Text 等，遵循
  apps/web/.claude/CLAUDE.md 约定）——组件库迁移方向已定（214560e 试点），
  新 UI 不再用旧 radix 基座。目录浏览形态：**面包屑 + 当前目录子目录列表**，
  Rejected: TreeList 展开树——懒加载树状态管理复杂，列表下钻交互更清晰。
- **浏览时不做 git 仓库探测标记**。Rejected: FsEntry 加 is_git_repo——给通用
  文件原语掺业务语义；导入时 ProjectValidate 已有校验兜底，选错有报错。
- **请求-响应封装进 store 层**：fsListed 按 requestId 匹配回调（store 已有
  的消息分发处加一个 pending map），不进 zustand 状态（一次性数据）。

## Direction

### Milestone 1: 协议与后端

proto 加字段 + buf generate 双端产物；hub.ts `clientFsList` 分支支持
daemon_id 模式（账号归属校验 + daemon 在线校验 + root="~"）；worker main.rs
FsList 分支展开 `~`。
Validation: `pnpm --filter @coflux/protocol build` && `cargo build -q` exit 0。

### Milestone 2: Web 向导 UI

ImportProjectDialog 重做为两步向导（Astryx）；store 加 fsList 请求-响应封装；
无在线设备空态 + 登记引导；掉线/超时错误显示。
Validation: `pnpm --filter @coflux/web build` exit 0。

### Milestone 3: 验收

黑盒用例：clientFsList{daemonId} 返回 home 目录列表、无权 daemon 被拒。
UI 冒烟：本地栈两步向导走通导入 `/tmp/coflux-dev-repo`。
Validation: `cd tests && pnpm test` 全绿。

## Landmines

- `pendingRelays.register` 的超时回调签名与 kind 字符串（"fs.list"）要保持
  一致（hub.ts:167 错误回包依赖 kind 分发）。
- protobuf-es 生成的 optional 字段是 `string | undefined`，server 判别模式用
  `value.daemonId !== undefined && value.daemonId !== ""`（proto3 optional
  语义，空串与缺省需一致对待）。
- Astryx `Selector` 组件 API 未核实（试点只用过 TextInput/Button/Card 等）——
  实现前先 `pnpm exec astryx component Selector`。

## Scope

In scope:
- `proto/coflux/v1/client.proto` + 双端生成产物（packages/protocol/src/gen、crates/protocol/src/gen）
- `apps/server/src/hub.ts`（clientFsList 分支）
- `crates/worker/src/main.rs`（FsList root 展开）
- `apps/web/**`（向导 UI + store 封装）
- `tests/**`（新增黑盒用例）

Out of scope:
- FsRead / ExecRun 的设备模式 —— 本需求只要列目录
- 文件树组件的通用化 —— 等后续功能需要再抽
- 生产部署 —— 验收后另行执行

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| proto 生成 | `cd proto && buf generate` | 双端产物更新 |
| Rust 构建 | `cargo build -q` | exit 0 |
| Web 构建 | `pnpm --filter @coflux/web build` | exit 0 |
| 黑盒回归 (acceptance) | `cd tests && COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm test` | 全绿（37+新增） |

## Done criteria

- [ ] All listed commands pass.
- [ ] 两步向导全程免手打路径完成导入；无在线设备时引导登记。
- [ ] daemon_id 模式有账号归属校验（他人设备被拒），黑盒用例覆盖。
- [ ] workspace_id 模式行为与改动前逐字节一致（不回归）。
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- Rust 侧 home 展开在目标平台（macOS/Linux）无统一实现路径。
- Astryx 组件缺口导致向导必须回退旧组件库（记录后可用旧组件，但须报告）。
