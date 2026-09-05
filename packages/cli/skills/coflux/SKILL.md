---
name: coflux
description: 当你运行在 coflux 终端里（环境变量 COFLUX_WORKSPACE_ID 非空）时，把长任务、并行工作和求助外化成用户在 coflux web/手机上看得见、能随时接管的真实终端：读 COFLUX_* 环境变量知道自己在哪台设备/项目/工作区/终端，用中心的 coflux MCP（16 个 tools）开终端、读输出、等退出、输入、播报进度、叫人、拿预览 URL、开子工作区。适用于跑测试/构建/dev server 等耗时命令、需要用户接管或决策、想给用户一个可点开的预览 URL、要在隔离的子工作区并行干活的场景。
---

# 在 coflux 里工作

你可能正跑在 coflux 的一个终端里。coflux 让用户在浏览器和手机上盯着各台机器上的
agent 干活，随时接管。这个 skill 让你把自己的工作**变成用户看得见的东西**，并在需要时
操作账号下的其它工作区和设备。

agent 的能力面只有**一条轨道**：宿主里名为 `coflux` 的 MCP server（16 个 tools），用户做一次
OAuth 授权后能触达整个账号（所有设备、项目、工作区、终端）。没有本地命令——`cofluxd` 只是
daemon 的管理 CLI，不承载任何 agent 能力；如果你记得曾有过一组本地 agent 命令，它们已经全部
并入下面这些 tools（跑老命令只会得到一条指向对应 tool 的迁移提示）。

## 先判断自己在哪

只看环境变量，不要跑任何探测命令：

```sh
env | grep '^COFLUX_'
```

- **`COFLUX_WORKSPACE_ID` 非空** → 你在 coflux 终端里。下面的变量就是你的坐标，MCP tools 要的
  id 直接从这里拿，不用去 `list_*` 里猜：

  | 变量 | 含义 |
  |---|---|
  | `COFLUX_DEVICE_ID` | 你所在机器的设备 id（`list_devices` 的 id） |
  | `COFLUX_PROJECT_ID` | 所属项目 id（`create_workspace` 的 projectId）；无仓库的目录工作区为空串 |
  | `COFLUX_WORKSPACE_ID` | 所属工作区 id（`create_terminal` / `list_terminals` / `list_ports` 的 workspaceId） |
  | `COFLUX_TASK_ID` | 你这个终端的 id（`notify_user` / `report_progress` / `read_terminal` 的 terminalId） |
  | `COFLUX_SESSION_ID` | 你这个 PTY 会话 id |
  | `COFLUX_MCP_URL` | 中心 MCP 地址，用户配 MCP 时就用它 |

- **变量为空或不存在** → 按「不在 coflux 终端里」处理：忘掉「我在哪」，照常用你自己的工具；
  如果宿主里已经配了 coflux MCP，tools 照用，只是 id 要用 `list_*` 查（按 `pwd` 对路径）。
  如果用户明确告诉你「你就在 coflux 终端里」，那是那台机器的 daemon 还没升级到注入环境变量
  的版本：告诉用户在该机器上跑 `cofluxd update && cofluxd restart`（supervisor 不走热升级，
  重启后新开的会话才有变量），在那之前按上面的 `list_*` 方式对坐标。

## 没配 MCP 时

先 `claude mcp list`（Codex：`codex mcp list`）看有没有 `coflux`。没有就把接入命令交给用户，
地址用 `$COFLUX_MCP_URL`（它就是中心公网地址 + `/mcp`）：

```sh
claude mcp add --transport http coflux "$COFLUX_MCP_URL"     # Claude Code
codex mcp add coflux --url "$COFLUX_MCP_URL"                 # Codex
```

之后宿主会引导用户在浏览器完成一次 OAuth 授权（Claude Code 里是 `/mcp`）。授权是用户的事，
你只需要把地址和命令给他；没配好之前，需要用户看见/接管的活先别开工，或在自己的工具里做
一次性的快活。用 coflux 插件接入的 Claude Code 自带这份 MCP 配置，不需要手动 add。

## 什么时候开终端

**用 `create_terminal` 而不是自己后台起进程**——只要这条命令满足任一条：

- 要跑超过十几秒（测试、构建、安装依赖、迁移）
- 会一直跑下去（dev server、watch、日志跟随）
- 用户可能想接管（需要交互、可能要中途叫停、失败了要人去调）

这类工作在你自己的 Bash 里后台跑，用户**什么也看不见**：看不到它在跑、接管不了、
出问题只能等你转述。开成 coflux 终端，它就是侧栏里一个有标题的条目，用户能点进去、
能接管、能自己敲命令。

**不要用**在一次性的快命令上（`ls`、`grep`、`git status`、读文件）——你自己的工具更快，
给用户开一堆一秒就结束的终端只是噪音。

## 16 个 tools

id 优先从 `COFLUX_*` 环境变量拿；跨出本工作区的 id 用 `list_*` 查。

| tool | 用途 |
|---|---|
| `list_devices` | 账号下的设备（跑着 daemon 的机器）：id、名称、在线、版本 |
| `list_projects` | 导入的项目（git 仓库）：id、所在设备、仓库路径、默认分支 |
| `list_workspaces` | 工作区（主工作区 = 仓库本身，其余是 worktree；目录工作区 projectId 为 null），可按 projectId 筛 |
| `list_terminals` | 终端：id、工作区、标题、状态 idle/running/exited、退出码，可按 workspaceId 筛 |
| `read_terminal` | 读终端纯文本（去 ANSI，默认尾 200 行）：source=log 是命令终端的日志尾部（退出后仍可读），snapshot 是当前画面，checkpoint 是设备离线时中心的最近快照 |
| `list_ports` | 终端里检测到的监听端口 + 可直接打开的预览 URL |
| `create_workspace` | 在项目下新建 git worktree 工作区（可新建分支），设备真在磁盘上建目录 |
| `rename_workspace` | 改工作区名（纯展示） |
| `remove_workspace` | 删 worktree 工作区：先关其下所有终端再 `git worktree remove --force`（未提交改动会丢）；主工作区不可删 |
| `create_terminal` | 在某工作区开真实终端跑一条命令（用户可接管、侧栏可见），跑完带退出码；输出落日志供 `read_terminal` |
| `send_terminal_input` | 往运行中的终端写文本（默认追加回车） |
| `wait_terminal` | 有界等待终端退出并拿退出码（默认 30 秒、上限 600 秒，受宿主单请求超时约束） |
| `stop_terminal` | 结束终端会话（等价 web 上的停止） |
| `remove_terminal` | 删终端记录；运行中的必须先 `stop_terminal` |
| `notify_user` | 叫人：你的终端在侧栏转为「等待交互」并显示这句话，下一个 hook 事件即清空 |
| `report_progress` | 播报进度：显示在工作区卡片上，被下一条覆盖，跨 hook 事件存活，不打扰用户 |

## 常用动作

### 开终端跑命令

```
create_terminal { workspaceId: $COFLUX_WORKSPACE_ID, title: "跑单测", command: "pnpm -C tests test" }
```

`title` 是用户在侧栏看到的名字，**认真起**：写「跑单测」「起 dev server」，别写「terminal 1」。
命令在该工作区目录下、用登录 shell 执行。

命令跑完终端就退出，状态转 `exited` 并带上退出码——这是你判断成没成的依据。所以别指望在
同一个终端里接着跑第二条命令，要么写成 `a && b`，要么再开一个。

命令的输出会同时落一份日志供你回读（有界、保留最新的 1–2 MB，跑了很久的 dev server 也能读到
最新尾部），代价是它的 stdout 是管道而不是 tty——多数程序会因此关掉颜色和进度条。极少数程序
在非 tty 下行为不同（不输出进度、切成 CI 模式），如果你依赖那种行为，自己在 Bash 里跑。

新开的终端里同样有 `COFLUX_*` 变量（指向它自己的 task/session id，工作区与你相同）。

### 看跑到哪了

```
list_terminals { workspaceId: $COFLUX_WORKSPACE_ID }     # 本工作区所有终端：id、状态、退出码、标题
read_terminal  { terminalId, lines: 50 }                  # 某个终端的内容（纯文本，默认最后 200 行）
```

**终端已经退出也能 read**——「命令跑完了看输出」正是最常用的场景。`source=log` 是完整日志尾部，
秒级命令的输出也在；`snapshot`/`checkpoint` 只有一屏且可能有约 2 秒延迟。

### 等命令跑完

```
wait_terminal { terminalId, timeoutSeconds: 120 }
```

要等一条命令跑完就用 `wait_terminal`，**别自己写轮询循环去 `read_terminal`**——它一次阻塞到位，
退出码直接给你。到期返回 `timedOut=true` 不是错误，只是还没跑完：再调一次，或 `read_terminal`
看看现场再决定。上限 600 秒，但它受宿主单请求超时约束：手动 `claude mcp add` 接入的宿主默认
60 秒（超过会被宿主掐断，不是 coflux 的错误），coflux 插件接入的宿主放宽到 600 秒；拿不准就用
≤ 50 的 `timeoutSeconds` 多调几次。

### 往终端里输入

```
send_terminal_input { terminalId, text: "y" }              # 输入一行并回车（enter 默认 true）
send_terminal_input { terminalId, text: "", enter: true }  # 只按一个回车
```

用在命令要交互确认（y/N、选项）、或想在跑完的同一 shell 里补一条命令的时候。纪律：

- **先 `read_terminal` 再 `send`**：看清终端现在在等什么再输入，别盲打。
- **用户正在接管时会被拒**，错误里写明「用户正在接管」——这不是错误，是设计：人永远优先。
  被拒就停手，要沟通用 `notify_user`，别重试。
- 回执超时后**不要直接重发**：先 `read_terminal` 确认刚才那次到底进没进去，重复输入比丢输入更糟。

### 播报进度

```
report_progress { terminalId: $COFLUX_TASK_ID, message: "复现了，正在定位 relay 重连的时序" }
```

一句话告诉用户你干到哪了，显示在工作区卡片上，被下一条覆盖。在关键节点更新：复现了、
定位到了、修完在验、卡在哪。它**不打扰用户**、不改变你的状态，并且跨你的 hook 事件存活，
和 `notify_user` 是两条信道：

- `report_progress` = 播报（用户扫一眼就知道进展，不需要回应）
- `notify_user` = 叫人（工作区转「等待交互」，用户该来看看了）

拿不准用哪个：不需要用户做任何事就用 `report_progress`。

### 叫人

```
notify_user { terminalId: $COFLUX_TASK_ID, message: "两个方案都能走通，需要你定一下用哪个" }
```

用户的侧栏里你的终端会转成「等待交互」并显示这句话——他在手机上也看得到。
用在你**真的卡住**的时候：需要用户决策、要密码/权限、发现了必须人来判断的问题。
一句话说清要什么（≤ 200 字符，超限会被拒），别写成日志。这条留言随你的下一个 hook 事件
（下一次工具调用/回合结束）自动清空，所以叫完人就停下等，别继续干活把它冲掉。

（你正常的提问和权限请求已经会自动反映到侧栏状态上，不需要额外 notify。
这条是给「你要说的事，用户光看状态图标猜不出来」准备的。）

两个标注 tool 都要求目标终端里正跑着 claude/codex（有 agent presence）：终端不存在或不属于
当前账号、未在运行或还没有会话、设备离线、终端里没有 agent、daemon 太旧，都会明确报错，
不会静默成功。给自己打标注就用 `$COFLUX_TASK_ID`。

### 给用户可点开的预览

```
list_ports { workspaceId: $COFLUX_WORKSPACE_ID }
```

列出本工作区所有监听端口和对应的公网预览 URL。起了 dev server 之后用它拿 URL 直接
告诉用户，他点开就能看，不用自己去翻。

### 跨出本工作区

- **开一个隔离的子工作区并行干活**：`create_workspace`（projectId 用 `$COFLUX_PROJECT_ID`）
  在设备上真的 `git worktree add`，然后 `create_terminal` 在那里跑命令。
- **看/操作别的工作区、别的设备上的终端**：`list_*` → `read_terminal` / `send_terminal_input`。
- **不在 coflux 终端里**（比如用户在自己电脑上开的 Claude Code）时接入账号下的一切。

## 三条纪律

1. **人类优先**：`send_terminal_input` 在用户正在接管那个终端时会被拒，错误里写明
   「用户正在接管」——把交互留给用户，不要重试；要沟通用 `notify_user`。
   `send` 之前先 `read_terminal` 看清它在等什么；回执超时先 `read` 再决定要不要重发。
2. **有界等待**：`wait_terminal` 到期返回 `timedOut=true` 不是错误——需要更久就再调一次，
   **别自己写轮询循环去 `read_terminal`**。`create_workspace` / `create_terminal` 最多等 30 秒
   启动回执，到期返回「已提交」并附 id，稍后用 `list_*` 查。
3. **「需要升级」就停**：写 tools 在目标设备的 daemon 太旧时立即返回「该设备的 daemon 需要
   升级」——这是能力门禁，不是暂时故障。转告用户在那台机器上 `cofluxd update && cofluxd restart`，
   别重试也别换 tool 绕。

## 边界

- 你能开、读、等、输入，但**输入是人类优先的受限写权**：用户正在接管的终端你写不进去
  （会被明确拒绝），用户随时接管也会把你顶掉。别和人抢终端。
- MCP 触达的是**同一账号**下的所有设备/工作区/终端，不多不少。
- 一个工作区同时活着的终端有上限（默认 8，含用户自己开的）。撞上限先 `list_terminals` 看看，
  多半是有跑完没收的（`stop_terminal` / `remove_terminal`）；真是用户占满了，就 `notify_user`
  告诉他，别硬试。
- 这些 tools 都要目标设备的 daemon 连着中心才能用——毕竟「让用户看见」就是它们的全部意义。
  设备离线时会明确报错，不会默默降级（只读 tools 会退回中心缓存的最近快照）。
- `COFLUX_*` 变量只在 coflux 开出来的 PTY 里有；你自己 `export` 或改它们没有任何效果，
  中心只认它自己下发的 id。
