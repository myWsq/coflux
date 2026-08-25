# Plan 086: macOS Foundation 集成收口——原子订阅、跨栈回归与 macOS CI

> 本 plan 是 Phase 1 的集成结果契约，不是逐步脚本。只有 plan 084/085 完成后执行；对照活代码设计
> server 缓冲、黑盒测试与 CI，逐里程碑验证/提交。命中 STOP 条件即停，完成后更新 plan 082、本文、
> `plans/README.md` 与架构文档。
>
> Drift check: `git diff --stat 5942465..HEAD -- apps/server/src/ packages/client/src/ tests/src/ tests/fixtures/ .github/workflows/ apps/macos/scripts/ docs/ plans/082-macos-native-client-program.md`

## Status

- Priority: P1
- Effort: M
- Risk: HIGH
- Depends on: `plans/084-shared-swift-client-core.md`, `plans/085-macos-native-foundation-app.md`
- Category: tests
- Execution: self-execution（沿用 plan 082 departure check）
- Planned at: `5942465`, 2026-08-25

## Requirement

关闭 Phase 1 中仅靠单机单测无法证明的两处系统边界：

1. client 订阅期间 snapshot 查询与并发广播必须原子收敛，不允许 native/Web/iOS 在查询窗口丢增量；
2. PR/主分支必须在 macOS runner 可重复生成、测试共享 Swift package 与 App，并审计 universal Release
   主产物、模块边界和 probe 不退化。

完成后 Phase 1 可标 DONE：共享 core/iOS/macOS/server 的相关回归均绿，真实隔离栈验证登录→快照→并发
增量→掉线重连，CI 可阻止 XcodeGen/Buf 漂移和 WebRTC 意外嵌入产品。LAN/TCC、Intel 实机、正式签名
仍明确留在 Phase 6–7，不得因 CI 绿而宣称发布 GO。

## Decisions & tradeoffs

- **订阅采用 server 侧 per-client syncing buffer：先进入同步态并收集该账号广播，发送数据库 snapshot
  后按原到达顺序 flush，再切 subscribed**。Rejected: 让 Swift client 猜 revision 或延迟 UI——协议没有
  server revision，丢帧无法被检测；Rejected: 本阶段改协议——server 可在现有 wire 下修正原子性。
  Based on: `apps/server/src/hub.ts:246-250,1387-1408`。

- **缓冲只覆盖 snapshot 查询窗口，受连接生命周期、账号隔离和有界保护约束**。连接关闭/auth error/
  logout 必须丢弃；同一广播不能同时直接发送又入缓冲；溢出应 fail closed 断线重订阅，不得静默丢最旧
  消息。Rejected: 无界数组——慢 DB/广播风暴可造成内存风险。

- **用真实并发黑盒证明最终状态，不只测 helper**。测试在 subscribe 查询窗口制造可控 mutation，断言
  snapshot+buffer 最终包含变化且顺序正确；抽掉缓冲时用例必须红。Rejected: mock DB 或 sleep 猜窗口——
  无法稳定复现真实竞态。

- **确定性窗口使用测试栈自有 Postgres 的锁 barrier，不向生产 server 增加测试 endpoint/hook**：harness
  只向该测试暴露它创建的临时数据库 URL；测试事务对 snapshot 会读取、但本次 mutation 不会写的表持有
  `ACCESS EXCLUSIVE` 锁，通过 `pg_stat_activity` 轮询确认真实 server SELECT 已进入 lock wait 且其它快照
  查询已静止，再完全通过 WebSocket 触发业务 mutation，最后释放锁。DB 访问只准用于 barrier/活动观测，
  不读取或修改业务行；`finally` 与 strict stack cleanup 必须回滚事务、关闭连接并删除临时库。
  Rejected: 固定 sleep——仍有竞态；Rejected: production env/file barrier——会把测试控制面带进产品。

- **不在本 plan 重写 TS client reducer**。Web 作为行为 oracle只补与共享 fixture/回归直接相关的测试；
  native package 已在 084 冻结 reducer。Rejected: 为统一代码生成跨语言 reducer——超出 Foundation。

- **新增独立 macOS CI job，固定 XcodeGen 版本与 Package.resolved，禁自动依赖漂移**。Rejected: 把 Apple
  build 塞进 Ubuntu job或每次拉 latest XcodeGen——无法复现。Based on:
  `.github/workflows/ci.yml:15-83`、`apps/macos/project.yml:1-24`。

- **普通 CI 不导入个人/Developer ID 证书，不运行 GUI TCC、跨 NAT 或真实公网验收**。CI 做 unsigned/
  ad-hoc机械门；Development signing 本机证据和 Phase 6 发布矩阵分别记录。Rejected: 把外部环境门做成
  flaky PR gate，或反过来用 unsigned build 冒充签名验收。

- **CI 必须实际构建 Release generic 并检查主 Mach-O `arm64 x86_64`、版本字段与 App 不含
  WebRTC.framework**。Rejected: 只看 `ARCHS` build setting——Debug active arch/配置图不等于产物。

- **macOS 14 runner 只证明该 runner 的 OS/arch；Apple Silicon cross-build、Rosetta 或 cloud runner 均
  不冒充 Intel 实机**。Intel/macOS 14/clean-user 最终矩阵仍由 Phase 6–7 acceptance 明确补证。

- **Phase 1 不新增 native 正式 allowlist/protocol build metadata**。Release App 产生可审计 identity；
  独立发布节奏、最低版本、`ClientOutdated` 可读信息与更新 URL 在 Phase 6 另立兼容 plan。Rejected: 用
  Web/mobile 当前 git SHA 精确准入 native——下一次 Web 部署会误杀独立 App。Based on:
  `apps/server/src/hub.ts:1724-1738,1793-1818`、`proto/coflux/v1/client.proto:249-253`。

## Direction

### Milestone 1：原子订阅实现与确定性回归

server subscription 状态能在查询窗口缓冲同账号广播并有界 flush；断连、重复 subscribe、认证切换与
溢出有负向测试。现有 Web/mobile/iOS wire 无变化。

Milestone validation: server typecheck 与目标 server tests → exit 0。

### Milestone 2：真实进程并发订阅黑盒

测试 harness 用独立临时 DB/端口启动真实 server/client，在 snapshot 查询窗口实施项目/工作区/设备变化，
数据库锁 barrier 先观测到真实 Store 查询被阻塞，再由正常 WebSocket 触发变化；最终状态无丢帧、无重复
副作用，移除缓冲路径后测试确定失败。barrier 不读取/写入业务数据，超时和异常路径也必须严格清锁。

Milestone validation: 新增目标黑盒文件单独运行 → 全过。

### Milestone 3：可重复的 macOS CI 质量门

macOS job 固定工具，验证 XcodeGen regeneration、Buf Swift 输出、local package、macOS tests、Release
universal/product purity。Package resolution 使用 committed lock 且禁止 silent update；缓存不得掩盖生成漂移。

Milestone validation: workflow 语法/本机等价命令通过；CI 配置审查无 secret/签名依赖。

### Milestone 4：Phase 1 全矩阵收口

iOS、macOS、server、protocol、黑盒和 Phase 0 probe 相关回归全部通过；docs/ROADMAP/architecture/plan
准确记录 Phase 1 完成、后置发布门和 Phase 2 入口，不写生产已发布。

Milestone validation: 快速矩阵全绿；运行环境型项目在最终 acceptance 记录。

## Landmines

- 当前 `subscribed=false` 的连接被 broadcast 跳过，snapshot DB 查询期间的变化永久丢失：
  `apps/server/src/hub.ts:246-250,1387-1408`。
- 锁 barrier 必须选择 snapshot 会读但目标 mutation 不写的表；若锁住 mutation 目标表，测试会把自己
  死锁。进入窗口以 `pg_stat_activity.wait_event_type = 'Lock'` 及其它快照查询静止为握手，不用 sleep。
- snapshot 后 server 还会按 daemon 补发 agent 全量；buffer flush 顺序不能打乱该语义或产生错误清空。
- `ProjectCreated`/`WorkspaceCreated` 是 upsert，黑盒应测 rename/defaultBranch/diff 类变化而非只新增。
- CI 若在 `buf generate` 后直接对整个 dirty worktree `git diff --exit-code`，会把预期实现 diff 当生成漂移；
  应在 committed/staged baseline 或专用临时副本验证。
- macOS App tests目前包含环境型 WebRTC/loopback probe；普通 PR job只能运行确定性子集或让未配置项按
  既有契约 skip，真实 interop最后单独 acceptance。
- XcodeGen 项目已提交，手改 pbxproj 会被 regeneration gate清除。
- GitHub macOS runner标签、Xcode版本和实际架构会变化；CI 日志必须打印 `sw_vers`、`uname -m`、
  `xcodebuild -version`、`swift --version`，不能凭标签推断实机覆盖。
- 全量黑盒历史上本机可能有 `cofluxd doctor` 环境基线；本计划新增测试不得借此豁免，最终应在隔离
  Docker/CI 环境拿到完整绿或逐项证明仅为未改路径的宿主状态。

## Scope

In scope:

- `apps/server/src/**` 中 client subscription 生命周期所需最小改动
- `tests/src/**`、必要的 `tests/fixtures/control-plane/**`
- 与共享 fixture 直接相关的 `packages/client/src/**` tests（不改产品行为）
- `.github/workflows/ci.yml` 或独立被其调用的 macOS workflow
- `apps/macos/scripts/**` 的 CI/product audit 入口
- `docs/architecture.md`、`docs/ROADMAP.md`
- `plans/082-macos-native-client-program.md`、`plans/086-macos-foundation-integration-ci.md`、`plans/README.md`

Out of scope:

- proto wire、worker/supervisor、Router transport 行为——本竞态不需协议/daemon改动
- native 正式版本准入、更新/回滚/签名/公证——Phase 6
- 完整 macOS UI/终端/diff/preview——Phase 2–5
- `apps/mobile` 功能、iOS UI、生产部署
- clean-user LAN/TCC、两 NAT、Intel/macOS 14 实机与 Developer ID acceptance——Phase 6–7

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Atomic subscribe target | `node --test tests/src/native-foundation-subscribe.test.mjs` | exit 0；负向抽查可证明缓冲必需 |
| Swift package | `swift test --package-path packages/swift-client` | exit 0 |
| macOS tests | `xcodebuild test -project apps/macos/Coflux.xcodeproj -scheme Coflux -destination 'platform=macOS' -disableAutomaticPackageResolution` | exit 0 |
| iOS regression (acceptance) | `xcodebuild test -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max,OS=latest'` | 非环境用例全过 |
| Rust protocol | `cargo test -p coflux-protocol` | exit 0，零警告 |
| Full black box (acceptance) | `pnpm -C tests test` | 隔离环境全绿；任何宿主基线单列且新增用例必须全过 |
| macOS Release product | `node apps/macos/scripts/macos-product-audit.mjs` | universal/version/purity/权限机械门通过 |
| Foundation real stack (acceptance) | `apps/macos/scripts/test-foundation-control-interop.sh` | 真实登录、原子同步、重连、logout 全过且零残留 |
| Phase 0 guards (acceptance) | `apps/macos/scripts/test-terminal-sessiond-interop.sh && apps/macos/scripts/test-webrtc-worker-interop.sh && apps/macos/scripts/test-loopback-auth-interop.sh` | exit 0 |
| TCC deferred guard | `node apps/macos/scripts/local-network-tcc-acceptance.mjs --build-only` | 构型通过；不启动 app、不声称 TCC |
| Diff hygiene | `git diff --check` | exit 0 |

## Done criteria

- [ ] 所有 listed commands 通过，运行环境与任何合法 skip/宿主基线有审计记录。
- [ ] snapshot 查询窗口内的同账号增量不丢、不重复，断连/溢出 fail closed。
- [ ] 新黑盒对移除 syncing buffer 的负向版本会失败。
- [ ] macOS CI 在真实 runner验证生成零漂移、package/App tests 与 Release universal/product purity。
- [ ] CI 不依赖个人签名 secret，不运行或伪造后置 LAN/发布 acceptance。
- [ ] iOS、Web相关测试与 Phase 0 probes 无退化，`apps/mobile`/daemon/proto wire 无功能改动。
- [ ] plan 082 Phase 1 与 README 标 DONE；Phase 2 仍需单独 plan，完整产品目标仍 IN PROGRESS。
- [ ] docs 准确区分开发、CI、Development signing 与发布 GO。

## STOP conditions

- 原子订阅只能靠新增 server revision/proto 变化或重写数据模型才能实现；先另立协议 plan。
- 缓冲无法有界且无法通过断线重订阅 fail closed。
- macOS CI 必须导入个人/Developer ID 凭据或运行 GUI TCC 才能得到机械构建证据。
- Foundation 回归需要弱化/删除 plan 083 probe，或新增黑盒在一次合理修复后连续失败两次。
- scope 扩展到 worker/supervisor、`apps/mobile`、生产部署或 Phase 2–7 功能。

## Maintenance notes

- server 未来若引入 revisioned snapshot，可重新评估 syncing buffer，但在 wire 改变前它是数据正确性边界。
- macOS runner/toolchain升级必须显式审计，不把 latest 漂移当普通缓存更新。
- Phase 1 完成只代表客户端骨架与控制面可靠；用户要求的 Web 全功能/UI/交互复刻仍需 Phase 2–5 与
  Phase 6–7 细致验收。
