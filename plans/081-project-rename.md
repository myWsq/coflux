# Plan 081: 项目重命名——右键「重命名」对齐 device/workspace 范式

> 本 plan 是结果契约,不是逐步脚本。理解需求与已定决策后,对照活代码自行设计实现。
> self-execution:实现者即验证者,里程碑验证随做随跑。命中 STOP 条件即停。
> 完成后更新 `plans/README.md` 状态。
>
> Drift check: `git diff --stat f3a40d1..HEAD -- proto/coflux/v1/client.proto apps/server/src/hub.ts apps/server/src/store.ts apps/web/src/components/workbench/ tests/src/`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: feature
- Execution: self
- Planned at: `f3a40d1`, 2026-08-20

## Requirement

用户原始诉求是「工作区设置页面改配置」,探索后收敛:Workspace 层唯一有语义的可改项
name 已有右键重命名;真正缺口在 **Project 层——项目名导入后锁死,无任何修改入口**
(`client.proto` 只有 `ProjectImport` / `ProjectRemove`)。

完成后:用户在 web 侧栏对项目行右键 →「重命名」→ 对话框改名 → 所有在线客户端
(web/iOS)实时看到新名,刷新后仍是新名。不新建任何「设置页面」。

正确解 vs 相邻错误解:入口是**项目行右键菜单项 + 重命名对话框**,与 device
(`sidebar.tsx:583`)、workspace(`sidebar.tsx:381`)完全同构;做成独立设置页/设置
对话框、或顺手把 default_branch/repo_path 开放编辑,都是错误解。

## Decisions & tradeoffs

- **不做设置页面,只加右键重命名**。Rejected: 独立工作区/项目设置页 — 当前唯一可改
  项就是名称,单项配置撑不起一个页面,且引入全新 UI 范式(现有范式是右键菜单,
  `sidebar.tsx:260-266` 项目行已有 ContextMenu)。
- **default_branch 不开手改**。Rejected: 设置页里加默认分支编辑 — plan 072 已让
  worker 探测本地 `origin/HEAD` 与 server 缓存不符即上报纠正
  (`crates/worker/src/main.rs:1034-1050`),手改会在下一轮清单下发时被探测覆盖;
  真相源在设备侧,中心 DB 只是缓存。Based on: `apps/server/src/hub.ts:1172`
  (`workspaceDefaultBranch` 处理块注释「真相在设备侧,DB 是缓存」)。
- **空名拒绝,不做回落**。对齐 device 语义(`hub.ts:1652-1654`「空名拒绝;设备没有
  回落默认值」)。Rejected: 对齐 workspace 的空名回落分支名(`hub.ts:1643`)—
  workspace 有天然回落值(branch),project 的导入期推导名(plan 020 从 git remote
  推导)不是随手可取的现值,为回落再跑推导不值。服务端与对话框两侧都拦空名。
- **复用 `projectCreated` 广播做 upsert,不新增下行消息**。Based on:
  `packages/client/src/store.ts:470-474` 已对 `projectCreated` 做 upsert;plan 072
  的 default_branch 纠正即走此路(`hub.ts:1183`)。因此 `packages/client` 零改动,
  iOS/mobile 自动同步。
- **proto 新消息 `ProjectSetName { project_id, name }`,oneof 取下一号 37**。
  Based on: `client.proto` ClientToServer oneof 现最大号 36(`DeviceP2pChannelOpen`),
  4/16/17/19-23/25/29-31 是 reserved 不可复用。参照 `WorkspaceSetName`
  (`client.proto:82`)/`DeviceSetName`(`client.proto:88`)的注释风格,注明空名拒绝。
- **归属校验按 accountId**。Based on: `hub.ts:1642`(workspace)与 `hub.ts:1651`
  (device)均为 `x.accountId !== client.accountId` 即静默 return,项目侧同构;
  store 侧参照 `store.ts:866` `updateWorkspaceName` 的单条 UPDATE RETURNING 形态。

## Direction

### Milestone 1: 协议 + 服务端——ProjectSetName 全链路落库并广播

`proto/coflux/v1/client.proto` 加 `ProjectSetName`,`buf generate`(在 `proto/` 下跑,
`clean: true` 会重建 TS/Rust/Swift 三处 gen 产物,全部随提交入库);`apps/server` 的
`hub.ts` 处理 + `store.ts` 加 `updateProjectName`,成功后广播 `projectCreated`。
黑盒测试加项目重命名用例(参照 `tests/src/device-rename.test.mjs` 的双客户端
「广播可见 + 落库可查」形态;造 project 的手法参考现有用到 `mkRepo()` + 导入流程的
用例)。

Validation:
`node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` → exit 0;
`cargo build -p coflux-supervisor -p coflux-worker` → exit 0 零警告(Rust gen 重编);
`pnpm -C tests test` → 全绿(含新用例)。

### Milestone 2: web 入口——项目行右键「重命名」+ 对话框

`sidebar.tsx` 项目行 ContextMenu(`sidebar.tsx:260-266`,现有「新建工作区」「移除
项目」)加「重命名」;`dialogs.tsx` 照 `DeviceRenameDialog`(`dialogs.tsx:82`,空名
禁提交语义)加 `ProjectRenameDialog`;`workbench.tsx` 接线发送(参照
`workbench.tsx:290` 的 `workspaceSetName` 发送形态)。菜单项排序与 workspace 行
一致:「重命名」在前,破坏性操作(移除项目)在 divider 之后。

Validation: `node_modules/.bin/tsc -b apps/web/tsconfig.json` → exit 0。

## Landmines

- `buf.gen.yaml` 是 `clean: true`:`buf generate` 会**清空重建**
  `packages/protocol/src/gen`、`crates/protocol/src/gen`、`proto/gen/swift` 三处。
  若产物 diff 出现大面积非本次字段的变动,说明 buf 插件版本漂移,STOP 报告而非提交。
- `hub.ts` 的 client 侧消息处理块里,归属不符是**静默 return**(无错误回包),新
  处理沿用此惯例,测试断言用「等广播 + 查快照」而非等错误响应。
- 黑盒测试串行跑(`--test-concurrency=1`)且每个文件自起 stack 固定端口:新用例
  文件需选未被占用的 PORT(如 device-rename 用 8843,附近文件各不相同)。
- AGENTS.md 纪律:提交前 `tsc --noEmit` + `cargo build`(零警告)+
  `pnpm -C tests test` 全绿;commit message 中文、结尾带 Co-Authored-By。

## Scope

In scope:
- `proto/coflux/v1/client.proto` 及 `buf generate` 的三处 gen 产物
- `apps/server/src/hub.ts`、`apps/server/src/store.ts`
- `apps/web/src/components/workbench/{sidebar,dialogs,workbench}.tsx`
- `tests/src/`(新增项目重命名用例)
- `plans/README.md`(状态更新)

Out of scope:
- `packages/client` — `projectCreated` upsert 已在(`store.ts:470`),零改动
- `apps/mobile` — 已冻结,upsert 广播自然同步,不动
- `apps/ios` — 同上,收广播自动更新
- default_branch / repo_path 的任何编辑入口 — 见 Decisions
- 独立设置页面/设置对话框 — 见 Decisions

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| server 类型检查 | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| web 类型检查 | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| daemon 构建 | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0 零警告 |
| 黑盒集成测试 | `pnpm -C tests test` | 全绿 |
| web UI 走查 (acceptance) | 用户人工验证(既定惯例,Claude 不做 UI 验证) | 用户确认 |

## Done criteria

- [ ] 上表命令全过(UI 走查除外,交用户)。
- [ ] web 项目行右键出现「重命名」,改名后双客户端广播可见、落库持久。
- [ ] 空名(含全空白)在服务端与对话框两侧均被拒绝。
- [ ] 新增黑盒用例断言广播与落库,且沿用既有 harness 形态。
- [ ] 实现遵守 Decisions & tradeoffs 每一条。
- [ ] 无 out-of-scope 文件变更(gen 产物除外,其属 in-scope)。
- [ ] `plans/README.md` 状态已更新。

## STOP conditions

- Decisions 引用的事实不再成立(如 oneof 37 已被占用、projectCreated upsert 语义变更)。
- 实现需要动 out-of-scope 文件(尤其 packages/client)。
- 某验证命令经一次合理修复后仍连败两次。
- `buf generate` 产物出现大面积无关 diff(插件版本漂移)。

## Maintenance notes

- 项目名是纯展示别名,不参与任何路径/分支推导;导入期的 remote 推导名(plan 020)
  只在导入时跑一次,重命名后不会被覆盖。
- 若未来真出现第二、第三个项目级配置,再考虑把右键菜单收敛成设置对话框;单项时
  右键直达是最低熵形态。
