# Plan 090: 中心托管 MCP 第一片——OAuth 2.1 授权服务器 + `/mcp` 端点 + 只读 tools

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 80eedb0..HEAD -- proto/coflux/v1/client.proto apps/server/src apps/server/package.json apps/web/src/App.tsx apps/web/src/pages tests/src/harness.mjs docs/auth-design.md`

## Status

- Priority: P1
- Effort: L
- Risk: MED
- Depends on: none（三片之一：090 → 091 → 092；本片是 091/092 的前置）
- Category: feature
- Execution: subagent fable（出发检查 2026-09-05 授权：090 → 091 → 092 连续写 plan 并执行，中途不再向用户确认；STOP/BLOCK 仍停；push/PR/merge 不在授权内）
- Planned at: `80eedb0`, 2026-09-05

## Requirement

coflux 的能力面目前只有两个入口：web/iOS 给人用；`cofluxd` 里那组零凭证的 agent 命令
（plan 074/088）只给**跑在 coflux 终端里**的 agent 用，且只能看见自己所在的工作区。用户要把
「看账号资产、开子工作区、在里面跑终端、读结果」这组能力给到**任何机器上的 Claude Code /
Codex**——包括不在 coflux 终端里的、甚至没装 daemon 的机器。

用户拍板的形态（dev-explore 2026-09-05，已确认，不再回问）：

- **中心托管的远程 MCP server**（Streamable HTTP，生产地址 `https://api.coflux.dev/mcp`），
  agent 宿主一行接入：`claude mcp add --transport http coflux <url>` / `codex mcp add coflux --url <url>`。
- **标准 OAuth 2.1**：宿主自己走授权（Claude Code 在 `/mcp` 菜单里点授权、Codex `codex mcp login`），
  浏览器落到 web 的确认页，用已登录账号确认一次；之后宿主自动刷新 token。
- **不做新 CLI、不做 daemon 侧 MCP**。`cofluxd` 及其本地 pid 反查的 agent 命令与 `hook` 原样保留，
  MCP 是叠加的账号面。
- 这件事切三片：**本片（090）= OAuth 授权服务器 + `/mcp` 端点 + 只读 tools**；091 = 中心发起的
  daemon 副作用 + 工作区/终端写 tools；092 = 每个 PTY 会话注入 `COFLUX_*` 环境变量。

### 本片做完之后为真（消费者视角）

1. 任何机器上的 Claude Code 一行接入后，首次调用得到 401，宿主打开浏览器，落到 web 确认页
   （未登录先登录；已登录则直接显示「<客户端名> 请求访问你的 coflux 账号」+ 确认/拒绝）。确认
   后浏览器跳回宿主的回调地址，宿主拿到 token，之后不再打扰用户；拒绝则宿主收到 `access_denied`。
2. 接入后 agent 能调这组 tools（snake_case 名以此为准，参数与输出形状执行者定）：
   - `list_devices`：账号下设备（id、名称、host、platform、在线与否、worker/supervisor 版本）
   - `list_projects`：项目（id、所属设备、名称、repo 路径、默认分支）
   - `list_workspaces`：工作区（id、项目、设备、名称、路径、分支、是否主工作区、diff 增删行数），可按项目筛
   - `list_terminals`：终端/任务（id、工作区、标题、状态、退出码、创建时间），可按工作区筛
   - `read_terminal`：某终端的纯文本内容（去 ANSI、默认尾 200 行、可指定行数）+ 状态/退出码 + 快照时间
   - `list_ports`：账号下（或某工作区）监听端口与可直接打开的预览 URL
3. 所有 tools 只返回**调用者账号**的数据；token 无效/过期时 `/mcp` 返回 401 并带
   `WWW-Authenticate: Bearer resource_metadata="…"`，宿主据此重新授权或刷新。
4. web 侧栏、iOS、`cofluxd` 的既有行为零变化。

### 相邻的错误解法（不是这个）

- **不是**静态访问令牌：不做「web 生成令牌、用户粘到宿主配置」——令牌明文躺在宿主配置里，还
  要一套令牌管理 UI。必须是宿主发起的 OAuth 授权码流程。
- **不是**把 web 的会话 token 借给 MCP：`client_tokens` 与浏览器登录/登出绑定，MCP 凭证必须独立
  签发、独立存储、独立过期。
- **不是**有状态的 MCP 会话：transport 无状态，每个请求凭 bearer 独立认身份。
- **不是**在本片做任何写操作或经 daemon 的读取：写 tools 与「经 daemon 读命令日志」都在 091。
  本片 `read_terminal` 基于中心已有的会话 checkpoint（2 秒周期），这是**过渡实现**，091 替换。
- **不是**给 agent 一套新的通知/进度通路：`notify`/`progress` 留在 `cofluxd`。

## Decisions & tradeoffs

- **形态是中心托管远程 MCP，不是 CLI、不是 daemon 侧 MCP**：plan 074 否决 MCP 的理由是
  「daemon 用 Rust 实现整套 JSON-RPC、用户改 ~/.claude.json、codex 支持度未知」，全部针对
  daemon 侧；中心是 TS + Raven（hono），官方 SDK 挂 Streamable HTTP 端点成本极低，Claude Code
  与 Codex 现已原生支持远程 HTTP MCP + OAuth。Rejected: 新 `coflux` CLI + `coflux login`——
  npm 名 `coflux` 已被占；工具描述随 npm 版本漂移；用户 2026-09-05 明确只做 MCP。
  Based on: `plans/074-agent-coflux-control.md` Decisions「形态是 CLI 子命令 + SKILL.md，不做 MCP」；
  `apps/server/src/app.ts:12-18`（Raven + `registerContractRoute`）。

- **认证是标准 OAuth 2.1，授权服务器就落在中心**：中心同时是资源服务器与授权服务器。必做：
  `/.well-known/oauth-protected-resource`（PRM，`authorization_servers` 指向自己）、
  `/.well-known/oauth-authorization-server`（AS 元数据）、动态客户端注册（DCR，公共客户端、
  `token_endpoint_auth_method: none`）、authorize（302 到 web 确认页）、token（`authorization_code`
  + PKCE `S256` 必填校验、`refresh_token` 轮换）。`/mcp` 无/坏 token 回 401 且
  `WWW-Authenticate` 带 `resource_metadata`。CIMD（Client ID Metadata Documents）可选，执行者
  决定做不做。redirect_uri 校验：loopback（`http://localhost` / `127.0.0.1` / `[::1]`）**允许任意
  端口与路径**（RFC 8252，Claude Code 每次随机端口回调）；非 loopback 必须与注册值精确相等。
  Rejected: 只支持 CIMD——Claude Code/Codex 都支持 DCR，DCR 是两宿主的最大公约数。
  Based on: MCP 规范 2026-07-28 authorization 章（PRM 必须实现；AS 须 OAuth 2.1；CIMD 推荐、
  DCR 弃用但支持）；Claude Code docs（回调 `http://localhost:<随机端口>/callback`，支持 DCR 与
  CIMD，401/403 触发 `/mcp` 授权，已授权 401 自动刷新重试一次）；Codex docs（`codex mcp login`，
  注册策略 `AUTO|CIMD|DCR`）。

- **凭证存储：新建独立表，只存 hash；授权请求与授权码只在内存**：持久化的是 DCR 客户端与
  access/refresh token（hash、account_id、user_id（可得时）、client_id、scope、过期、撤销）。
  「authorize 到确认」之间的待确认请求与签发出的授权码放内存 map（TTL、一次性、上限），与设备
  授权 `pendingAuthorizations` 同款——中心单实例，重启只是让宿主重来一次授权。
  Rejected: 复用 `client_tokens`——`revokeAllClientTokens` 与 web 登出语义绑定、无 client 绑定、
  无 refresh 轮换；Rejected: 授权码落库——为一个 10 分钟内一次性的东西付迁移与清理成本。
  Based on: `apps/server/src/store.ts:358-387`（client_tokens 的 upsert/lookup/revoke/revokeAll）；
  `apps/server/src/hub.ts:276`、`:1562-1590`（pendingAuthorizations + `maxPendingAuthorizations`）；
  `docs/OPEN_QUESTIONS.md`「单实例中心」；`docs/auth-design.md`「状态只在内存里」。

- **token 是不透明随机串（`genToken` 前缀风格），access 短期 + refresh 长期且用过即作废**：
  refresh 轮换时旧 refresh 立即失效，旧 access 到期自然失效；具体有效期由执行者定（建议
  access 小时级、refresh 与 `COFLUX_SESSION_TTL_MS` 同量级）。Rejected: JWT——引入密钥管理，
  且无法即时撤销；仓库所有凭证都是「随机串 + sha256 hash 落库」。
  Based on: `apps/server/src/secrets.ts:4-10`（`genToken`/`hashToken`）；`docs/auth-design.md`
  「服务器只持久化 token hash」。

- **确认页照 AuthorizePage 的独立 WS 连接范式，经新增的一对 client 消息完成确认**：新页面按
  pathname 挂到 `App.tsx`，自带独立 WebSocket：`clientAuth` 认身份（未登录走同一登录表单）→
  新增「查询待确认请求」消息拿客户端名/回调 host → 用户确认/拒绝 → 新增「确认」消息 →
  server 签发授权码并回**完整 redirect URL**（含 `code` 与原 `state`；拒绝时含
  `error=access_denied`）→ 页面 `location.assign`。`ClientToServer` 下一个可用字段号 **38**，
  `ServerToClient` 下一个可用字段号 **37**（两侧 reserved 已核对）。
  Rejected: HTTP cookie 会话——web 根本没有 HTTP 会话，登录态只在 localStorage 的会话 token；
  Rejected: 让确认页用 fetch 带 bearer 调 HTTP——绕开仓库唯一的 client 认证路径，多一条要维护
  的认证入口。
  Based on: `apps/web/src/pages/AuthorizePage.tsx:35-60`（独立 WS + clientAuth + 消息对）；
  `apps/web/src/App.tsx:17-20`（按 pathname 选组件树）；`proto/coflux/v1/client.proto`
  `ClientToServer` 最高 37、`ServerToClient` 最高 36；`packages/client/src/store.ts:620` 与
  `packages/swift-client/Sources/CofluxClientCore/CofluxClient.swift:498` 对未知分支都有 `default`。
  账号与用户 1:1（`hub.ts:2819-2826`），确认页不需要选账号。

- **`/mcp` 挂在 Raven contract 路由上（POST/GET/DELETE 三个 method 并存），无状态 transport，
  每请求 new 一个 McpServer 绑定 principal**：principal = 由 bearer 解析出的
  `{ accountId, userId?, clientId, scope }`，所有 tool 实现只拿 principal 不拿 Request。Raven
  对 `content-type` 含 `application/json` 的请求会**无条件**先 `await request.json()`，handler
  拿到的 Request body 已被消费——必须把 Raven 解析好的 body 作为 `parsedBody` 交给 SDK 的
  `handleRequest`。OAuth 与 MCP 端点的所有错误**构造 `Response` 返回**，绝不 throw（Raven 的
  onError/notFound 会包成它自己的 JSON 信封，OAuth 客户端读不懂）。
  Rejected: 在 `index.ts` 的 http listener 层旁路 Raven——复制一套路由/错误处理，且丢掉 Raven
  的请求上下文；Rejected: 有状态 session（`Mcp-Session-Id`）——本片无任何跨请求状态，反而给将来
  多实例埋雷。
  Based on: `node_modules/.pnpm/@raven.js+core@3.0.0_hono@4.12.30/node_modules/@raven.js/core/dist/index.mjs:432-441`
  （JSON 预解析）、`:534-542`（错误信封）、`:614-618`（路由按 method+path）；
  `apps/server/src/index.ts:37-44`（只按预览域 Host 分流，其余全进 Raven，`.well-known` 不会被截）；
  MCP TS SDK：`WebStandardStreamableHTTPServerTransport`（`sessionIdGenerator: undefined` 即无状态，
  `handleRequest(request, { parsedBody })`）。

- **SDK 与 schema 库由执行者选并锁精确版本**：`@modelcontextprotocol/sdk` 1.30.0 与
  `@modelcontextprotocol/server` 2.0.0 都提供 web 标准 transport，任选其一；tool 输入 schema 用
  zod（server 目前无 zod 依赖，新增即可）。
  Based on: `npm view` 2026-09-05：sdk 1.30.0、server 2.0.0、zod 4.5.4；`apps/server/package.json`
  dependencies 无 zod。

- **只读 tools 直接复用中心既有的账号读法，不新增存储或协议面**：设备用 hub 的
  `daemonInfoList`（含在线状态与版本）、项目/工作区/任务用 `store.listProjects/listWorkspaces/listTasks`、
  端口用 `routeTable` + `buildPreviewUrl`、终端内容用 `store.getSessionCheckpointByTask`。
  `read_terminal` 在**服务端**去 ANSI（checkpoint 本身语义不动，它同时是 web 的数据源）、取尾
  N 行、去尾部空行，默认 200 行。
  Rejected: 经 daemon 读命令日志——那是 091 的 server→daemon 消息面；本片不碰 daemon。
  Based on: `apps/server/src/hub.ts:2186-2216`（clientSubscribe 组 stateSnapshot 的同一组读法）；
  `store.ts:416,619,676,709,1095`；`apps/server/src/proxy.ts:75` `buildPreviewUrl`；
  `packages/cli/cofluxd.mjs` 的 `stripAnsi`/`tailLines` 可作同构参考（CLI 侧实现，不可直接 import）。

- **新增中心公网 URL 配置，issuer / PRM / 元数据里的 URL 全部由它拼**：不从请求 `Host`/
  `X-Forwarded-*` 推导。dev 默认 `http://127.0.0.1:<port>`，生产设为 `https://api.coflux.dev`。
  Rejected: 从请求头推导——生产前面压着两层反代（owo-jp-gw → prod-jp Caddy），头部可伪造且
  各层不一致。
  Based on: `apps/server/src/config.ts:96-97`（只有 `webUrl`，没有中心自身地址）；
  `docs/deployment.md` 拓扑。

- **新表走版本化迁移，不改冻结的 baseline**：`schema-migrations.ts` 的 `MIGRATIONS` 数组追加
  version 4；`initialSchemaSql` 是 ledger 校验用的冻结定义，一个字都不能动。
  Based on: `apps/server/src/infra/database/schema-migrations.ts:1177-1207`（版本 1-3 形状）、
  `:159-176`（冻结 baseline 含 client_tokens）。

- **测试是黑盒：用 fetch 直接打 OAuth 与 MCP 端点（JSON-RPC over HTTP），确认页那一跳用测试
  WS Client 发同款消息**：不 import 应用代码，与 harness 哲学一致；负向用例必做。
  Based on: `AGENTS.md`「测试 harness」节；`tests/src/harness.mjs:509-570`（`startServer`
  的 `opts.env` 透传给 server 进程——公网 URL env 从这里注入）。

- **前端展示不做 Claude 验证**（仓库惯例）：确认页视觉交用户人工验收；类型检查与构建照跑。

## Direction

```
Claude Code/Codex ──HTTP──▶ api.coflux.dev
   │  POST /mcp (无 token)        → 401 + WWW-Authenticate: resource_metadata
   │  GET  /.well-known/oauth-protected-resource → { resource, authorization_servers:[issuer] }
   │  GET  /.well-known/oauth-authorization-server → 端点清单、code_challenge_methods:[S256]、DCR 端点
   │  POST /oauth/register (DCR)  → client_id（持久化）
   │  GET  /oauth/authorize?…      → 记内存待确认请求 → 302 到 <webUrl>/<确认页>?<请求 id>
   │        浏览器：确认页独立 WS clientAuth → 查询请求信息 → 用户确认 → 服务端签授权码 → 回 redirect URL → 跳回宿主
   │  POST /oauth/token (code+PKCE / refresh) → access + refresh（hash 落库、轮换）
   └─ POST /mcp (Bearer) → 解析 principal → 每请求 McpServer → tools（只读，按 accountId 过滤）
```

### Milestone 1: 协议与存储就位

`client.proto` 新增确认页用的消息对（字段号 38 / 37），`buf generate` 三侧产物同步；
migration version 4 建 OAuth 客户端与 token 表；config 新增中心公网 URL；server 引入 MCP SDK
与 zod。
Validation: `cd proto && buf generate && git status --short proto packages/protocol/src/gen crates/protocol/src/gen packages/swift-client/Sources/CofluxProtocol/Generated` -> 只含本次新增消息的产物变化；
`node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0；
`cargo test -p coflux-protocol` -> exit 0。

### Milestone 2: OAuth 2.1 授权服务器

PRM 与 AS 元数据、DCR、authorize、token（授权码 + S256 PKCE、refresh 轮换）、`/mcp` 的 401
挑战全部可用；待确认请求与授权码在内存（TTL、一次性、有上限）；hub 处理确认页的两条新消息
并签发授权码。所有失败路径按 OAuth 错误格式回 4xx JSON（`invalid_request` /
`invalid_client` / `invalid_grant` / `unauthorized_client` …），不经 Raven 错误信封。
Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0。

### Milestone 3: `/mcp` 端点 + 六个只读 tools

POST/GET/DELETE 三个 method 挂上；bearer → principal；每请求 McpServer；`initialize` /
`tools/list` / `tools/call` 通；六个 tools 按 Requirement 列表返回账号内数据；`read_terminal`
去 ANSI 尾 N 行。
Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0。

### Milestone 4: web 确认页

新页面（登录态复用、显示客户端名与回调 host、确认/拒绝、成功后跳转、失败与过期态可读），
`App.tsx` 按 pathname 接入；页面 WS 必须带 `clientVersion`。
Validation: `node_modules/.bin/tsc -b apps/web/tsconfig.json` -> exit 0；`pnpm -C apps/web build` -> exit 0。

### Milestone 5: 黑盒验收 + 文档

新测试文件（独占端口，从 8866 起）覆盖：完整授权码流程（DCR → authorize 302 → 测试 WS Client
登录并确认 → 换 token → `/mcp` initialize/tools/list → 六个 tools 各至少一条正向断言，其中
`list_devices` 看到在线 daemon、`read_terminal` 读到真实终端输出）；负向：无 token 401 且
`WWW-Authenticate` 含 `resource_metadata`；PKCE verifier 不符被拒；授权码二次使用被拒；refresh
轮换后旧 refresh 被拒；**跨账号隔离**（password 模式下第二个账号的 token 看不到第一个账号的
任何资产，且用第一个账号的资产 id 调 tools 得到明确错误）；非 loopback 且未注册的 redirect_uri
被拒；拒绝授权时回调带 `error=access_denied`。新用例做过负向验证（抽掉对应 handler 后确实失败）。
文档：`docs/auth-design.md` 新增「OAuth 客户端（MCP）」节；`docs/deployment.md` 与 README env 表
登记新 env；`plans/README.md` 状态。
Validation: `node --import tsx --test tests/src/<新文件>.test.mjs` -> exit 0（acceptance，见 Commands）。

## Landmines

- **Raven 预解析 JSON body**（`@raven.js/core/dist/index.mjs:432-441`）：`/mcp` POST 的 body
  到 handler 时已被消费，只能从 Raven 的 body 状态取；SDK 的 `handleRequest` 有 `parsedBody`
  选项正是为此。token 端点是 `application/x-www-form-urlencoded`，Raven 不碰，handler 自己
  `request.formData()`。写 Raven 路由前先加载 `raven-use` skill（本机已装）。
- **Raven 错误信封**（`index.mjs:534-542`）：throw 出去的错误会变成 Raven 的 JSON 格式，OAuth
  客户端与 MCP 宿主都不认；每条失败路径自己构造 Response。
- **确认页的 WS 必须带 `clientVersion`**（plan 033 版本准入）：`AuthorizePage.tsx:41-43` 的注释记着
  2026-07-24 的生产事故——漏了会被当旧 bundle 拒掉。
- **web 与 server 必须同批部署**：新消息 + 版本准入（build-id 自举，plan 033）意味着旧 web 配新
  server 会被踢；生产上线顺序按 `docs/deployment.md`。
- **冻结的 baseline 不能改**（`schema-migrations.ts:158-176` 的 `initialSchemaSql` 是 ledger 校验用定义）；新表只能是
  version 4。`CORE_PREFLIGHT_CHECKS`/`CORE_INTEGRITY_SQL`（`:396`、`:619`）是版本 3 的一部分，
  新表的归属约束写在自己的迁移里。
- **checkpoint 是 2 秒周期缓存，秒级命令进不去**（`tests/src/agent-control.test.mjs` 头注释）：
  `read_terminal` 的黑盒用例要跑一条活得够久或会留下输出的命令，别用 `echo` 之类秒退的；tool
  描述里要写明「最多约 2 秒延迟、刚建的终端可能为空」。091 会换成经 daemon 读。
- **Claude Code 对远程 HTTP MCP 单次请求默认 60 秒超时，输出超 25k token 截断**：本片没有等待
  类 tool，但 `read_terminal` 默认行数与上限要有界（对齐 CLI 的 200 行默认）。
- **harness 的 server 进程 env 只从 `startServer(opts.env)` 透传**（`harness.mjs:527-537`）：测试
  里的公网 URL 必须设成 `http://127.0.0.1:<port>`，否则元数据里的端点指向不存在的地址。
- **`startStack` 默认起一套 relay 与 daemon**：本片用不到 daemon 的地方用 `startServer` 更轻；
  `list_devices`/`read_terminal` 的正向断言要 `startStack`。各测试文件顶部 `const PORT` 独占端口。
- **password 模式才有第二个账号**：跨账号隔离用例要以 `COFLUX_AUTH=password` 起 server 并造两个
  用户（`tests/src/password.test.mjs` 有现成造法）。
- `apps/mobile` 已冻结但共享 `packages/protocol`：proto 变更后 `pnpm -C apps/mobile build` 必须仍过
  （store 对未知分支有 `default`，正常不需改它）。
- 生产前置反代 owo-jp-gw 的 Caddy 压着其他站（`docs/deployment.md`）：上线前核对 api 站块没有别的
  `.well-known` handle（HTTP-01 只占 `acme-challenge`），回源必须带 `tls_server_name`。SSE 默认即时
  flush，实测卡住再谈 `flush_interval`。这些是上线检查项，不是代码改动。

## Scope

In scope:
- `proto/coflux/v1/client.proto` + 三侧生成产物（`packages/protocol/src/gen`、`crates/protocol/src/gen`、`packages/swift-client/Sources/CofluxProtocol/Generated`）
- `apps/server/src/**`（新增 OAuth/MCP 模块与路由、config、store、schema 迁移、hub 的确认消息处理、只读 tool 实现）
- `apps/server/package.json`、`pnpm-lock.yaml`（MCP SDK、zod）
- `apps/web/src/App.tsx`、`apps/web/src/pages/`（新确认页）、如需复用则 `apps/web/src/components/auth/`
- `tests/src/`（新用例；`harness.mjs` 仅在需要通用辅助时最小改动）
- `docs/auth-design.md`、`docs/deployment.md`、`README.md`（env 表）、`plans/README.md`

Out of scope:
- `crates/worker/**`、`crates/supervisor/**` —— 本片零 daemon 改动（Rust 生成产物随 buf 变化除外）
- 写操作 tools、server→daemon 新消息、经 daemon 读终端 —— plan 091
- `COFLUX_*` 环境变量注入、`packages/cli/**`、SKILL.md —— plan 092 / 不动
- `packages/client/src/**` —— 不需要改（默认分支兜底）；若构建因生成类型变化而破，做最小修复并在报告里说明
- `apps/mobile`（冻结，只需构建通过）、`apps/ios`
- 已授权应用列表 / 单个撤销 UI、CIMD 之外的注册方式、token 内省/撤销端点 —— 后续
- MCP resources / prompts —— 不做

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| server 类型检查 | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| web 类型检查 | `node_modules/.bin/tsc -b apps/web/tsconfig.json` | exit 0 |
| web 构建 | `pnpm -C apps/web build` | exit 0 |
| mobile 构建（冻结端不破） | `pnpm -C apps/mobile build` | exit 0 |
| proto 再生成 | `cd proto && buf generate` | 产物只含预期变化 |
| Rust 协议单测 | `cargo test -p coflux-protocol` | exit 0 |
| Rust 构建（产物变化不破 daemon） | `cargo build -p coflux-supervisor -p coflux-worker -p coflux-relay` | exit 0，零警告 |
| client 包单测 | `node --import tsx --test packages/client/src/*.test.ts` | exit 0 |
| 本片黑盒 (acceptance) | `node --import tsx --test tests/src/<新文件>.test.mjs` | exit 0 |
| 全量黑盒 (acceptance) | `pnpm -C tests test` | 除既有 `cli-doctor` 基线失败外全过 |
| 真宿主接入 (acceptance，用户人工) | 本机 dev server + `claude mcp add --transport http coflux http://127.0.0.1:8787/mcp`，在 `/mcp` 里完成授权后 `list_devices` 有结果 | 授权一次即可用 |

黑盒测试需要本机 Postgres（`pnpm dev:pg`）与已构建的 daemon 二进制（`pretest` 自动 cargo build）；
全套大面积超时先查 Docker 是否半死。web 确认页视觉交用户人工验收。

## Done criteria

- [ ] All listed commands pass.
- [ ] Claude Code 一行接入 → 401 → 浏览器确认 → 换 token → tools 可用，全程无需用户手工粘贴任何令牌。
- [ ] 六个只读 tools 只返回调用者账号的数据；跨账号用例证明隔离。
- [ ] PKCE 校验、授权码一次性、refresh 轮换、redirect_uri 校验各有负向用例且抽掉对应逻辑后确实失败。
- [ ] `/mcp` 无 token 时 401 且 `WWW-Authenticate` 带可解析的 `resource_metadata`；元数据端点可被 Claude Code 的发现流程消费。
- [ ] 凭证表只存 hash；`client_tokens` 表与 web 登录/登出行为零变化。
- [ ] `crates/**` 除生成产物外零改动；`cofluxd` 与 web 侧栏行为零变化。
- [ ] Required tests exist and assert meaningful behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Raven 的 contract 路由无法承载 MCP transport（例如无法交出预解析 body、或无法返回流式
  `text/event-stream` Response）——STOP 报告，不要自行改成旁路 `index.ts`（那是决策变更）。
- 选定的 MCP SDK 的 web 标准 transport 不接受预解析 body 且 Raven 无法关闭 JSON 预解析——STOP。
- `ClientToServer` 38 / `ServerToClient` 37 已被占用（并发改动撞号）。
- 实现需要改动 `crates/worker`/`crates/supervisor` 的源码，或需要新的 server→daemon 消息。
- 某条 Decisions 引用的事实已不成立。
- 任一验证命令在一次合理修复后仍连续失败两次。

## Maintenance notes

- **plan 074 的「AI 零凭证」决策与 STOP 条件「需要给 AI 发放账号级凭证」被本 plan 正式推翻**
  （用户 2026-09-05）：账号级能力经 OAuth 签发的独立凭证提供；`cofluxd` 本地 pid 路径的零凭证
  边界原样保留，两者并存。以后评估 agent 能力时，先分清走的是哪条身份。
- 本片 `read_terminal` 基于 2 秒周期 checkpoint 是过渡实现，091 改为经 daemon 读命令日志优先；
  别在本片的基础上给 checkpoint 加语义。
- token 有效期与内存 map 上限是调参项，改之前看 Decisions 第 3/4 条的理由；撤销 UI（已授权
  应用列表）是独立议题，届时按 client_id 维度做。
- 生产上线清单：prod-jp 的 server env 加公网 URL；server 与 web 同批部署（版本准入）；上线后用
  真 Claude Code 走一遍授权；owo-jp-gw 的 Caddy api 站块核对 `.well-known`。
- 091 会在 hub 里加「完成原语」与 prepared operation 的 `initiator: server` 标记，本片的 tool 层
  应把 principal 与 hub/store 读法之间的边界留干净，别把 Request 对象或 Raven 上下文渗进 tool 实现。
