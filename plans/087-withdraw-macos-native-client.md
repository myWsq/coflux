# Plan 087: 撤回 macOS 原生客户端——移除 apps/macos 与 macOS-only 适配层

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 7bbcc7c..HEAD -- apps/macos packages/swift-client docs/ROADMAP.md docs/architecture.md plans/README.md`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: refactor
- Execution: self
- Planned at: `7bbcc7c`, 2026-08-26

## Requirement

用户于 2026-08-26 决定撤回 macOS 原生客户端项目（plans 082–086 这条线），不再做。
完成后仓库应满足：

1. `apps/macos/` 不存在；工作区没有 085 Foundation 半成品残留（当前全部未提交改动都在
   `apps/macos` 下，直接丢弃，departure check 已批准）。
2. `packages/swift-client` 回到 084 验收态：`7bbcc7c`（macOS-only 平台适配层）被 revert，
   其余（a402d90 / 0923ddd / 00e5c7a 建立的共享核心）完好——iOS 是唯一消费者且在用。
3. 文档反映撤回状态：plans/README.md、docs/ROADMAP.md、docs/architecture.md 不再描述
   macOS 原生为进行中/待办，且不留指向已删文件的悬空指针。

**相邻错误解**（都算失败）：连 084 共享核心一起回退（iOS 会坏）；rebase 重写历史（丢
可找回性，且 19 个未推送 commit 与 iOS/web/server 工作交错）；删除 plans/082–086 文档
文件（违反 030 撤回先例）；动 `.github/workflows/release.yml` 的 darwin 内容（那是
cofluxd/CLI 发布链路，与原生客户端无关）。

## Decisions & tradeoffs

- **移除方式：正向删除 commit，不 rebase**。19 个相关 commit 全部未推送 origin，但与
  iOS/web/server 工作交错（如 a402d90 同时改 `proto/buf.gen.yaml` 与 docs），rebase 冲突
  面大且抹掉历史反而丢失将来重启时的可找回性。Rejected: interactive rebase 抹掉 macOS
  commits——纯风险无收益。
- **`7bbcc7c` 用 `git revert`，不保留备用**。该 commit 名为 feat(macos) 但改动全在
  `packages/swift-client`（URLSessionWebSocketTransport / OSLogClientLogger /
  BundleBuildIdentity 新增 + KeychainTokenStore 重构 + 约 680 行测试），iOS 零引用，
  是"不做了"决定下的死代码；revert 后 KeychainTokenStore 回到 00e5c7a iOS 全量回归验证
  过的版本。Rejected: 留备用——约 1100 行纯维护负担。Based on:
  `apps/ios/Coflux/CofluxApp.swift:21,38` 仅引用 `KeychainTokenStore`、
  `NetworkFrameworkTransport`。
- **保留 packages/swift-client 其余部分与 proto swift 生成路径**。084 共享核心是 iOS
  的唯一实现（package 44/44、iOS 全量回归已过）；`proto/buf.gen.yaml` 的 swift 输出
  指向 `packages/swift-client/Sources/CofluxClientCore/Generated`，iOS 在用。
  Rejected: 连共享核心回退到 00e5c7a 之前——iOS 已验证的模块化重构作废，纯损失。
- **plan 文件保留，仅 README 标 WITHDRAWN**。沿用 030 先例（`plans/README.md:34`：
  文件保留、状态标 WITHDRAWN 并注明原因）。082 从 IN PROGRESS、085/086 从 TODO 改为
  WITHDRAWN；**083/084 保持 DONE**（历史事实，083 可注明产物已随本 plan 移除）。
- **release.yml 不动**。其中 macos-latest / MACOS_CERT 等内容是 cofluxd/CLI 的 darwin
  交叉编译 + Developer ID 签名公证链路。Based on: `.github/workflows/release.yml:21-22,52-56`。

## Direction

### Milestone 1: 工作区清理 + apps/macos 删除

丢弃工作区全部未提交改动（已确认全在 `apps/macos` 下：8 个未跟踪 Foundation* 文件 +
pbxproj/project.yml/CofluxApp.swift/4 个 Native*Tests 修改），然后 `git rm -r apps/macos`
提交。Validation: `git status --porcelain` 干净（除后续计划内改动）；`ls apps` 无 macos。

### Milestone 2: revert 7bbcc7c

`git revert 7bbcc7c`（当前 HEAD，revert 无冲突）。Validation:
`swift test --package-path packages/swift-client` → exit 0，回到 084 验收基线（44 项，
不再含 7bbcc7c 新增的 adapter 测试）。

### Milestone 3: 文档收口

- `plans/README.md`：082/085/086 状态改 WITHDRAWN（注明 2026-08-26 用户决定不做，
  代码已随 plan 087 移除、可从 git 历史找回）；执行顺序行追加 087；Backlog 中
  「macOS native Phase 2–7 子计划」条目（`plans/README.md:101-103`）删除或标记已撤回。
- `docs/ROADMAP.md`：条目 4「macOS 原生客户端」（`docs/ROADMAP.md:74-94`）收敛为撤回
  注记，仿既有先例写法（`docs/ROADMAP.md:35-36` 的 2026-07-15 立项次日撤回注记）；
  可保留 083 可行性结论仍然成立的一句话，供将来重启参考。
- `docs/architecture.md`：仓库结构表移除 apps/macos 行（`docs/architecture.md:373`）；
  macOS probe 相关段落（105、130-137、274、293-299 附近）与发布门句中的
  「macOS native↔Rust/loopback 跨栈门」（383-385）收敛为历史注记或删除，执行者对照
  现状裁量——原则：不再描述为现行验证门，不留指向已删文件的悬空路径。

Validation: `rg -n "apps/macos" --glob '!plans/*'` → 无输出。

### Milestone 4: 回归验证

iOS 构建回归 + 全仓引用扫描。Validation: 见 Commands。

## Landmines

- `7bbcc7c` 虽名为 feat(macos)，改动却全在 `packages/swift-client`——删 `apps/macos`
  目录不会移除它的内容，必须 `git revert`。
- `docs/architecture.md:137`「详见 `apps/macos/WEBRTC_PROBE.md`」与
  `docs/ROADMAP.md:93-94` 引用同一文件——目录删除后成悬空指针，历史注记需改为指向
  `plans/083-macos-native-client-feasibility-gates.md` 或 git 历史。
- `plans/README.md` 的 082/083 表格行极长（单行数百字），编辑时用精确唯一锚点，防错行。
- M2 之前跑 `swift test` 会包含 7bbcc7c 新增的 adapter 测试，基线数与 44 不符——先
  revert 再跑。
- 未跟踪文件 `git checkout` 不会清掉，需配合 `git clean -fd apps/macos`（危险命令，
  仅限该目录，执行前 `git clean -nd apps/macos` 预览确认全部路径都在 apps/macos 下）。

## Scope

In scope:

- `apps/macos/**`（整目录删除 + 工作区未提交改动丢弃）
- `packages/swift-client/**`（仅 `git revert 7bbcc7c` 触及的文件）
- `plans/README.md`、`plans/087-withdraw-macos-native-client.md`
- `docs/ROADMAP.md`、`docs/architecture.md`
- `tests/fixtures/terminal/README.md`（decided while executing：探索时 grep 输出被截断漏列，
  其 19-20 行引用已删除的 `apps/macos/scripts/test-terminal-sessiond-interop.sh`，属 M3
  悬空指针收口的同类内容，仅删该半句；fixtures 本体与 xterm oracle 消费者不动）

Out of scope:

- `apps/ios/**` — 不做任何改动，仅构建回归验证
- `packages/swift-client` 的 084 核心逻辑（CofluxClientCore / DeviceRouter / 既有
  CofluxApplePlatform 文件）— revert 范围之外不触碰
- `proto/**`（含 buf.gen.yaml swift 生成路径）— iOS 在用
- `.github/workflows/release.yml` — cofluxd/CLI darwin 发布链路
- `plans/082-086` 五个 plan 文档文件 — 按 030 先例保留

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Package tests | `swift test --package-path packages/swift-client` | exit 0（revert 后 44 项基线） |
| iOS build 回归 | `xcodebuild build -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator'` | exit 0 |
| 残留引用扫描 | `rg -n "apps/macos" --glob '!plans/*'` | 无输出 |
| Diff hygiene | `git diff --check` | exit 0 |

## Done criteria

- [ ] All listed commands pass.
- [ ] `apps/macos/` 不存在，工作区无未提交残留。
- [ ] `git log` 顶部为删除 commit + revert commit（或合并为一批提交），未 rebase 既有历史。
- [ ] plans/README.md 中 082/085/086 为 WITHDRAWN，083/084 仍为 DONE，执行顺序含 087。
- [ ] docs/ROADMAP.md、docs/architecture.md 无 macOS 原生进行中表述、无悬空文件指针。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds（如发现 iOS 引用了
  7bbcc7c 新增符号）。
- `git revert 7bbcc7c` 出现冲突（说明 HEAD 已变，需重估）。
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- `git clean -nd apps/macos` 预览出现 apps/macos 之外的路径。

## Maintenance notes

- 将来重启 macOS 原生项目：代码在 git 历史（`384142b..7bbcc7c` 区间 + 本次删除 commit
  的父提交）可整体找回；083 的可行性门结论（SwiftTerm / native loopback 身份 /
  libwebrtc↔Rust worker 互通，开发 GO）不因删除失效，plan 文档仍在。
- `packages/swift-client` 自此定位为 iOS 专属共享核心；若再出现"为未来平台预留"的
  适配层提交，按本 plan 先例处理。
