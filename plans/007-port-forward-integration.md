# Plan 007: 端口转发集成验收 —— 黑盒 e2e + 文档

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 451f113..HEAD -- tests/src docs README.md`

## Status

- Priority: P2
- Effort: M
- Risk: LOW
- Depends on: plans/005-port-forward-daemon.md, plans/006-port-forward-server-web.md
- Category: tests
- Execution: subagent sonnet
- Planned at: `451f113`, 2026-07-10

## Requirement

用黑盒集成测试证明端口转发端到端可用(真实 Rust daemon + TS server,跨语言边界),
并把新能力写进文档。测试哲学沿用仓库既有约定:跨语言重构有效的黑盒验收
(`AGENTS.md`、`tests/src/harness.mjs`)。

必测行为(新测试文件,如 `tests/src/proxy.test.mjs`,独占端口):

1. **探测上报**:task PTY 内起一个 HTTP 服务(如 `node -e` 监听 127.0.0.1:0 并打印
   端口),client 在数秒内收到 `ports.updated`(含该端口与预览 URL);task 停止后
   收到撤销(空集)广播。PTY 之外(测试进程自己)起的端口绝不出现在上报里。
2. **门禁**:对代理 Host 发无 cookie 请求 → 302 且 Location 指向 web 授权路由;
   client 经 WS `proxy.issueAuth` 拿回调 URL → 请求回调 → 拿到 Set-Cookie 且 302 回
   原路径;带 cookie 请求 → 200 且 body 是被代理服务的响应。伪造 cookie / 第二账号
   的 cookie(supabase 模式或双账号可构造时;不可构造则伪造 token 即可)→ 不放行。
   `proxy.issueAuth` 传外部 redirect(如 `https://evil.com/`)→ 拒绝。
3. **透传语义**:代理一个 WebSocket echo 服务(PTY 内起),浏览器侧(测试用 ws
   client 带伪造 Host + cookie)可完成 upgrade 并 echo 往返——证明 HMR 类流量可用。
4. **生命周期**:杀 daemon(或断其连接)后,在途代理请求失败、路由撤销广播到达;
   daemon 重连 + 服务仍在 → 端口重新上报、URL 可再次打通(shortId 允许变化)。

文档:`docs/architecture.md`(数据面新增 kind=4 帧、ports/proxy 消息、反代与门禁
一节)、`README.md`(env 表加 `COFLUX_PROXY_HOST`;顺手把 §5「数据模型」等仍写
sqlite 的陈旧表述修为 Postgres,以代码为准)。

## Decisions & tradeoffs

- **验收全走黑盒 harness,不新增单元测试框架**:与仓库「跨语言黑盒」路线一致。
  Based on: `tests/src/harness.mjs` 默认拉起 Rust daemon(`AGENTS.md:47-50`)。
- **代理请求用伪造 Host 头直连 server 端口**:不依赖 DNS/证书,`Host:
  <shortId>.p.localhost` 即命中路由(006 的 dev 默认 proxyHost)。Rejected: 测试里
  配真域名 —— 黑盒测试必须自足。
- **PTY 内起服务用 node 单行脚本**:测试环境必有 node;端口用 0 随机绑定后从
  PTY 输出解析,避免与各测试文件的独占端口约定冲突。
  Based on: `tests/src` 各文件顶部 `const PORT` 独占端口约定(`AGENTS.md:57`)。
- **cookie/302 断言用原生 fetch(redirect: "manual")**:node ≥18 自带,无新依赖。

## Landmines

- 本机跑黑盒必须 `COFLUX_TEST_PG_URL` 指向 54322 直连口;5432 是 supavisor 会报
  tenant 错(仓库外部事实,记忆项 local-test-postgres)。
- 探测是 ~2s 周期扫描,断言要用轮询等待(harness 既有 wait 工具),忌固定 sleep。
- PTY 输出含 ANSI 转义,解析端口号要容忍控制序列(参考既有测试解析 scrollback
  的做法)。
- WS echo 测试的 ws client 需要在 headers 里自带 Cookie —— `ws` 包支持
  `options.headers`,tests 包已依赖 `ws`(如无则加 devDependency,属 in scope)。

## Scope

In scope:
- `tests/src/**`
- `docs/architecture.md`、`README.md`
- `tests/package.json`(仅测试依赖)

Out of scope:
- `apps/**`、`crates/**`、`packages/**` —— 功能代码;发现缺陷 STOP 上报给
  orchestrator 定位归属(005 或 006),不在本 plan 内打补丁

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 全量黑盒 (acceptance) | `COFLUX_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm -C tests test` | exit 0,新旧用例全绿 |
| Rust 单测 | `cargo test -p coflux-protocol -p coflux-worker` | exit 0 |
| TS 类型检查 | `pnpm exec tsc --noEmit -p apps/server && pnpm exec tsc --noEmit -p apps/web` | exit 0 |
| Linux 全套(可选) | `docker build -t coflux-test . && docker run --rm coflux-test` | exit 0(验证 /proc 探测路径) |

## Done criteria

- [ ] All listed commands pass.
- [ ] Requirement 1–4 的行为各有至少一个断言明确的测试。
- [ ] 非 PTY 子进程的端口不被上报有显式断言(安全边界回归防线)。
- [ ] 文档更新完成,sqlite 陈旧表述已修。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- 测试暴露 005/006 的功能缺陷(修复归属功能 plan,本 plan 不改功能代码)。
- A validation command fails twice after one reasonable fix.
- The outcome requires out-of-scope files.

## Maintenance notes

Linux 探测路径(/proc)在 macOS 本机跑不到,Docker 全套是它唯一的自动化验证面;
CI 若日后建立,应包含 docker run 这条。生产部署清单见 plan 006 Maintenance notes。
