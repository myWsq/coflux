# Plan 115: coflux 终端里的 claude 自动带上 coflux 插件——Coflux.app 经 LaunchAgent 注入 `COFLUX_CLAUDE_PLUGIN_DIR`，supervisor 注入 shell 集成把它翻译成 `--plugin-dir`

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 7deedfb..HEAD -- crates/supervisor apps/desktop/scripts/stage-daemon.mjs apps/desktop/src/main/daemon-files.ts apps/desktop/src/main/daemon-paths.ts apps/desktop/src/main/daemon-manager.ts apps/desktop/src/main/daemon-bundle.ts apps/desktop/electron-builder.yml apps/desktop/test/config.test.ts tests/src/session-env-injection.test.mjs integrations/claude-plugin/README.md crates/worker/src/agents.rs`

## Status

- Priority: P1
- Effort: M
- Risk: MED（接管 coflux 终端的 shell 启动链：用户 rc 里的怪写法可能撞上；桌面侧只是多一个 plist 键与一个资源目录）
- Depends on: none（消费 plan 112 的会话环境注入与 plan 113 的桌面内置 daemon，两者已在 main）
- Category: feature
- Execution: subagent（宿主通用子 agent，`model: opus`；出发检查 2026-09-11 在 dev:explore 记录：写完 plan 直接执行到完、中途不再确认；push / PR / 合 main / 发版仍需用户明确要求）
- Planned at: `7deedfb`, 2026-09-11

## Requirement

今天要让 coflux 终端里的 Claude Code 有 coflux 能力（hooks 上报回合状态、SessionStart 注入 `<coflux-session>` 坐标块、
coflux skill、中心 MCP），用户必须自己 `/plugin marketplace add myWsq/plugins` 再装 `coflux@plugins`，升级也要手动
`/plugin marketplace update`。用户原话：「能不能劫持所有在 coflux 内运行的 claude，自动把插件注册进来，这样就不用用户
自己去安装插件了」。

完成后：在 coflux 开出来的终端里敲 `claude`，起来的 Claude Code 就带着 Coflux.app 内置的那份 coflux 插件——hooks、
`.mcp.json` 里的 coflux MCP、coflux skill 全部生效，`/hooks` 里能看到，`/plugin` 里看不到（`--plugin-dir` 是会话级加载，
不是安装）。插件随 Coflux.app 更新而更新；用户目录 `~/.claude` 一个字节不动，`~/.coflux` 里不落插件文件。已经装了市场版
`coflux@plugins` 的用户什么都不用做：同名插件经 `--plugin-dir` 加载时完全压掉市场那份，hook 不双发。

### 产品结论（探索阶段已确认，勿再问）

1. **消费者与范围**：在 coflux 开出的终端（桌面端、agent 的 `cofluxd terminal new`、iOS、中心 MCP 开的都算）里手敲
   `claude` 的人。用户自己的 iTerm / VS Code 终端不受影响。
2. **零动作**：没有任何设置页、开关、引导。装了 Coflux.app 并接入本机（plan 113 引导）之后，下一次 daemon 启动起的终端
   就带插件。
3. **退化行为**：约定的环境变量缺失、为空、或指向的目录不存在时，`claude` 的行为与今天完全一致（不带 flag、无提示、无报错）。
   这同时就是逃生口：想关掉就让变量为空。
4. **非目标**：Codex（它没有 `--plugin-dir` 等价物，仍走市场安装）；agent 用 Bash 工具起的 `claude -p` 子进程不保证带插件
   （非交互 shell 不加载 rc 链）；Linux / npm 线不做（npm 版 `cofluxd` 不写这个变量；Linux 用户可自行在 systemd unit
   里设同一变量指向任意插件目录，supervisor 侧的 shell 集成对它同样生效）；自托管中心的 MCP 地址（`.mcp.json` 仍写死
   `https://api.coflux.dev/mcp`，与市场版同一局限）。
5. **验收（用户人工，前端与真机不由 Claude 走查）**：升级 app 并重启 daemon 后，新开 coflux 终端敲 `claude`：SessionStart
   打出 `<coflux-session>` 块、侧栏回合状态随对话亮、`/mcp` 列表里有 coflux、`/hooks` 里有 coflux 插件的条目；
   `echo $COFLUX_CLAUDE_PLUGIN_DIR` 指向 `Coflux.app/Contents/Resources/daemon/claude-plugin`；把变量清空后开的终端里
   `claude` 与今天一样。

## Decisions & tradeoffs

- **加载入口是 `claude --plugin-dir <dir>`，不写任何 Claude 配置文件**。Rejected: 往 `~/.claude/settings.json` 写
  `extraKnownMarketplaces` + `enabledPlugins`——机器级持久改动、覆盖非 coflux 终端、要改用户的文件，且本地目录市场能否免
  提示自动装文档没说死；`CLAUDE_CODE_PLUGIN_SEED_DIR`——只是预置缓存，仍要 `enabledPlugins`。
  Based on: Claude Code 官方文档 plugins.md「Test your plugins locally」与 plugins-reference.md：`--plugin-dir` 仅本会话、
  不弹信任、加载 hooks/.mcp.json/skills 全部组件、flag 可重复、同名时「the local copy takes precedence for that session」；
  env-vars 全文没有等价环境变量（2026-09-11 经 claude-code-guide 核过）。
- **契约只有一个环境变量名 `COFLUX_CLAUDE_PLUGIN_DIR`，不约定任何路径**。值由注入方决定；daemon 不解析、不校验、不落盘它。
  Rejected: supervisor 自己算 `<COFLUX_HOME>/claude-plugin/current` 之类固定路径——用户明确要求「约定同一个变量名，
  不约定同一个地址」。Based on: `crates/supervisor/src/sessions.rs:826-828` 起会话时把 supervisor 自身全部环境变量拷进
  会话，变量不需要任何新代码就到达 shell。
- **注入方是 Coflux.app，载体是它本来就在写的 LaunchAgent plist**：`EnvironmentVariables` 里在 `COFLUX_HOME` 之外多一个
  `COFLUX_CLAUDE_PLUGIN_DIR`，值 = 当前 app 包内 `Contents/Resources/daemon/claude-plugin` 的绝对路径。Rejected:
  每次 app 启动把插件拷到 `~/.coflux`——用户明确拒绝「每次启动改用户目录」；桌面端建终端请求里带路径——agent / iOS /
  MCP 开的终端不经桌面端，覆盖不全。Based on: `apps/desktop/src/main/daemon-files.ts` `launchAgentPlist` 已写
  `EnvironmentVariables.COFLUX_HOME`；`apps/desktop/src/main/daemon-manager.ts:220` `writePlist` 在 `enroll`（:267）里
  调用；plan 113 定的 daemon 由 launchd 托管而非 app 直接 fork，所以 app 给 daemon 环境只有 plist 这一条路。
- **plist 什么时候写（decided while planning）**：除接入流程外，app 启动时若渲染出的 plist 内容与磁盘上的不同（例如 npm
  接入的机器、或旧版 app 写的没有这个键、或 app 换了位置），只重写文件，**不调 launchctl、不重启 daemon**；变量在下一次
  supervisor 启动（用户在面板点「重启」、开机、或 plan 113 的「重启并更新」）时生效。Rejected: 写完立即 reload——会结束
  本机所有终端，与 plan 113「从不自动重启」矛盾。Based on: launchd 只在 load 时读 plist；plan 113 产品结论 4。
  执行者自定比较方式；同构测试 `apps/desktop/src/main/daemon-files.test.ts:37`「与 cofluxd.mjs 的 plistXml 逐字同构」
  要改口为「= npm 版 + 一个 `COFLUX_CLAUDE_PLUGIN_DIR` 键」，npm 版 `packages/cli/cofluxd.mjs` 的 `plistXml` 不动
  （npm 线不做）。「已接入」判定（`daemon-state.ts:30` 只看 plist 与两个二进制存在）不变，两边仍可互换。
- **插件目录是 app 资源，与 `integrations/claude-plugin` 逐字节一致**：`apps/desktop/scripts/stage-daemon.mjs` 把该目录整体
  拷到 `build/daemon/claude-plugin/`（`.claude-plugin/`、`hooks/`、`scripts/`、`skills/`、`.mcp.json`、`README.md`、
  `LICENSE` 全带，不做任何改写），随现有 `extraResources: build/daemon → daemon` 进 `Contents/Resources/daemon/`。
  不进 `mac.binaries`（node/sh 脚本不是 Mach-O，不需要也不能按二进制签名）。Rejected: stage 时把 `.mcp.json` 的 URL 改成
  `${COFLUX_MCP_URL}`——产生第二份插件变体，本片不解自托管问题。Based on: `apps/desktop/electron-builder.yml:41-55`；
  `apps/desktop/test/config.test.ts:67-82` 守着 stage 脚本、`daemon-paths.ts` 常量与 builder 配置三处一致，新增目录名要
  同步进去；插件目录须全英文（`perl -ne 'print if /\p{Han}/'` 扫零命中，`tests/src/claude-plugin-session-context.test.mjs`
  已守）。
- **flag 由 supervisor 注入的 shell 集成翻译，不是 PATH 垫片、不是别名**。做法与 VS Code shell integration 同款：
  supervisor 起会话 shell 时按 shell 的 basename 分派——zsh 设 `ZDOTDIR` 指向 supervisor 自带的 rc 目录，其
  `.zshenv` / `.zprofile` / `.zshrc` / `.zlogin` 各自先 source 用户原来那份（尊重用户已设的 `ZDOTDIR`，否则 `$HOME`），
  bash 用 `--init-file`（自行按 bash 今天的加载顺序 source `/etc/profile`、`~/.bash_profile` 等），fish 经
  `XDG_DATA_DIRS` 的 `fish/vendor_conf.d`；不认识的 shell（含黑盒里 `COFLUX_SHELL` 指向的包装脚本）静默不注入。
  注入的末尾定义 `claude()` 函数：`COFLUX_CLAUDE_PLUGIN_DIR` 非空且是目录 → `command claude --plugin-dir
  "$COFLUX_CLAUDE_PLUGIN_DIR" "$@"`；否则 `command claude "$@"`。用户自己传的参数原样保留，flag 可重复不冲突。
  Rejected: 往 `<COFLUX_HOME>/bin` 放一个 `claude` 垫片——用户本机 `~/.zshrc:4` 与 `~/.zprofile:12` 都把 `~/.local/bin`
  （真 claude 所在）重新前置，垫片必被遮住；替换 `~/.local/bin/claude`——Claude 文档明确不建议（进入 externally managed
  状态，自动更新与清理停摆）。Based on: `crates/supervisor/src/main.rs:110-114`（shell 取值：`COFLUX_SHELL` →
  settings.shell → `$SHELL` → `/bin/bash`）；`sessions.rs:815-825`（`CommandBuilder::new(&shell)` 不带参数起 shell）。
- **不变量：今天的 rc 链语义不变**。注入前 shell 会加载哪些文件、什么顺序，注入后必须仍然加载、同样顺序，只是末尾多一个
  函数定义；用户 rc 出错也和今天一样只是它自己出错。执行者从 live code 确认今天起的是登录还是非登录 shell 并保持。
- **不变量：函数必须以 `command claude` 直接执行真 claude，不得改成常驻包装进程**。Based on:
  `crates/worker/src/agents.rs:16` worker 认 agent 靠进程树里进程名 / argv basename 命中 `claude`，函数只是 shell 内的
  转发，进程树不变。
- **rc 文件的落位（decided while planning）**：rc 内容随 supervisor 二进制走（`include_str!` 即可，不加依赖），启动时写到
  `<COFLUX_HOME>/shell-integration/` 下（幂等覆盖，daemon 自己的目录，与 `supervisor-version`、`fda-status` 同类）。
  Rejected: 每会话写临时目录——多余；写到 app 包内——supervisor 不知道 app 在哪，Linux 也没有 app。
- **app 更新原地替换包内插件，不做版本目录**。跑着的 claude 会话下一次 hook 触发时从 `CLAUDE_PLUGIN_ROOT` 读到新脚本，
  与市场版更新时的行为一致，判为可接受。
- **`claude` 已是用户 alias / 函数时的处理**：执行者的判断，但底线是不能让用户原来的定义静默失效——要么包住它，要么
  让位并在 plan 的 Maintenance notes 记下取舍。

## Direction

两个里程碑的文件集合不相交（M1 只碰 `crates/supervisor` 与黑盒 `tests/src`，M2 只碰 `apps/desktop` 与插件 README），
M2 不依赖 M1 的产物：可以并行成两个工作包。M3 是文档与索引收尾，依赖 M1、M2 完成。

### Milestone 1: supervisor 注入 shell 集成，`claude()` 函数按环境变量决定是否追加 `--plugin-dir`

完成后：用 zsh / bash / fish 起的 coflux 会话里 `type claude` 显示函数；`COFLUX_CLAUDE_PLUGIN_DIR` 指向存在的目录时
`claude …` 实际执行 `claude --plugin-dir <dir> …`，变量空或目录不存在时执行 `claude …`；用户原 rc 链一个不少、顺序不变；
不认识的 shell 与今天完全一样。单元测试覆盖：shell 分派（basename 判定、包装脚本不注入）、rc 内容里对用户原文件的转发
（含用户已设 `ZDOTDIR` 的情况）、函数在真实 `/bin/zsh -c` / `bash` 下用假 `claude`（记录 argv 的脚本放在临时 PATH 首段）
验证三种分支。黑盒：在 `tests/src/session-env-injection.test.mjs` 加一条——daemon 环境带 `COFLUX_CLAUDE_PLUGIN_DIR`，
`COFLUX_SHELL` 指向真实 `/bin/zsh`（不是现有的包装脚本，否则判成未知 shell），会话里敲 `claude` 命中临时 PATH 里记录 argv
的假 claude，断言含 `--plugin-dir <dir>`；再开一个变量为空的会话断言不含。
Validation: `cargo test -p coflux-supervisor` -> exit 0；`cargo build -p coflux-supervisor` 零警告。

### Milestone 2: Coflux.app 打包插件目录并经 plist 注入变量

完成后：`stage-daemon.mjs` 输出的 `build/daemon/` 多一个 `claude-plugin/` 子目录，内容与 `integrations/claude-plugin`
`diff -r` 为空（stage 脚本从仓库内该目录取，缺失即失败，与三件二进制同一口径）；`daemon-paths.ts` 有资源目录名常量，
`config.test.ts` 守住 stage 脚本 / 常量一致；`launchAgentPlist` 的 `EnvironmentVariables` 含 `COFLUX_CLAUDE_PLUGIN_DIR`，
值为主进程从 `daemon-bundle.ts` 解析出的资源目录绝对路径；app 启动时 plist 内容不同则只重写文件（不 launchctl）；
`daemon-files.test.ts` 的同构用例改为「npm 版 + 一个键」。未打包（本机 `electron .`）时资源目录解析沿用
`daemon-bundle.ts` 现有的 `build/daemon` 回退。
Validation: `pnpm -C apps/desktop typecheck` -> exit 0；`pnpm -C apps/desktop test` -> exit 0；`pnpm -C apps/desktop build`
-> exit 0。

### Milestone 3: 文档与索引

完成后：`integrations/claude-plugin/README.md`（全英文）说明 coflux 终端里插件由 Coflux.app 经 `--plugin-dir` 自动加载、
市场安装只为 coflux 之外的会话；`apps/desktop/README.md` / `RELEASING.md` 补 stage 输入与 plist 键；`docs/architecture.md`
在会话环境注入处补这个变量与 shell 集成一句；`packages/cli/README.md` 的 `COFLUX_*` 表补一行并注明 npm 线不写它；
`plans/README.md` Backlog 记「plan 112 的 PATH 首段前置同样被用户 rc 重新前置遮住，本机 `which -a cofluxd` 命中 npm 版；
shell 集成 rc 末尾再前置一次可修，未做」。
Validation: `perl -ne 'print if /\p{Han}/' $(find integrations/claude-plugin -type f)` 无输出；`git diff --check` -> exit 0。

## Landmines

- `crates/supervisor/src/sessions.rs:826-828` 先拷全量 env 再覆盖 `TERM` / `PATH` / `COFLUX_*`：`ZDOTDIR`、
  `XDG_DATA_DIRS` 的注入要和它们一样写在拷贝之后，否则被 supervisor 自身环境盖回去；用户已设的 `ZDOTDIR` 要先读出来
  再覆盖，且必须传给注入 rc（否则用户原 rc 找不到）。
- `tests/src/session-env-injection.test.mjs:173-190`：现有黑盒把 `COFLUX_SHELL` 指向 `#!/bin/sh` 包装脚本再 exec 真 shell，
  按 basename 分派会把它当未知 shell——这是预期行为，但新用例不能复用这个包装，也不要为了它放宽分派。
- `apps/desktop/test/config.test.ts:67-82` 断言 `mac.binaries` 数量 == `DAEMON_BINARIES.length` 且 stage 脚本正则含每个
  二进制名：插件目录不能进 `DAEMON_BINARIES`，要另立常量。
- `apps/desktop/src/main/daemon-files.test.ts:37` 把 app 的 plist 与 npm 版逐字比对；改口径时同时保留「除新增键外逐字同构」
  的断言，别把整条删掉。
- `apps/desktop/src/main/daemon-manager.ts:220-227` `writePlist` 后紧跟 `launchctl load/unload`：新的「启动时只重写文件」
  路径不能走同一个带 launchctl 的函数。
- 插件 `hooks/hooks.json` 的命令用 `${CLAUDE_PLUGIN_ROOT}` 定位脚本，Claude Code 会展开成 `--plugin-dir` 给的路径；
  app 包路径含空格（`/Applications/Coflux.app` 不含，但用户可能放在带空格的目录）——plist 值与 shell 函数里的引号要扛住空格。
- Bash 工具在 coflux 会话里跑 zsh：`"$VAR:apps/..."` 的 `:a` 修饰符会吃路径，git rev:path 写 `${VAR}:path`；`set -e`
  不生效，多步用 `&&`。
- 本机（用户 Mac）supervisor 仍是 2026-09-05 的旧版（无 `~/.coflux/supervisor-version`、`~/.coflux/bin` 里无 `cofluxd`），
  真机验收前用户要先升级 daemon；这不是本 plan 的事，只写进交付说明。
- `pnpm -C apps/desktop pack` 被 pnpm 内置命令截胡，本机冒烟用 `run pack` 并带 `COFLUX_DESKTOP_DAEMON_DIR`。

## Scope

In scope:
- `crates/supervisor/src/**`（新模块自定，`main.rs` / `sessions.rs` 接入点）
- `tests/src/session-env-injection.test.mjs`
- `apps/desktop/scripts/stage-daemon.mjs`、`apps/desktop/src/main/{daemon-paths,daemon-files,daemon-bundle,daemon-manager}.ts` 及各自 `.test.ts`、`apps/desktop/test/config.test.ts`、`apps/desktop/electron-builder.yml`（如需）
- `apps/desktop/README.md`、`apps/desktop/RELEASING.md`、`integrations/claude-plugin/README.md`、`packages/cli/README.md`、`docs/architecture.md`、`plans/README.md`

Out of scope:
- `integrations/claude-plugin/` 除 README 外的一切（插件内容不变，不提 `plugin.json` 版本；README 改动要不要提版本由执行者按仓库约定判断并在 Maintenance notes 写明）
- `packages/cli/cofluxd.mjs`（npm 线不写变量、plist 不变）
- `.github/workflows/desktop-release.yml`（stage 脚本从仓库内目录取插件，CI 不需要新输入；若实测需要再 STOP 报告）
- `crates/worker`、`crates/cli`、`apps/server`、`packages/client`、渲染层 `apps/desktop/src/renderer`——不加任何 UI
- Codex 的加载路径

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| supervisor 单测 | `cargo test -p coflux-supervisor` | exit 0 |
| Rust 零警告 | `RUSTFLAGS="-D warnings" cargo build -p coflux-supervisor` | exit 0 |
| desktop 类型检查 | `pnpm -C apps/desktop typecheck` | exit 0 |
| desktop 单测 | `pnpm -C apps/desktop test` | exit 0 |
| desktop 构建 | `pnpm -C apps/desktop build` | exit 0 |
| 插件目录零汉字 | `perl -ne 'print if /\p{Han}/' $(find integrations/claude-plugin -type f)` | 无输出 |
| 黑盒会话环境 (acceptance) | `pnpm -C tests test -- --test-name-pattern="plan 11[25]"`（或按 harness 惯例单跑 `session-env-injection`） | exit 0 |
| 本机出包冒烟 (acceptance) | `COFLUX_DESKTOP_DAEMON_DIR=<dir> pnpm -C apps/desktop run pack`，然后 `diff -r integrations/claude-plugin "<app>/Contents/Resources/daemon/claude-plugin"` | diff 为空 |

## Done criteria

- [ ] All listed commands pass.
- [ ] zsh / bash / fish 会话里 `type claude` 是函数；变量指向存在目录时 argv 含 `--plugin-dir <dir>`，否则不含；未知 shell 不注入。
- [ ] 用户原 rc 链（含用户自设 `ZDOTDIR`）仍按原顺序加载。
- [ ] Coflux.app 包内 `Contents/Resources/daemon/claude-plugin` 与 `integrations/claude-plugin` 逐字节一致；插件目录不在 `mac.binaries`。
- [ ] LaunchAgent plist 含 `COFLUX_CLAUDE_PLUGIN_DIR`；app 启动时内容不同只重写文件、不重启 daemon。
- [ ] Required tests exist and assert meaningful behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- A named assumption is false（尤其：`--plugin-dir` 对本机 Claude Code 版本不生效、或 `CommandBuilder` 无法为 zsh 传 `ZDOTDIR` 而不影响其他会话）。

## Maintenance notes

- 契约面只有一个环境变量名 `COFLUX_CLAUDE_PLUGIN_DIR`；以后换插件位置、换分发线（npm、Linux）只改注入方，supervisor 不动。
- shell 集成从此归 coflux 管：以后要做提示符标记（OSC 133）、cwd 追踪、修 plan 112 的 PATH 被 rc 遮住，都顺着这套 rc 走，别再开第二条注入路径。
- Claude Code 升级若改了 `--plugin-dir` 语义（尤其「同名压掉市场版」），先看官方 plugins.md「Test your plugins locally」再动。
- 用户 rc 出错的表现与今天相同（shell 照起、函数照定义）；如果用户 rc 里 `exec` 了别的 shell，注入的尾段跑不到，属已知边界。
