# Plan 035: cofluxd 命令面重梳 + doctor 连通性自检

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat <planned-sha>..HEAD -- packages/cli/cofluxd.mjs README.md tests/src/`
> （planned-sha 在 plan 034 完成后回填；本 plan 依赖 034 的 CLI 现场。）

## Status

- Priority: P2
- Effort: M
- Risk: LOW
- Depends on: plans/033-worker-connection-resilience.md（DONE）、plans/034-remove-enroll-key.md
- Category: dx
- Execution: subagent sonnet
- Planned at: 034 完成后回填 sha，2026-07-23

## Requirement

cofluxd 是产品最早期的部件，命令面（onboard/up/reload/update/status/fda/
logs/down/uninstall 九命令）与现在的用法脱节（用户拍板重设计，2026-07-23）：

- onboard 的交互问答在 enrollKey 删除（plan 034）后只剩"问设备名"，价值
  不足以撑一个命令；零参数 `up` + 浏览器授权已是最优引导。
- reload 与 up 职责重叠：up 本就读取并落盘配置、装服务、重启。
- 出问题（如 2026-07-23 半死连接事故）时用户没有自助诊断路径，只能裸看
  logs；需要 tailscale netcheck 式的分层自检。

完成后为真（八命令，类 Tailscale 心智模型）：

1. `cofluxd up` 幂等：首次=装+起+等浏览器授权；已装=按当前 settings.json
   重装服务并重启（吸收 reload 语义）。`cofluxd onboard`、`cofluxd reload`
   不再存在；裸跑 `cofluxd` 首次进 up，已配置进 status。
2. `cofluxd doctor` 对 settings 里的 server_url 做分层连通性探测：DNS 解析
   → TCP 连接 → TLS 握手（wss 时）→ WS 升级握手，逐层报告成功/失败与耗时，
   失败层给出明确指向（如"DNS 可解析但 TCP 连不上——防火墙/代理拦截"）；
   并汇总本地事实（服务进程存活、conn-state.json 连接态、凭证有无、FDA）。
3. `cofluxd update` 帮助与输出文案讲清：它只更新 supervisor 二进制，worker
   由 server 自动热升级（plan 017 之后的现实）。
4. README 用户侧文档与新命令面一致。

## Decisions & tradeoffs

- **命令面：`up/down/status/doctor/logs/update/fda/uninstall` 八命令**，
  砍 onboard 与 reload。用户已确认（dev-explore 2026-07-23，departure check
  通过）。Rejected: 保留 reload（up 幂等化后语义重复）；把 update 也并入
  up（用户未选，update 保留独立命令）。
- **up 幂等化的语义**：无论首次与否，up = 确保二进制存在（不重复下载已有
  版本，除非显式 `--version`/`--bin-dir`）+ 落盘配置 + 安装/刷新服务定义 +
  重启服务。已登记设备重跑 up 不得触发重新授权（credentials.json 保留）。
  Based on: 现有 `applyAndStart`（`packages/cli/cofluxd.mjs:172-191`）已接近
  此语义，主要差异是每次 up 都重新下载 latest——幂等化后"二进制已存在且未
  显式要求版本"时跳过下载，避免重跑 up 变成隐式升级。
- **doctor 在 CLI 内直接探测，不违反"CLI 零协议"原则**。零协议指不实现业务
  线协议（`cofluxd.mjs:194` 的约定针对登记/状态数据面）；doctor 只做传输层
  连通性探测（node 内置 `dns/net/tls` + 手写 HTTP 101 升级请求），不解析任何
  coflux 协议消息，探测成功即断开。WS 升级探测对 server 是一条未认证连接，
  server 侧 authDeadline（15s）自然回收，无副作用。Rejected: doctor 经
  daemon 代跑——daemon 恰恰可能是坏的那环。
- **doctor 的探测目标从 settings.json 读 serverUrl**，未配置时用默认公共
  服务地址。超时每层独立（建议 5s，执行者可调），全层通过但 conn-state 仍
  非 connected 时提示查 `cofluxd logs`（问题在认证/授权层而非网络层）。
- **不为 CLI 引入测试框架**。doctor 的探测函数与命令面改动以
  `node --check` + 编排方实操验收（对生产 api.coflux.dev 跑 doctor、跑
  status/up/down 生命周期）为准。现有黑盒测试不覆盖 cofluxd.mjs，本 plan
  维持该现状；若执行者认为某探测函数值得测，可在 `tests/src/` 加轻量用例，
  但不是必须。Rejected: 为 CLI 建测试体系——ponytail，收益不成比例。
- **README 同步更新**：安装/使用段落反映八命令与浏览器授权单一路径
  （`README.md:26-33` 现文案含 onboard 与 enroll-key，均已过时）。

## Direction

全部改动集中在 `packages/cli/cofluxd.mjs`（单文件 CLI，保持零依赖 node）
与 `README.md`。保持现有代码风格：中文注释/输出、`die`/`run` 工具函数、
零 npm 依赖。

### Milestone 1: 命令面重梳

onboard/reload 移除（未知命令报错提示新命令面）、up 幂等化、裸跑分派更新、
HELP 文案重写、update 文案澄清。
Validation: `node --check packages/cli/cofluxd.mjs` → exit 0。

### Milestone 2: doctor

分层探测 + 本地事实汇总 + 结论输出。
Validation: `node --check packages/cli/cofluxd.mjs` → exit 0；
`cofluxd doctor` 实操输出正确分层（acceptance，编排方跑）。

### Milestone 3: README 更新

用户侧文档与新命令面一致。Validation: 人工比对（编排方）。

## Landmines

- `cmdStatus` 被 up 流程复用（`cofluxd.mjs:185,203`），且 plan 033 刚给它
  加了 conn-state 展示——重梳时保持其同步函数性质与既有输出。
- `waitForAuthorization`（`cofluxd.mjs:195-217`）依赖 daemon 落盘的
  pending-auth.json 轮询——up 幂等化后"已登记设备重跑 up"不得进入此等待
  （判定条件是 credentials.json 存在与否，plan 034 后 enrollKey 条件已删）。
- macOS `launchctl unload/load` 与 Linux `systemctl --user` 的差异已封装在
  `installService/restartService/stopService`（`cofluxd.mjs:150-170`）——
  doctor/up 改动不要绕过这层。
- npm 包发布形态：`packages/cli` 是发布到 npm 的用户入口，命令面变化对存量
  用户是破坏性变更（`cofluxd onboard` 将报未知命令）——HELP 与报错信息要
  给出迁移指引（"onboard 已并入 up，直接运行 cofluxd up"）。

## Scope

In scope:

- `packages/cli/cofluxd.mjs`
- `README.md`（用户侧安装/使用段落）
- `tests/src/`（可选的轻量探测函数用例）

Out of scope:

- `crates/`、`apps/`、`packages/{protocol,core,client}` —— 本 plan 纯 CLI 面
- npm 发包动作 —— 用户显式要求时另行处理
- `docs/auth-design.md` —— plan 034 已更新

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| CLI 语法检查 | `node --check packages/cli/cofluxd.mjs` | exit 0 |
| 黑盒测试无回归 | `COFLUX_TEST_PG_URL="postgres://postgres:postgres@127.0.0.1:54322/postgres" pnpm -C tests test` | exit 0 |
| doctor 实操 (acceptance) | `node packages/cli/cofluxd.mjs doctor` | 分层结果 + 结论，各层对生产 server 通过 |
| status 实操 (acceptance) | `node packages/cli/cofluxd.mjs status` | 含连接态行，无 onboard/reload 痕迹 |

## Done criteria

- [ ] All listed commands pass.
- [ ] 命令面为八命令；`onboard`/`reload` 报未知命令并给迁移指引。
- [ ] 已登记设备重跑 `up` 幂等（不重新授权、不隐式升级二进制）。
- [ ] `doctor` 分层探测输出与失败指向正确。
- [ ] README 与新命令面一致。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- plan 034 未 DONE（本 plan 假设 enrollKey 面已不存在）。

## Maintenance notes

- 命令面是 npm 用户入口的对外契约：后续增删命令视为破坏性变更，发版说明
  需体现。
- doctor 的层级顺序（DNS→TCP→TLS→WS）与失败指向文案是排障 UX 的核心，
  后续新增故障模式（如企业代理 MITM 证书）在对应层追加指向即可。
