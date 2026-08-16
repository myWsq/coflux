# Plan 078: web 乐观 UI 与冷启动遮罩——把国际 RTT 从感知里拿掉

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat 0dc8ee9..HEAD -- apps/web/index.html apps/web/src packages/client/src/store.ts apps/server/src/hub.ts`

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent `dev:kimi-executor`（relay 模型 `kimi-k3`；preflight 已在 dev-explore 完成，`kimi-k3` 在 `$ANTHROPIC_BASE_URL/v1/models` 列表中，执行时无需重复 preflight）
- Planned at: `0dc8ee9`, 2026-08-17

## Requirement

web 客户端（apps/web）的两类高频交互体感差，根因都是**国际链路 RTT**（家宽 ↔ prod-jp，当前受 GFW 干扰走 Surge 绕行），不是服务端慢，也不是中心存储的问题：

1. **创建操作没有即时反馈**。点"新建工作区"后界面完全无变化，要静默等 2 段 RTT + daemon 侧 `git worktree add` 才看到结果；顶栏"新建终端 tab"虽有按钮 loading，仍要等 1 段 RTT 才出 tab。用户无法区分"点没点上"和"正在处理"。
2. **冷启动闪四跳**。依次是：① `index.html` 的 `#root` 为空 → bundle 下载期间纯空白页（国际链路上这是最长的一跳）；② React 挂载后全屏转圈；③ auth 成功但快照未到时，`projects`/`workspaces` 仍是空数组，于是**误报"从一个项目开始 / 导入项目"空态**外加一条空侧栏；④ 快照到达才是真内容。第③跳是语义错误——数据没到 ≠ 数据为空。

做完后为真：

- 点击创建 git 工作区、点击新建终端 tab，**在下一帧内**就能看到对应条目出现并被选中，无需等待任何网络往返；服务端广播到达后该条目原地转正，用户不感知切换；服务端报错则该条目消失并给出错误提示。
- 冷启动全程只有一个视觉状态：从 HTML 到达的那一刻起显示 coflux logo 遮罩，直到工作台的数据与首屏渲染都就绪才淡出。中途不再出现空白页、不再闪"从一个项目开始"的误报空态。
- 未登录用户不会被遮罩挡住登录表单；中心不可达时遮罩不会把人永久锁在 logo 页。

**明确排除的相邻错误解法**：不要去动中心的存储或数据模型。dev-explore 已确认"中心不存这些数据、每次由 daemon 上报"这条路走不通——离线可见性（daemon 掉线仍能看机群与终端现场）、prepared operation（对离线机器排队操作，构造 frame 时要读 DB 里的 `repoPath`）、冷启动速度（一次本机 PG 查询 vs N 台 daemon 各一个 RTT）三条都依赖中心持久化，且拆掉它对本 plan 要解决的延迟一毫秒都不会改善。本 plan 是**纯前端改动**。

## Decisions & tradeoffs

- **乐观态的存放位置**：放在 apps/web 的组件层状态里，渲染时与 store 数据合并显示。Rejected: 把假条目注入 `packages/client` 的 store —— 两条硬理由：其一，快照到达时 `workspaces`/`tasks` 是**整体替换**而非合并，注入的假条目会被无声抹掉（`packages/client/src/store.ts:435-445`）；其二，`packages/client` 是 web / mobile / iOS 共用的包，把 web 专有的乐观态塞进共享 store 会污染另外两端的状态语义。Based on: `packages/client/src/store.ts:435-445`，`apps/web/package.json` 依赖 `@coflux/client: workspace:*`。

- **遮罩的宿主位置**：遮罩元素写在 `index.html` 里、作为 `<body>` 的直接子元素，**放在 `#root` 之外**，由 React 在判据满足后移除。Rejected: 只在 React 组件里渲染遮罩 —— 那样覆盖不了第①跳（bundle 加载期间的空白页），而那一跳恰恰是国际链路上最长的，方案的主要收益就没了。Rejected: 把遮罩写在 `#root` 内部 —— `createRoot` 挂载时会清空容器内容，遮罩会在 React 挂载的瞬间消失，第②③跳照旧暴露。Based on: `apps/web/index.html` 中 `<div id="root"></div>` 为空且是 `#root` 的唯一内容；`apps/web/src/main.tsx` 的挂载点。

- **遮罩撤除判据**：`snapshotRevision > 0`（首次快照到达）。Rejected: 再等首个终端 attach 出画面 —— attach 要等 daemon 侧 RTT，设备慢或离线时会一直等到超时兜底才撤，反而比现在更慢；终端内容区本来就有自己的 attaching 局部加载态，那是语义正确的加载提示，不属于要消除的"奇怪闪烁"。Based on: `packages/client/src/store.ts:444`（快照到达时 `snapshotRevision` 自增），`apps/web/src/components/workbench/workbench.tsx:98-115`（快照到达后才做选中校准）。

- **遮罩的两条兜底出口**（缺一不可，二者是"或"关系，任一满足即撤）：其一，`authState` 进入 `need-login` 或 `auth-failed` 时立即撤除，否则登录表单会被遮罩挡住，用户无法登录；其二，React 挂载后 8 秒无条件撤除，否则中心不可达时用户被永久锁在 logo 页，连"连接已断开，正在自动重连"的横幅都看不到。Based on: `apps/web/src/components/workbench/workbench.tsx:314-330`（未登录渲染 `CredentialsForm`），同文件 `:431-436`（断线横幅）。

- **遮罩的样式实现**：`index.html` 里的遮罩用**裸 HTML + 内联 CSS**，不使用 Astryx 组件或 Tailwind token。这是对项目 UI 约定的一次**有意例外**，理由是该元素在 React 挂载前、CSS bundle 加载前就必须可见，此刻设计系统尚不存在。约束：底色必须与 `index.html` 中已声明的 `<meta name="theme-color" content="#111214">` 一致，否则冷启动会先白闪一下再变深色。这条例外**仅限 `index.html` 内的遮罩本身**；React 组件里的任何新增 UI（pending 条目、pending tab、创建中提示）一律遵守 Astryx 约定，禁裸 `<div>` 布局、禁裸 hex/px。Based on: `apps/web/index.html` 的 `theme-color`/`color-scheme` 声明，`apps/web/.claude/CLAUDE.md` 的 Astryx 规则。

- **乐观 UI 的覆盖范围**：只覆盖"创建 git 工作区"与"顶栏新建终端 tab"两条路径。Rejected: 顺带改设备终端首开（`createDeviceTerminal`）—— 它是低频入口，且已有按钮 `isLoading` 反馈，改造收益不足以抵消它额外牵扯的 `fsList(~)` 前置往返与幂等复用语义。Based on: `apps/web/src/components/workbench/workbench.tsx:172-183`（`createDeviceTerminal` 先 `listDeviceDirectory` 再 `terminalCreate`），`apps/server/src/hub.ts:1570-1582`（terminalCreate 的每设备幂等复用分支）。

- **失败回滚语义**：以 store 的 `lastError` 广播作为失败信号，收到即移除对应 pending 条目并让既有错误提示浮层展示原因；同时保留一个本地超时（与遮罩的 8s 无关，取值由 executor 定，量级为十秒级）作为兜底，避免服务端既不广播成功也不广播错误时 pending 条目永久滞留。Rejected: 只靠成功广播、不处理失败 —— `workspaceCreate` 失败路径（项目不存在 / 项目正在删除 / daemon 不在线）都只回一条 error，不会有任何 workspaceCreated 到达。Based on: `apps/server/src/hub.ts:1516-1528`（三条 error 早退分支），`apps/web/src/components/workbench/workbench.tsx:211-214`（现有 `lastError` 清 pending 的模式）。

- **(decided while planning) 遮罩淡出而非硬切**：撤除时做一次短促淡出（约 200ms 量级），避免从 logo 到工作台的硬跳变。理由是遮罩存在的全部意义就是消除视觉跳变，用硬切收尾会在最后一帧把跳变还回来。

- **(decided while planning) 第③跳的误报空态一并修掉**：`projects.length === 0` 不再等同于"没有项目"。快照尚未到达时不得渲染"从一个项目开始 / 导入项目"这个引导空态。即便遮罩通常会盖住这一跳，两条兜底出口（未登录撤、8s 超时撤）都可能让它暴露，所以空态语义本身必须修正，不能依赖遮罩遮丑。Based on: `apps/web/src/components/workbench/workbench.tsx:413-428`。

## Direction

纯前端改动，分三个里程碑。web 侧没有测试代码（项目约定：`arch-web` 不写前端测试），因此每个里程碑的机检都是同一条构建+类型检查命令；真正的行为验收由用户人工走查（见 Commands 的 acceptance 行与项目惯例 no-frontend-verification）。

三个里程碑彼此独立，可按任意顺序实现，但建议按序做——里程碑 1 会先把"pending 条目如何不被现有校准逻辑踢掉"这个最难的问题解决掉，里程碑 2 复用同一套思路。

### 里程碑 1: 创建 git 工作区变成即时反馈

点击创建后下一帧内：侧栏该项目下出现一个 pending 工作区条目（视觉上可辨识为"正在创建"），主区切换到它并显示创建中的提示。`workspaceCreated` 广播到达后，pending 条目被真实工作区原地取代，选中焦点保持在这个工作区上、不发生二次跳转。失败（error 广播）或本地超时后，pending 条目消失，错误经既有错误浮层呈现。

必须同时保证：pending 期间不向 attach 状态机注入不存在的 id，即不得因为乐观条目而产生任何指向假 id 的网络请求。

Validation: `pnpm --filter @coflux/web build` -> exit 0

### 里程碑 2: 顶栏新建终端 tab 变成即时反馈

点击新建 tab 后下一帧内出现一个 pending tab 并被选中；`taskCreate` 的广播到达后原地转正为真实 task tab，且转正过程不打断用户已经开始的 tab 切换操作（若用户在等待期间手动切走，转正不得把焦点抢回来）。失败或超时后 pending tab 消失。

同里程碑 1 的硬约束：pending tab 不得进入 attach / 激活状态机，不得产生指向假 taskId 的请求。

Validation: `pnpm --filter @coflux/web build` -> exit 0

### 里程碑 3: 冷启动只剩一个视觉状态

`index.html` 从 HTML 到达即显示 logo 遮罩；工作台在遮罩下方正常渲染；`snapshotRevision > 0` 后遮罩淡出。未登录时遮罩立即让位给登录表单；React 挂载 8 秒后无条件撤除。快照未到达时不再渲染"从一个项目开始"的引导空态。

Validation: `pnpm --filter @coflux/web build` -> exit 0

## Landmines

- **选中校准会把 pending 工作区踢回去**：`apps/web/src/components/workbench/workbench.tsx:98-115` 的 effect 在每次 `workspaces` 变化时校验 `selection`，凡是 id 不在 `workspaces`（或 `daemons`）里的一律判为 invalid 并回退到"首个项目的 main 工作区"。乐观条目的 id 天然不在 `workspaces` 里，若不处理，"点击后立即切换过去"会在同一帧被撤销，表现为点了没反应。这是本 plan 最容易踩且最难自查的坑。

- **tab 激活同样会被重置**：`apps/web/src/components/workbench/workspace-terminal.tsx:352-360` 的 `useEffect([workspaceTasks])` 在没有有效 currentActive 时会把激活 tab 落到 `workspaceTasks[0]`。pending tab 不在 `workspaceTasks` 里，同样会被重置。

- **现有的"新出现的未知 id"识别模式必须与新乐观态协同，不能各管各的**：`workbench.tsx:190-215`（`pendingWorkspaceCreateRef`，记下发起时已知 id 集合，把广播中新出现的该项目工作区认作本次创建并切过去）和 `workspace-terminal.tsx:313-320 / 343-351`（`pendingCreateRef` 同款模式）已经在做"转正后自动切换"。新的乐观条目若另起一套切换逻辑，会与它们打架，表现为转正瞬间焦点跳两次。正确做法是让转正复用这套既有识别，而不是并行再写一套。

- **快照是整体替换**：`packages/client/src/store.ts:435-445` 的 snapshot 分支直接用服务端数组覆盖 `workspaces`/`tasks`。任何"往 store 里塞一条假数据等广播来了再改"的思路都会在下一次快照（含断线重连后的重新快照）被无声抹平。

- **`createRoot` 会清空 `#root`**：遮罩若写在 `#root` 内部，React 挂载瞬间即消失。必须放 `#root` 之外。

- **`snapshotRevision` 在断线重连后会继续自增**：它是单调递增计数器而非布尔，`> 0` 作为判据本身是安全的（一旦为真永远为真），但不要把它误当作"当前是否已连接"来用——断线时它保持上次的值不变，此时该显示的是既有的断线横幅，不是遮罩。

- **`terminalCreate` 的服务端幂等分支不广播 workspaceCreated**：`apps/server/src/hub.ts:1570-1582`，当该设备已存在目录工作区时，服务端复用它、只补建一个 task，不再广播 `workspaceCreated`。本 plan 不改设备终端首开路径，但如果实现时顺手把乐观逻辑套到那条路径上，会等一个永远不来的 workspaceCreated。

## Scope

In scope:

- `apps/web/index.html`
- `apps/web/src/components/workbench/workbench.tsx`
- `apps/web/src/components/workbench/workspace-terminal.tsx`
- `apps/web/src/components/workbench/sidebar.tsx`
- `apps/web/src/index.css`（仅在遮罩淡出/工作台过渡确有需要时）
- `apps/web/src/` 下新增组件文件（如遮罩组件、乐观态 hook），按需

Out of scope:

- `packages/client/**` —— 共享包，见 Decisions 首条；乐观态不进共享 store
- `apps/server/**`、`crates/**`、`proto/**` —— 本 plan 是纯前端改动，服务端与 daemon 零 diff
- `apps/mobile/**` —— 已冻结，不加功能
- `ios/**` —— 移动端另行立项
- `createDeviceTerminal` 设备终端首开路径 —— 见 Decisions"覆盖范围"条
- 任何中心存储/数据模型改动 —— 见 Requirement 末段，已明确排除

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 构建 + 类型检查 | `pnpm --filter @coflux/web build` | exit 0 |
| UI 走查 (acceptance) | 用户人工验收：冷启动无闪烁、两处创建即时反馈、失败回滚、未登录不被遮挡 | 由用户执行 |

## Done criteria

- [ ] `pnpm --filter @coflux/web build` 通过。
- [ ] 创建 git 工作区：点击后下一帧内侧栏出现 pending 条目且主区切换过去；广播到达后原地转正、焦点不二次跳转；error 广播后 pending 条目消失。
- [ ] 新建终端 tab：点击后下一帧内出现 pending tab 并选中；转正不抢已被用户手动切走的焦点；失败后消失。
- [ ] 乐观条目全程不产生任何指向假 id 的网络请求，不进入 attach/激活状态机。
- [ ] 冷启动：HTML 到达即见 logo 遮罩，`snapshotRevision > 0` 后淡出；未登录立即撤；8s 超时兜底撤；快照未到时不渲染"从一个项目开始"空态。
- [ ] 遮罩底色与 `theme-color`（`#111214`）一致，冷启动无白闪。
- [ ] React 组件内新增 UI 遵守 Astryx 约定（无裸 `<div>` 布局、无裸 hex/px）；裸 CSS 仅出现在 `index.html` 的遮罩内。
- [ ] 未改动 Out of scope 列出的任何文件（`packages/client`、`apps/server`、`crates`、`proto`、`apps/mobile`、`ios` 零 diff）。
- [ ] `plans/README.md` 状态已更新。

## STOP conditions

- Decisions & tradeoffs 里引用的事实不再成立（例如快照不再是整体替换、`snapshotRevision` 语义变了、选中校准 effect 已被重写）。
- 要达成目标必须改 Out of scope 的文件——尤其是发现"乐观态必须进 `packages/client` 才能实现"时，停下报告，不要擅自改共享包。
- `pnpm --filter @coflux/web build` 在一次合理修复后仍连续失败两次。
- 实现过程中发现"点击后立即切换"与既有选中校准/激活状态机存在无法调和的冲突——停下报告冲突点，不要用 `setTimeout` 之类的时序 hack 绕过。

## Maintenance notes

- 遮罩的撤除判据绑在 `snapshotRevision` 上。将来若客户端改成增量同步、不再有"首次全量快照"这个事件，判据要跟着换，否则遮罩会一直吃 8s 超时才撤。
- `index.html` 里的裸 CSS 遮罩是设计系统之外的一小块飞地，改主题色时容易漏。`theme-color`、`color-scheme` 与遮罩底色三处必须同步改，否则冷启动会闪色。
- 本 plan 只治感知延迟，不治真实延迟。真实 RTT 的根治方向（让国内流量走已有的 bj relay 入口、绕开被干扰的直连线路）是另一件事，未在本 plan 内，需要时单独立项。
