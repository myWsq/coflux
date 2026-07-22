# Plan 024: 旁观客户端不再被动抢占终端控制权

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 723e4e0..HEAD -- apps/web/src/components/workbench/workspace-terminal.tsx apps/web/src/components/workbench/terminal-pane.tsx apps/server/src/hub.ts`

## Status

- Priority: P1
- Effort: S
- Risk: MED
- Depends on: none
- Category: bug
- Execution: subagent sonnet
- Planned at: `723e4e0`, 2026-07-23

## Requirement

同一账号开着第二个客户端（另一个标签页 / 遗忘的 PWA 窗口 / 另一台设备）时，
任何一端新建终端都会在 1 秒内被另一端"抢走"控制权，弹出"此终端已被其它客户端
接管"横幅；旁观端刷新/重连时还会把对端手里的**全部** RUNNING 终端抢一遍。
已用双浏览器上下文实证：A 新建终端后 500ms 被旁观端 B 抢走；B 登录瞬间抢走 A
的既有终端。

根因链：A 新建 → server 创建 session、holder=A（`apps/server/src/hub.ts:1076`）
→ `taskUpdated` 广播 → B 端所有工作区的 `TerminalPane` 保活挂载，新任务面板
挂载后触发 `onSessionReady`（`terminal-pane.tsx:430`）→ `handleSessionReady`
对非自己启动的 RUNNING 任务**无条件** `beginAttach`
（`workspace-terminal.tsx:207`）→ server `setHolder` 踢 A 发 `taskDetached`
（`hub.ts:189`）。

完成后为真：客户端**只为用户正在看的终端**（本 `WorkspaceTerminal` 实例
`active===true` 且该任务是激活 Tab）申请控制权。后台面板、隐藏工作区、旁观
页面里非激活的任务一律不发 `taskStart`、不抢 holder；用户点击其 Tab 时经既有
`requestActivation` 路径接管。A 新建终端时，B（激活 Tab 是别的任务或无任务）
不再抢走它。

正确解 vs 相邻错误解的分界：
- 错误解 1：只改 `handleSessionReady`、不改 `snapshotRevision` 重连效果——B
  每次重连仍全量抢占，bug 只修一半。
- 错误解 2：把"页面加载时对第一个任务的自动 `requestActivation`"
  （`workspace-terminal.tsx:296-297`）也砍掉——打开页面看到的激活终端就是
  "正在看"，砍掉后打开页面是空白终端，属于误伤，明确保留。
- 错误解 3：改 server 端 `setHolder`/attach 语义——主动接管（handoff）是产品
  设计，受 `tests/src/handoff.test.mjs` 保护，server 侧一行都不改。

## Decisions & tradeoffs

- **收敛点选在 web 客户端的被动 attach，server 语义不动**：只有
  "本实例 `active` prop 为 true 且任务是激活 Tab" 才允许被动 `beginAttach`。
  Rejected: 协议加只读 observer 模式（多端同看、holder 只管输入）——涉及
  proto/server/web 三层，另立需求；Rejected: server 端 attach 不抢 holder ——
  会让主动接管（点 Tab/横幅按钮）失效，破坏 `tests/src/handoff.test.mjs:14`
  保护的语义。Based on: 被动抢占入口在
  `apps/web/src/components/workbench/workspace-terminal.tsx:207`（
  `handleSessionReady` else 分支）与同文件 `:320-332`（snapshotRevision 重连
  全量 re-attach）。
- **重连效果保留对"正在看"任务的 re-attach**：snapshotRevision 变更（重连/
  重登）后 server 侧旧 holder 已清（`apps/server/src/hub.ts:1211`），激活终端
  必须重新申请，否则变只读观众；收敛仅指过滤掉非激活/不可见任务。
  Rejected: 整个效果删除——重连后当前终端输入失效。Based on:
  `workspace-terminal.tsx:318-319` 注释记录的重连语义。
- **自己发起启动（launch）路径不变**：`launchingTaskIdsRef` 命中的任务照旧
  直接 markOwned，不发第二次 taskStart。Based on:
  `workspace-terminal.tsx:196-205`。
- **(decided while planning) 未 attach 的 RUNNING 任务不得永久显示 attaching
  spinner**：当前 `stateOf` 对无 controlState 的 RUNNING 任务回落 "attaching"
  （`workspace-terminal.tsx:368` 与 `:509` 两处 inline），收敛后后台任务将长期
  处于"未 attach"状态，若沿用回落值，Tab 上 spinner 永转、误导为卡住。执行者
  需给未 attach 的 RUNNING 任务一个中性呈现（普通终端图标即可；是否引入新
  state 字面量由执行者按最小改动设计，不引入新的用户可见文案）。
- **点击 Tab 接管沿用既有路径**：未 attach 任务点击 Tab → `requestActivation`
  → `performActivation` → `beginAttach(force=false)`，dedup key
  `${snapshotRevision}:${sessionId}` 未记录过所以必然放行，无需新协议或新
  force 语义。Based on: `workspace-terminal.tsx:130-150`。
- **残余语义（接受，不修）**：两个客户端**同时把同一个终端作为激活 Tab**时
  仍互抢（含旁观端打开页面瞬间对其第一个任务的自动激活）——这是单 holder
  模型本意，"接管"横幅即为此场景设计。

## Direction

单一里程碑，全部改动在 `apps/web/src/components/workbench/workspace-terminal.tsx`。

### Milestone 1: 被动 attach 收敛到可见且激活的终端

完成后：`handleSessionReady` 的非 launch 分支与 snapshotRevision 重连效果，
只对"本实例 `active===true` 且 `task.id === activeTaskIdRef.current`"的任务
`beginAttach`；其余任务不发 `taskStart`。未 attach 的 RUNNING 任务在 Tab 栏
显示中性图标（非 spinner、非 detached），点击后经既有路径接管。

Validation: `pnpm --filter @coflux/web build` -> exit 0（含 `tsc -b`）。

## Landmines

- `handleSessionReady` 第一行的 `sessionReadyRef.current.set(taskId, sessionId)`
  （`workspace-terminal.tsx:199`）**必须无条件保留**：`performActivation` 与
  `beginAttach` 都有 `sessionReadyRef` 门控（`:134`、`:160`），跳过注册会让
  后续点击 Tab 静默失败、终端永远接管不上。收敛的只是其后的 `beginAttach`
  调用。
- `active` prop 在 `handleSessionReady` 里读取会遇到渲染闭包过期问题：该回调
  由 `TerminalPane` 的 effect 在任意渲染代触发。工程内既定手段是 ref 双轨镜像
  "当下"值（见 `workspace-terminal.tsx:80-83` 的 `activeTaskIdRef` 及 `:67-69`
  landmine 17 注释），`active` prop 需同样处理，不要直接用闭包捕获值。
- `stateOf` 的 RUNNING 回落值 "attaching" 有两处 inline 重复：
  `workspace-terminal.tsx:368` 与 `:509`（传给 TerminalPane 的
  `controlState`），改显示语义时两处都要覆盖。
- `TerminalPane.onData/onResize` 只在 `controlState === "owned"` 时放行输入
  （`terminal-pane.tsx:270-274`），未 attach 状态天然锁输入，无需额外防护；
  但若执行者引入新 state 字面量，需检查 `terminal-pane.tsx` 中对
  `TerminalControlState` 的判等点。

## Scope

In scope:
- `apps/web/src/components/workbench/workspace-terminal.tsx`
- `apps/web/src/components/workbench/terminal-pane.tsx`（仅当引入新
  `TerminalControlState` 字面量时的类型与判等跟改）
- `plans/024-passive-attach-containment.md`、`plans/README.md`（状态更新）

Out of scope:
- `apps/server/src/hub.ts`、`proto/`、`packages/protocol/` —— server/协议语义
  不动，主动接管行为受黑盒测试保护
- observer 只读多端同看（方向 B）—— 另立需求
- `tests/src/*` —— 本改动纯 web 端，协议层黑盒测试无需新增

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck + build | `pnpm --filter @coflux/web build` | exit 0 |
| 协议层回归 (acceptance) | `cd tests && COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm test` | exit 0 |
| 双端行为复现 (acceptance) | 双浏览器上下文：B 旁观（激活 Tab 为其它任务或空）、A 新建终端 → A 12s 内无"已被其它客户端接管"横幅；B 点该终端 Tab → A 出横幅 | 行为符合 |

注：worktree 未装依赖，构建前先 `pnpm install`。

## Done criteria

- [ ] `pnpm --filter @coflux/web build` 通过。
- [ ] 旁观客户端（激活 Tab 非目标任务）在对端新建终端后不发 `taskStart`、
      对端不出接管横幅（双上下文 acceptance 验证）。
- [ ] 重连后激活终端仍自动恢复控制权；非激活任务不被重新抢占。
- [ ] 未 attach 的 RUNNING 任务 Tab 无永转 spinner，点击可正常接管。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- `handleSessionReady`/`beginAttach`/`performActivation` 的门控结构与本计划
  引用的行为已不一致（说明有并行改动，先 drift check 再继续）。

## Maintenance notes

- "被动 attach 收敛"依赖"attach = 抢 holder"这一协议事实（`hub.ts` 的
  `startOrAttachTask`/`attachSession`）。将来若落地 observer 只读模式（方向
  B），本收敛逻辑可简化为"输入焦点申请"，届时重审。
- 旁观端打开页面瞬间仍会接管其第一个任务（自动激活语义），若用户后续反馈
  该残余仍构成干扰，考虑把初始自动激活改为"不 attach、点击才接管"，代价是
  打开页面时激活终端无画面。
