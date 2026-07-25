# Plan 040: web/client 本地优先 DeviceTransport

> 本计划是 outcome contract，不是逐函数脚本。理解需求与已记录决策后，针对实时代码自行
> 设计实现。遇到 STOP condition 必须停止。完成后更新 `plans/README.md`。
>
> Drift check: `git diff --stat febdd62..HEAD -- packages/client apps/web apps/mobile packages/protocol/src apps/web/src/config.ts packages/client/src/connection.ts packages/client/src/store.ts`

## Status

- Priority: P1
- Effort: L
- Risk: HIGH
- Depends on: plans/036-local-first-session-device-contract.md
- Category: feature
- Execution: self
- Planned at: `febdd62`, 2026-07-24

## Requirement

让 desktop web 始终保留中心 control WS，同时为每个设备建立可选 DeviceTransport：用户实际操作
本机 daemon 时自动探测固定 loopback gateway，完成双向 key challenge 后优先直连；失败、权限
拒绝、版本不兼容或连接掉线时，用同一 logical client 与更高 transport generation 自动切换
到中心 relay。中心断开时，已加载且已配对页面仍能列出并接管存活 session；刷新/冷启动不保证。

## Decisions & tradeoffs

- **control 与 device transport 分离**：中心连接继续维护账号/元数据 store；terminal/git/fs/exec
  等设备流量经 DeviceTransport router。当前 `createConnection` 只有一个 `/client` socket
  （`packages/client/src/connection.ts:39-43`, `apps/web/src/config.ts:1-3`），不能用“换 URL”实现。
- **渐进增强**：只在用户进入目标本机设备/任务时探测，成功则 direct，失败静默 relay 并暴露
  可诊断状态；不把 loopback 权限作为 web 可用前置。Chrome LNA/Mixed Content 差异必须由
  capability detection 与真实 browser matrix 兜底。
- **P-256 browser profile identity**：WebCrypto private key 以 non-extractable CryptoKey 存 IndexedDB，
  public key/daemon gateway fingerprint/grant metadata 可持久；不同 tab 用不同 clientInstanceId，
  transport generation 单调递增。拒绝 localStorage 明文 secret。
- **先验证 gateway 再发业务**：检查中心提供/已缓存的 daemon gateway public key、signed hello、
  Origin 与 nonce transcript；固定端口上的陌生服务不能获得中心 token、grant 私钥或 Device RPC。
- **同 logical client 无感 failover**：direct/relay 竞速、worker restart 与 ACK 丢失时复用 request/op/
  input sequence；output gap 重取 snapshot。拒绝双路持续热流与手动 reconnect。
- **offline UI 只合并 session catalog**：中心 store 断线后保留最后业务快照，local catalog 补充活
  session 事实与 orphan 展示；只开放已定 offline scope，不提供 project/task CRUD。
- **现有单 holder UX 保持**：另一 tab/设备接管仍显示 detached，必须显式点击重新接管；同一 tab
  切 transport 不显示 detached。基于 `apps/web/src/components/workbench/workspace-terminal.tsx:322-369`。
- **全部 app 内 daemon RPC 走 router**：terminal、git/fs/exec、端口发现最终共用 direct/relay；
  public preview 域名导航仍可走现有中心 URL，不在本计划强做 loopback reverse proxy。
- **mobile 冻结**：不启用本地探测/配对 UI；共享 client/protocol 改动必须通过最小 adapter 保持
  mobile build，不同步 desktop 新功能。

## Direction

### Milestone 1: browser identity 与本地握手

IndexedDB key 生命周期、gateway signature 校验、browser transcript 签名、pairing/lease 更新和
错误分类可独立测试；无任何路径把 clientToken 发给 loopback。Validation:
`node_modules/.bin/tsc -b apps/web/tsconfig.json` -> exit 0。

### Milestone 2: DeviceTransport router

direct/relay 实现同一 interface；logical client、generation、request/op/input sequence、stream
gap 与 reconnect 状态机有确定单测，切换不自我 handoff。Validation:
`node_modules/.bin/tsc -p packages/client/tsconfig.json --noEmit` -> exit 0。

### Milestone 3: session/offline UX

local catalog 与中心 task store 合并；中心断线横幅不遮断存活 session 的 attach/input/resize/
stop；orphan 有明确本地标识；refresh 无离线 shell 时不伪装可用。Validation:
web typecheck -> exit 0。

### Milestone 4: 设备 RPC 迁移与渐进回退

现有 terminal、exec/fs、导入浏览与端口发现调用经 router；direct unavailable 时行为与当前
relay 等价。UI 只增加必要的 local/direct/relay/permission 诊断，不重做工作台。Validation:
web 与 mobile build/typecheck -> exit 0。

## Landmines

- store 在中心断线后刻意保留最后快照（`packages/client/src/store.ts:344-346`）；local session 合并
  不能用一次新的空 snapshot 抹掉业务数据。
- xterm consumer 必须先注册再 attach，现有注释记录了字节丢失事故
  （`apps/web/src/components/workbench/terminal-pane.tsx:421-422`）；新 snapshot/delta 也必须保持。
- 当前重连以 `snapshotRevision` 驱动重新 attach（`apps/web/src/components/workbench/workspace-terminal.tsx:336-369`）；
  control reconnect 与 device transport migration 必须拆成不同 revision，否则会重复抢占。
- 浏览器不能读取 `$COFLUX_HOME` 端点文件；不要引入随机端口扫描或 native helper。
- `http://127.0.0.1` 是 potentially trustworthy，不代表所有 HTTPS→WS browser 组合均可用；失败
  必须是预期分支而非错误页。

## Scope

In scope:
- `packages/client/**`
- `apps/web/**`
- `apps/mobile/**` 仅共享层变更导致的最小构建修复

Out of scope:
- service worker/offline app shell
- mobile 新功能或本地直连
- LAN/P2P、浏览器扩展、native shell
- 工作台视觉重构

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Web typecheck | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| Mobile typecheck/build | `pnpm -C apps/mobile build` | exit 0 |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Browser matrix (acceptance) | Chrome/Safari/Firefox 实机：direct 成功与 permission denied 回退 | 行为符合矩阵 |

## Done criteria

- [ ] 所有非 acceptance commands 通过；browser matrix 留给 plan 041。
- [ ] clientToken/Supabase token 从不进入 loopback URL、frame 或日志。
- [ ] direct 成功时 terminal 与普通 Device RPC 不经过中心数据帧。
- [ ] direct/relay 自动切换无重复 input/op、无自我 detached、gap 可恢复。
- [ ] 中心断开后已打开页面可重新连接 gateway 并接管存活 session。
- [ ] gateway 不可用/权限拒绝/版本不兼容时现有 relay 行为完整。
- [ ] mobile 无新功能且构建未坏。
- [ ] 实现遵循所有 Decisions & tradeoffs。
- [ ] 未修改 out-of-scope 文件。
- [ ] `plans/README.md` 状态已更新。

## STOP conditions

- 目标 browser 无法持久化所选 non-extractable key 或无法互验 plan 036 signature 格式。
- direct/relay 共用 logical client 需要改变已冻结 holder/generation 语义。
- 为支持中心离线必须引入 service worker 或本地 UI，违背已定首版边界。
- validation 在一次合理修复后连续失败两次。

## Maintenance notes

DeviceTransport 是 packages/client 的基础设施，但 mobile 默认只注册 relay transport。以后加 PWA
离线 shell、LAN/P2P 或本地 preview，应作为新 transport/capability，不把分支散进业务组件。
