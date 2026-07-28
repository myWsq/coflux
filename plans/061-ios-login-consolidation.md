# Plan 061: iOS 登录收敛——删除 SupabaseAuth，统一邮箱密码直发

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat c772ed4..HEAD -- apps/ios`

## Status

- Priority: P1
- Effort: S
- Risk: LOW
- Depends on: plans/059-server-password-auth.md
- Category: migration
- Execution: self
- Planned at: `c772ed4`, 2026-07-28

## Requirement

同 060 的三端收敛，iOS 侧：059 之后 server 只认 `clientAuth { username, password }` 直发（local | password 两模式同帧），`supabaseToken` 换票路径消失。iOS 现在是「HTTP POST Supabase 拿 access_token → `.supabase` 凭证连接」两跳；收敛为 `.password` 凭证一跳直连，删除全部 Supabase 代码与硬编码常量。

完成后：`rg -i supabase apps/ios --glob '!*.pb.swift'` 零命中（proto 生成码里的废弃字段保留，不重新生成）；登录页对 local/password 两种服务端模式通用。

## Decisions & tradeoffs

- **`.supabase` 凭证态删除**：`AuthCredential` 收敛为 `.token` | `.password`；`login()` 删除 `usesExternalLogin` 分岔与 `SupabaseAuth.exchange` 调用，一律 `.password` 直连；`authPayload()` 与 `authError` 文案分岔随之删除。Rejected: 保留枚举 case 作扩展点 —— 用户明确不接 OAuth，死代码删除。
  Based on: `apps/ios/Coflux/Client/CofluxClient.swift:21,138-154,307-320,541-548`。
- **`SupabaseAuth.swift` 整文件删除**，`Config.swift` 的 `supabaseURL`/`supabaseAnonKey`/`useSupabase` 常量删除。
  Based on: `apps/ios/Coflux/Client/SupabaseAuth.swift:12-44`（唯一 Supabase 网络调用）、`apps/ios/Coflux/Client/Config.swift:7-10`。
- **登录页文案中性化**：与 060 同一决策——「账号」+「密码」，删除 `Config.useSupabase` 驱动的标签/键盘类型分岔（邮箱键盘类型可保留为默认体验，executor 自定，但不得依赖已删除的开关）。
  Based on: `apps/ios/Coflux/Views/LoginView.swift:28,31`。
- **proto Swift 生成码不动**：`client.pb.swift` 里 `supabaseToken` 字段保留（059 决策协议零变更，不重新生成、不手改生成码）。
  Based on: `proto/gen/swift/coflux/v1/client.pb.swift`（生成产物）。
- **会话 token 链路不动**：`authOk` 后 `tokenStore.write` 与重连逻辑与本 plan 无关，不碰。
  Based on: `apps/ios/Coflux/Client/CofluxClient.swift:307-309`。

## Direction

### Milestone 1: 凭证收敛 + 文件删除

上述删除与收敛完成，Xcode 工程引用同步清理（pbxproj 里 SupabaseAuth.swift 的编译条目）。
Validation: `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator' build` -> exit 0（以仓库/release.sh 实际使用的 scheme/destination 为准）。

## Landmines

- 删 Swift 文件必须同步清 `Coflux.xcodeproj/project.pbxproj` 引用，否则构建直接失败——iOS 工程无 SPM 包管理 Supabase（SPM 只有 swift-protobuf 与 SwiftTerm），别去动包依赖。
  Based on: `apps/ios/Coflux.xcodeproj/project.pbxproj:158-159`。
- iOS 与 web 的错误暴露语义有既有差异（`SupabaseAuth.swift:27-35` 区分 invalid_credentials 与状态码）——收敛后错误全部来自 server 的 `authError` 帧，删掉 HTTP 层错误分类即可，不要在新路径上重造它。

## Scope

In scope:
- `apps/ios/Coflux/Client/{SupabaseAuth.swift（删）,Config.swift,CofluxClient.swift}`
- `apps/ios/Coflux/Views/LoginView.swift`
- `apps/ios/Coflux.xcodeproj/project.pbxproj`（仅文件引用清理；执行时确认为 fileSystemSynchronized 工程，删文件无需改 pbxproj）
- `apps/ios/CofluxTests/{AuthFlowTests,DeviceIntegrationTests,ReducerTests}.swift`（执行期 scope 修订：init 删 `usesExternalLogin` 参数连带更新三处调用点——计划期未发现这三个测试文件传参）

Out of scope:
- `proto/gen/swift/` —— 生成码不动
- 其余 iOS 视图/终端/滚动等一切非登录代码
- server / web / mobile —— 059/060 负责

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 构建 | `xcodebuild -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS Simulator' build` | exit 0 |
| 登录闭环 (acceptance) | 模拟器连本地 `COFLUX_AUTH=password` server 登录 | authOk |

## Done criteria

- [ ] All listed commands pass.
- [ ] `rg -i supabase apps/ios --glob '!*.pb.swift'` 零命中。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- 真机生产验收待用户（惯例）；TestFlight 发版走 release.sh，属 063 生产切换后的动作。
