# Plan 014: web 终端剪贴板贴图 —— 图片上传远程 worktree 并注入路径给 agent

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 6bd4caf..HEAD -- proto/ apps/server/src/hub.ts apps/server/src/config.ts crates/worker/src/ apps/web/src/`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent sonnet
- Planned at: `6bd4caf`, 2026-07-19

## Requirement

web 终端连的是远程 daemon 上的 Claude Code / Codex CLI。本地终端里"⌘V 贴图"
靠 CLI 自己读本机 OS 剪贴板实现——远程场景该机制天然断裂（剪贴板在浏览器所在机，
CLI 在 daemon 所在机）。本计划打通:用户在 web 终端 ⌘V 粘贴剪贴板中的图片时,
图片字节经 server 中继上传到该任务 worktree 内 `.coflux/pastes/`,成功后把落盘
文件路径作为文本注入 PTY 输入,Claude Code / Codex 会把 prompt 里的图片路径识别
为图片读取。

正确性判据(区分"对的实现"与"相邻的错的实现"):
- 粘贴**文本**的行为完全不变(仍走 xterm 原生粘贴);只有剪贴板含 image/* 时走上传流。
- 图片字节**原样**落盘(≤限内时不重编码);超限才压缩。
- 注入只发生在该终端 `active && controlState === "owned" && sessionId` 时(与
  既有手敲输入同一安全门,`terminal-pane.tsx:136-138`);非 owned 时不上传不注入,
  给出终端内提示。
- 上传失败/超时不得静默:用 `TerminalController.writeSystem` 报错(`terminal-pane.tsx:127`)。
- 远端写文件必须锚定 worktree root 且防越界(与 fsRead 同级的安全语义)。

## Decisions & tradeoffs

- **落盘位置**: worktree 内 `.coflux/pastes/`,worker 首次写入时确保目录存在并放置
  内容为 `*` 的 `.gitignore`(自我忽略,不碰 `.git`,worktree 场景无 commondir 问题)。
  Rejected: 远程机 `~/.coflux/` 或 `/tmp` —— 路径在 cwd 外,Claude Code 读图会触发
  "cwd 外读文件"权限确认,每次贴图多一步。Based on: fs 中继 root 恒为 `ws.path`
  (`apps/server/src/hub.ts:888-899`)。
- **大图策略**: 客户端压缩,不提 server 限。图片编码后若超过预算(4MB maxPayload
  减去信封余量,web 侧常量取 3.5MB)则浏览器端 canvas 重编码:先保分辨率走 JPEG
  质量阶梯(0.9 起逐档降),仍超限再减半降采样,直到限内——文字截图的可读性
  "先降质量后降分辨率"损失最小。限内图片一字节不动直传。用户明确否决了
  "提限到 16MB"与"超限报错"两案。Based on: `apps/server/src/config.ts:81`
  (`COFLUX_MAX_PAYLOAD` 默认 4MB)。(压缩阶梯细节为 planning 期决定,执行者可在
  "先质量后分辨率"原则内调参。)
- **协议形态**: 新增 `ClientFsWrite`(client.proto)→ `FsWrite`(daemon.proto)与对应
  `FsWriteResult` 回包,字段与路由完全照抄 fsRead 一族的模式:client 带
  `request_id/workspace_id/path/data(bytes)`,server 经 `workspaceForClient` 校验归属
  + `pendingRelays` 关联回包 + 换 `request_id` 下发 daemon(root=`ws.path`)。
  Rejected: 复用 `ClientExec` 塞 base64 —— ExecRun 无 stdin,argv 有平台上限,MB 级
  图片放不下。Based on: `apps/server/src/hub.ts:853-899`(clientExec/clientFsList/
  clientFsRead 三个现成中继范本)、`proto/coflux/v1/daemon.proto:206-216`。
- **注入方式**: 上传成功后调 xterm 的 `terminal.paste("路径前后各一空格")`——它自动
  按远端应用是否开启 bracketed-paste mode 决定是否包 ESC[200~/201~,且走
  `onData` → 既有 `sendInput` 链,天然复用 active/owned 门控。Rejected: 直接
  `sendInput` 手拼 ESC 序列 —— 绕过门控且需自己判断 mode 2004。Based on:
  `terminal-pane.tsx:136-138`(onData 门控)、`store.ts:111-112`(sendInput)。
- **请求-响应关联(web 侧)**: 照抄 store.ts 既有 pending-map 模式(`pendingFsLists`
  / `pendingExecs`,断线统一失败结清),新增 `pendingFsWrites`。Based on:
  `apps/web/src/client/store.ts:66-100,346-356`。
- **清理策略**: worker 每次写入 pastes 目录时顺手删除该目录下 mtime 超 7 天的文件。
  Rejected: 独立定时任务 —— 为低频清理引入常驻调度,不值。
- **文件命名**: `paste-<epoch毫秒>-<短随机>.<按 MIME 定后缀:png/jpg/gif/webp>`,
  由 web 侧生成相对路径 `.coflux/pastes/<name>` 传入。非 image/* 的粘贴不拦截。

## Direction

数据流:xterm textarea paste 事件(capture)发现 image/* → 读 Blob →(超预算则
canvas 压缩)→ `clientFsWrite` → server 校验/中继 → worker 落盘 + 回包 →
web 收 `fsWriteResult` → `terminal.paste(" <绝对或相对路径> ")` → PTY。
注入路径用**落盘的 worktree 相对路径**(如 `.coflux/pastes/paste-xxx.png`)即可,
agent cwd 即 worktree root;worker 回包里带最终相对路径,web 不自行拼装真相。

### Milestone 1: 协议消息对 + 双端代码生成

proto 两文件新增 ClientFsWrite / FsWrite / FsWriteResult(daemon→server 与
server→client 两个方向的回包都要),`cd proto && buf generate` 后 TS/Rust 产物
零手改编译通过。Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json
--noEmit` 与 `cargo build -p coflux-worker`(零警告)-> exit 0。

### Milestone 2: worker 落盘 + server 中继

worker 处理 FsWrite:确保 `.coflux/pastes/` 与其 `*` .gitignore、写字节、7 天
清理、防越界、错误回包;server hub.ts 新增 `clientFsWrite` case(归属校验、
在线校验、pendingRelays、超时)。Validation: `pnpm -C tests test` 全绿(含新增
黑盒用例:上传字节与落盘内容一致、`..` 越界路径被拒、非归属 workspace 被拒)。

### Milestone 3: web 端粘贴拦截 + 压缩 + 注入

terminal-pane 拦截 image 粘贴(文本粘贴行为不变),store 增 `sendFsWrite`
pending-map,超预算 canvas 压缩,成功 `terminal.paste`,失败 `writeSystem`;
非 owned 时 writeSystem 提示且不上传。Validation: `node_modules/.bin/tsc -b
apps/web/tsconfig.json` -> exit 0。

## Landmines

- **`safe_resolve` 对不存在的目标返回 None**(`crates/worker/src/ops.rs:63-74`
  canonicalize 目标本身):写新文件不能直接复用它——需先确保/解析**父目录**
  (canonicalize 到已存在的 worktree root,再逐段拼接并校验不越界),否则永远写不进去。
  文件名段须拒绝 `/` 与 `..`。
- **回包 oneof 两跳都要加**:`DaemonToServer.payload` 与 `ServerToClient.payload`
  各自的下一个空闲 tag 不同(见 `daemon.proto:80-103`、`client.proto:259-283`),
  照抄 fsReadResult 在两个信封里的挂法,漏一跳则 server 收到回包无处转发。
- **AGENTS.md 与现状漂移**:AGENTS 写"sqlite 持久化",实际已迁 Postgres(plan 002);
  本机跑黑盒测试须 `COFLUX_TEST_PG_URL` 指向 **54322 直连口**(5432 是 supavisor,
  会报 tenant 错)。
- **黑盒测试端口独占**:`tests/src/*.test.mjs` 每文件独占端口,新增用例需选未占用
  端口(见 AGENTS.md 测试 harness 节)。
- **worker WS 客户端未显式配 max message size**(`crates/worker/src/main.rs:413`
  connect_async 默认配置,tungstenite 默认 64MiB):4MB 级消息可过,不要顺手加限。

## Scope

In scope:
- `proto/coflux/v1/client.proto`、`proto/coflux/v1/daemon.proto` 及 buf 生成产物
  (`packages/protocol/src/gen/`、`crates/protocol/src/gen/`、`proto/gen/swift/`)
- `apps/server/src/hub.ts`(新 case;如需常量则 `apps/server/src/config.ts`)
- `crates/worker/src/main.rs`、`crates/worker/src/ops.rs`
- `apps/web/src/client/store.ts`、`apps/web/src/components/workbench/terminal-pane.tsx`、
  `apps/web/src/components/workbench/workspace-terminal.tsx`(传递 workspaceId 等接线)
- `tests/src/`(新增黑盒用例)

Out of scope:
- 拖拽文件上传、通用文件(非图片)上传 —— 同管道可后续复用,本计划不做。
- `COFLUX_MAX_PAYLOAD` 默认值调整 —— 用户已否决提限。
- `crates/supervisor`、`packages/cli` —— 数据面不经它们改动。
- server 侧持久化 —— 图片不进 DB,不留元数据。

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| server 类型检查 | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| web 类型检查 | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| daemon 构建 | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0,零警告 |
| Rust 单测 | `cargo test -p coflux-protocol` | exit 0 |
| 黑盒集成 | `COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm -C tests test` | exit 0 |
| proto 生成 | `cd proto && buf generate`(需网络拉 remote 插件) | 产物 diff 仅新增消息 |
| 真机贴图 (acceptance) | dev 三端起齐后 web 终端 ⌘V 贴图,agent 收到路径可读图 | 人工确认 |

## Done criteria

- [ ] All listed commands pass.
- [ ] web 终端 ⌘V 图片:限内原样落盘 `.coflux/pastes/`,路径注入 PTY;文本粘贴行为不变。
- [ ] 超预算图片被压缩到限内后上传成功(可用大图人工验证或单测覆盖压缩函数)。
- [ ] 越界路径/非归属 workspace/daemon 离线/非 owned 四类失败路径都有明确报错,无静默。
- [ ] 黑盒测试覆盖上传一致性与越界拒绝,断言有意义。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- `buf generate` 无法运行(网络/插件不可达)且无法用仓库既有方式再生产物。

## Maintenance notes

- `.coflux/pastes/` 是 agent cwd 内目录:若未来引入"工作区目录洁癖"类功能
  (如 status 展示、打包),记得把 `.coflux/` 视为 coflux 自留地。
- 通用文件上传/拖拽若要做,直接复用 FsWrite 管道,只改 web 侧入口。
- 压缩预算常量(3.5MB)与 server `COFLUX_MAX_PAYLOAD` 默认 4MB 存在隐式耦合,
  若日后调 maxPayload 需同步 web 侧常量。
