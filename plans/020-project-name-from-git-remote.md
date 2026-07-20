# Plan 020: 从 Git remote 推导 project 名称

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 8cf04db..HEAD -- proto/coflux/v1/daemon.proto proto/gen/swift/coflux/v1/daemon.pb.swift packages/protocol/src/gen/coflux/v1/daemon_pb.ts crates/protocol/src/gen/coflux/v1/coflux.v1.rs crates/protocol/src/wire_tests.rs crates/worker/src/git.rs crates/worker/src/main.rs apps/server/src/hub.ts tests/src/lifecycle.test.mjs`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent
- Planned at: `8cf04db`, 2026-07-20

## Requirement

当前 project 导入时，Web 不传 `name`，server 因而直接取用户输入路径的最后一段；这既无法表达远端 namespace，也会在用户从仓库子目录发起导入时得到错误名称。完成后，未显式命名的 project 优先使用 Git remote 推导出的完整仓库标识，例如本仓库的 `https://github.com/myWsq/coflux.git` 应得到 `myWsq/coflux`。

最终优先级必须是：请求中非空的显式 `name` > `origin` 中可解析的仓库标识 > 其他 remote 中首个可解析的仓库标识 > Git 识别出的仓库根目录 basename。无 remote、remote URL 不受支持、老 worker 未返回新字段等情况均不得导致导入失败。

## Decisions & tradeoffs

- **显式名称保留最高优先级**：`projectImport.name` 经 trim 后非空即作为用户覆盖，不被 remote 替换。Rejected: remote 永远覆盖显式名称 —— 会破坏协议已有的手动命名能力。Based on: `proto/coflux/v1/client.proto:58-63` 已把 name 定义为 optional；`apps/server/src/hub.ts:725` 当前明确优先采用非空显式 name。
- **remote 优先级为 origin，再按 Git 返回顺序尝试其他 remote**：第一个成功解析的标识胜出；remote 名称本身不参与结果。Rejected: 只读 origin —— 对没有 origin 但有其他有效 remote 的仓库回退过早；upstream 优先 —— 不符合用户确认的日常 clone 语义。
- **保留完整 namespace 路径并移除末尾 `.git`**：GitHub `owner/repo.git` 得到 `owner/repo`；GitLab `group/subgroup/repo.git` 得到 `group/subgroup/repo`。Rejected: 只留末两段或首层加项目 —— 多层 namespace 会丢失身份信息。
- **remote 读取与名称推导发生在 worker，server 只执行优先级与持久化**：daemon 所在机器才拥有仓库和 Git 配置，worker 应仅回传推导后的名称候选，不把完整 remote URL 暴露给中心 server。Rejected: server 自行读取或解析 remote —— server 无法访问设备文件系统；把原始 URL 上传后再解析 —— 不必要地扩大敏感信息传输。Based on: `crates/worker/src/git.rs:53-71` 是现有仓库校验真相点，`crates/worker/src/main.rs:675-680` 将结果发回 server。
- **协议新增字段必须可选并保持滚动兼容**：新 server 收到老 worker 缺失的候选名称时回退仓库根目录；老 server 会忽略新 worker 的未知 protobuf 字段。Rejected: 把名称设为必填或缺失时报错 —— 会破坏 worker 热升级/版本错位期间的项目导入。Based on: `proto/coflux/v1/daemon.proto:45-52` 的 `ProjectValidated` 是 worker → server 边界；项目支持 worker 频繁热升级。
- **目录回退取校验后的仓库根目录**：从仓库子目录导入也使用 repo root basename。Rejected: 保持取原始输入路径 —— 当前 `apps/server/src/hub.ts:725` 会把子目录误当项目名，而 `crates/worker/src/git.rs:59-63` 已拿到 `git rev-parse --show-toplevel` 的根目录。
- **支持常见网络 remote 形态，解析失败即跳过**（decided while planning）：覆盖 HTTPS/HTTP/SSH/git URL 与 SCP-like `git@host:namespace/project.git`，保留多层路径；本地路径、`file:` remote、空路径或不能安全形成 namespace/project 的值视为不可解析并继续回退。Rejected: 为所有 Git 允许的奇异 remote 语法强行产出名称 —— 容易把本机绝对路径或凭据误当 project 名。

## Direction

协议真相源增加 worker 可选返回的 remote 仓库名称候选，并同步所有受版本控制的生成绑定。worker 在现有仓库校验期间读取 remote、按既定优先级解析候选；server 将显式 name 保留到异步校验完成，再按契约选择最终 project name。测试同时覆盖纯解析边界、protobuf 往返和真实进程黑盒导入行为。

### Milestone 1: 协议表达可选的 remote 名称候选

worker → server 的仓库校验结果能够携带可选候选名，TS、Rust、Swift 生成绑定与 proto 真相源一致，Rust wire round-trip 覆盖有值和缺失两种情况。

验证：`cd proto && buf lint && buf generate && git diff --exit-code -- ../packages/protocol/src/gen ../crates/protocol/src/gen gen/swift` -> exit 0；`cargo test -p coflux-protocol` -> exit 0。

### Milestone 2: worker 稳健推导 remote 仓库标识

有效仓库校验结果可按 origin 优先规则返回完整 namespace/project；缺失或不支持的 remote 不影响仓库校验成功。解析测试覆盖 HTTPS、SSH URL、SCP-like、多层 namespace、`.git`/末尾斜杠、无效及本地路径，并验证 remote 回退顺序。

验证：`cargo test -p coflux-worker` -> exit 0；`cargo build -p coflux-supervisor -p coflux-worker` -> exit 0 且零警告。

### Milestone 3: server 应用最终命名优先级并完成黑盒验收

server 以显式 name、worker 候选、规范 repo root basename 的顺序落库。真实 stack 导入带 origin 的仓库后观察到 namespace/project 名；显式 name 仍覆盖 remote；无有效 remote 时回退 repo root 目录名。

验证：`node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0；最终黑盒套件见 Commands 的 acceptance 项。

## Landmines

- `OpData` 当前把 project import 的名称定义为必填 `string`，并在发出 daemon 校验前就用输入路径确定（`apps/server/src/hub.ts:125-127,725-730`）；要保留“是否显式命名”的语义，不能继续把目录 fallback 提前混入同一字符串。
- `ProjectValidated` 是 protobuf 跨语言边界（`proto/coflux/v1/daemon.proto:45-52`）；按仓库纪律必须修改 proto 真相源并运行 `buf generate`，不能手改任一生成文件。CI 会用生成后零 diff 拦截漂移（`.github/workflows/ci.yml:39-51`）。
- remote URL 可能含用户名、token 或主机信息；日志、错误和协议中只允许出现解析后的 namespace/project，不得回传或打印原始 URL。
- Git 命令失败、remote 缺失或单个 remote 不可解析，都只是“没有候选名称”，不是“无效仓库”；不得改变现有 `rev-parse --show-toplevel` 成功判定。
- 黑盒 harness 会直接构建并运行 Rust supervisor/worker；测试必须使用临时仓库和本地 Git 配置，不访问外网，也不得依赖本机全局 Git remote。

## Scope

In scope:
- `proto/coflux/v1/daemon.proto`
- `proto/gen/swift/coflux/v1/daemon.pb.swift`
- `packages/protocol/src/gen/coflux/v1/daemon_pb.ts`
- `crates/protocol/src/gen/coflux/v1/coflux.v1.rs`
- `crates/protocol/src/wire_tests.rs`
- `crates/worker/src/git.rs`
- `crates/worker/src/main.rs`
- `apps/server/src/hub.ts`
- `tests/src/lifecycle.test.mjs`

Out of scope:
- `proto/coflux/v1/client.proto` 与 Web 导入 UI —— 已有 optional 显式 name，Web 无需新增输入框。
- project 重命名能力 —— 本需求只改变导入时默认名称。
- 已存在 project 的数据迁移或批量改名 —— 新规则只作用于之后的导入。
- 把 Git host 加入名称 —— 目标格式是 namespace/project，不是 host/namespace/project。

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Proto lint + codegen consistency | `cd proto && buf lint && buf generate && git diff --exit-code -- ../packages/protocol/src/gen ../crates/protocol/src/gen gen/swift` | exit 0 |
| Rust protocol tests | `cargo test -p coflux-protocol` | exit 0 |
| Worker unit tests | `cargo test -p coflux-worker` | exit 0 |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Daemon build | `cargo build -p coflux-supervisor -p coflux-worker` | exit 0，零警告 |
| Full black-box suite (acceptance) | `pnpm -C tests test` | exit 0；项目名称优先级由真实 server + Rust daemon 验收 |

## Done criteria

- [ ] 本仓库 remote `https://github.com/myWsq/coflux.git` 按同一解析规则得到 `myWsq/coflux`。
- [ ] 非空显式 name 覆盖所有 remote 候选。
- [ ] 未显式命名时，origin 优先；origin 缺失/不可解析后尝试其他 remote 的首个可解析值。
- [ ] GitLab 多层 namespace 完整保留，常见 HTTPS/SSH/SCP-like URL 均有测试。
- [ ] 无有效 remote 候选或老 worker 缺字段时，使用规范 repo root basename，项目导入仍成功。
- [ ] 原始 remote URL 不进入 worker → server 消息、日志或用户错误。
- [ ] proto 与三端生成绑定一致，相关单测、类型检查、构建和全量黑盒测试全部通过。
- [ ] 实现遵循 Decisions & tradeoffs 的每项约定，未改动 scope 外文件。
- [ ] `plans/README.md` 状态已更新。

## STOP conditions

- Decisions & tradeoffs 引用的协议或导入链路事实已不成立。
- 正确实现需要修改 scope 外文件。
- 需要把原始 remote URL 发送到 server 才能完成推导。
- 任一验证命令在一次合理修复后连续失败两次。

## Maintenance notes

- 将来若要显示 host，应新增独立字段或显示策略，不要改变这里的稳定 project name 语义。
- 新增 remote URL 形态时，应优先扩充 worker 的纯解析测试，并保持“解析失败只是回退”原则。
