# Plan 20260912-unified-release-version：统一 Coflux 产品版本与发布入口

## Status
- State: IN_PROGRESS
- Priority: P1
- Effort: M
- Risk: HIGH
- Depends on: 20260912-desktop-runtime-lifecycle.md
- Execution: self
- Planned at: `c79d1202`, 2026-09-12

## Requirement
桌面和 CLI 使用同一产品版本，不再分别维护版本节奏。一个 `vX.Y.Z` tag 从同一提交构建桌面、CLI 和内核，用户获得相互匹配的产物。继续沿用本会话的独立工作区、自主实施和本地提交授权；不推送、发 tag、发布 npm、创建 PR 或部署。

## Decisions & tradeoffs
- 根 package.json 是产品版本真相源，桌面与 npm 包版本必须一致；内部不发布的 workspace/crate 版本不随意改动。二进制使用同一 COFLUX_RELEASE_VERSION。依据 apps/desktop/package.json、packages/cli/package.json 目前分别为 0.1.7、0.15.0。
- 只保留 v* 发布触发，桌面流水线成为统一发布的可复用构建步骤。同一 GitHub Release 集合包含内核 manifest 和桌面产物，稳定桌面更新源在完整产物发布后才推进。依据 .github/workflows/release.yml、desktop-release.yml 与 apps/server/src/auto-update.ts。
- npm 延续 release 成功后的 Trusted Publishing，保留文件名和上游 SHA/tag 校验；发布前增加产品版本一致性校验。不能为统一入口削弱签名、版本单调性或产物完整性检查。
- 取消内置 v0.0.0-desktop.* 引导版本，防止桌面与正式 Worker 人为分叉。统一发布不要求 Supervisor 立即切换，原终端保活契约不变。
- 首次待发布版本设为 0.34.0（高于本地已有内核 tag v0.33.0、桌面与 CLI 版本）；这只是待发布源版本，不代表已发布。实际发布门仍检查远程 main/tag 和 registry。

## Direction
1. 建立统一版本修改与校验入口，并验证不一致、错误 tag 和非法版本被拒绝。
2. 合并发布编排：桌面只构建产物，统一 release 等全部产物通过再发布；稳定更新清单和 npm 仍各有明确的失败重试路径。
3. 更新发版文档和架构指引，完成本地验证与本地提交。

## Scope
package.json、apps/desktop/package.json、packages/cli/package.json、pnpm-lock.yaml（如需）、.github/workflows/、scripts/、tests/、AGENTS.md、README.md、docs/RELEASING.md、wiki/plans/。

## Landmines
- sign job 当前下载所有 artifact，复用桌面构建后必须限制为 dist-*，避免混入桌面临时文件。
- 桌面发布不可再单独抢占 GitHub latest，完整 release 必须同时包含 daemon manifest。
- prerelease 不得覆盖稳定桌面更新源或 npm latest。
- 旧桌面继续使用 desktop-updates 分支，不迁移已安装应用的更新地址。
- 无发布权限/签名环境时只做本地验证，不将 CI 静态检查说成实际发布成功。

## Commands / Done criteria
- 统一版本正反例测试、workflow 语法与依赖检查通过。
- 桌面/server 类型检查、Rust build 零警告、pnpm -C tests test 全过。
- 从单一 tag 可追踪全部产物且版本一致，旧 desktop-v* 不再触发独立发布。
- 文档更新、工作区干净，本地提交；不执行外部发布。
