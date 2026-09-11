# Plan 105: 桌面客户端版本准入改为控制面协议版本——取代首发当天的 build-id lockstep

## Status

- Priority: P1
- Effort: S
- Risk: LOW
- Depends on: 103
- Category: feature
- Execution: self（用户 2026-09-11 现场决定，主会话直接实现）
- Planned at: `733676f`, 2026-09-11

## Requirement

plan 103 首发把桌面版的版本准入做成「桌面渲染层 build-id 必须与 prod 部署的 web 同 SHA」（复用 plan 033 的
浏览器语义）。首发当天就证明不可用：prod 一部署新 SHA，在线桌面版立刻被踢到「需要更新」页，直到 CI 出完包、
用户手动更新；发布顺序稍有差错（先部署后出包）就是几分钟到十几分钟的不可用。用户判断「太难用了，需要更专业的方案」。

完成后：

1. 桌面登录时上报 `client_kind=desktop` 与 `control_protocol_version`（`packages/protocol` 的常量
   `CONTROL_PROTOCOL_VERSION`，当前 1）；中心**只**在它低于 `COFLUX_MIN_CONTROL_PROTOCOL_VERSION`（默认 1）时拒绝，
   build-id 只作标识、不参与准入。
2. web/mobile（及不带 `client_kind` 的旧客户端与 iOS）行为零变化：仍按 build-id 精确准入——浏览器 reload 一次就拿到新 bundle。
3. 部署 prod 不再踢旧桌面版；桌面由 electron-updater 在后台升级。「需要更新」页只在协议过旧时出现。
4. 破坏性协议改动的流程：`CONTROL_PROTOCOL_VERSION` +1、server 最低版本默认值同步抬高，先发桌面版再部署 prod。
   `buf breaking` 在 CI 把关，它放行的改动不需要动版本号。

## Decisions & tradeoffs

- **协议版本常量，不是 app 语义版本**：准入看的是线协议兼容性，与 app 版本号（0.1.x）无关；一个常量、两端各自引用，
  不需要 server 维护「支持的桌面版本列表」。Rejected: server 维护桌面 build-id 列表——每次桌面发版都要改 server 配置；
  Rejected: 用 app semver 做最低版本——app 版本会因纯 UI 改动递增，与协议兼容性无关。
- **按 `client_kind` 选规则，而不是「带了协议版本就走协议准入」**：web 也会带协议版本（同一份 client 代码），但 web 需要
  保留 build-id reload 语义（部署即刷新，plan 033 的初衷）。Based on: `apps/server/src/hub.ts` handleClientAuth 的
  两条既有拒绝路径（clientOutdated / authError）原样保留。
- **最低版本放 server config（env 可覆盖，默认 1）**，不直接用 server 自己的 `CONTROL_PROTOCOL_VERSION`：最低支持版本是
  「还愿意服务多旧的客户端」的策略，不等于当前版本；默认值随破坏性改动一起在代码里抬高。
- **不给 `ClientOutdated` 加字段**：桌面「需要更新」页的动作（检查更新/重启安装）不依赖原因；旧桌面版（103 首发的
  0.1.0/0.1.1）不带 `client_kind`，会被中心按 web 规则用 build-id 拒绝一次，更新到本 plan 之后的版本即恢复——
  这是最后一次 lockstep。

## Direction

单里程碑：proto 加两个 optional 字段并 `buf generate`；`packages/client` 认证包带 kind 与协议版本；server 认证阶段按
kind 分流；桌面 `MainPage` 传 `clientKind: "desktop"`、文案改为「已不被服务器支持」；`desktop-release.yml` 去掉
build-id 必须等于 HEAD 的硬检查；文档（RELEASING / deployment / AGENTS / ROADMAP / apps/desktop/README）改口。

Validation：`tests/src/build-version.test.mjs` 新增 desktop 两组用例（协议版本够 → 即使 build-id 失配也 authOk；
缺协议版本 → clientOutdated；web kind 不受影响；`COFLUX_MIN_CONTROL_PROTOCOL_VERSION=2` 时版本 1 被拒、2 通过）；
`packages/client/src/connection.test.ts` 断言认证包字段；server/web tsc、buf lint、生成产物一致性。

## Scope

In scope: `proto/coflux/v1/client.proto` 与三份生成产物、`packages/protocol/src/index.ts`、`packages/client/src/{connection,store,index}.ts`、
`apps/server/src/{config,hub}.ts`、`apps/web/src/pages/MainPage.tsx`、`apps/web/src/components/workbench/desktop-update.ts`、
`.github/workflows/desktop-release.yml`、docs、tests。
Out of scope: web/mobile/iOS 的准入语义、`ClientOutdated` 消息形状、daemon。

## Done criteria

- [x] 上述测试与类型检查通过；CI 生成产物一致性通过。
- [x] 发一版桌面（0.1.2）并部署 prod 到同一 SHA——这是最后一次需要对齐；此后部署 prod 不再踢桌面版。

## Maintenance notes

- 破坏性协议改动 checklist：`CONTROL_PROTOCOL_VERSION` +1 → `apps/server/src/config.ts` 最低版本默认值 +1 →
  先打 `desktop-v*` 出包 → 再部署 prod。应急可用 env `COFLUX_MIN_CONTROL_PROTOCOL_VERSION` 临时抬高。
- iOS 不带 `client_kind`，仍按 build-id（其自己登记的原生 build id）准入，本 plan 未改。
