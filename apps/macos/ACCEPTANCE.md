# macOS 原生客户端当前验收状态

2026-09-10 PR 收口（基线 `3173ce2`）：TypeScript server/web 检查、Rust daemon 零警告构建、共享 Swift 80 项测试通过。原生 Performance 全套重跑 219 项、26 跳过、0 失败；跳过项包含需要显式隔离服务、颜色视觉或钥匙串开关的用例。本轮第一次完整运行出现持焦终端关闭的 Ghostty 崩溃，随后终端专项 37 项和全套重跑通过，根因仍未定位，详见 FUNCTIONAL-GAPS；重跑通过不代表该问题已修复。

本轮容器黑盒全套：290 项、289 通过、1 跳过、0 失败（121.854 秒）；插件测试已修复只读环境脚本提前退出的 stdin EPIPE 竞态。普通 Performance App 构建与包审计通过：仅 App、WebRTC 两个 Mach-O，无脚本资源或直接 Web runtime 链接，许可一致、临时签名有效，不代表正式签名与公证。

**2026-09-10 用户实测纠正：此前Tooltip“已对齐”结论无效。** 用户指出颜色错误、定位偏移/跳动、缺少对应动画；此前核对漏掉`apps/web/src/main.tsx`的`cofluxTheme.components.tooltip`覆盖。当前修复深色popover/浅色文字/10pt圆角，按真实Web入场参数165ms、0.95缩放、8pt方向位移；默认按钮上方、终端OSC标题下方、侧栏详情右侧。浮层禁用NSHostingView自动窗口尺寸推导，保留hostingView，布局后合并更新锚点，内容高度变化保持对齐。下方历史浅色提示及“已对齐”记录只保留错误过程，不作为当前验收证据。完整Performance工程12项浮层回归通过、0失败（`/tmp/coflux-tooltip-correction-retry.log`），普通App构建通过（`/tmp/coflux-tooltip-corrected-app-build.log`）。产物审计通过，仅App+WebRTC两个Mach-O（`/tmp/coflux-tooltip-corrected-audit.json`）。已通过CUA退出旧App、启动`.coflux-dev/macos-current/CofluxPerformance.app`并重新登录19990，两个原会话恢复；该版本现供用户体验。回归证明定位与内容更新约束，未将程序化悬停等同于物理悬停实测。

更新：2026-09-08。此文件是当前状态索引；按时间累积的 README、100 计划和 VISUAL-PARITY 记录保留历史证据，旧测试数量与 SwiftTerm 结果不代表当前版本。总体目标仍未完成。

快捷键帮助增量：在 Web 自身 Vite 根目录挂载真实 ShortcutsHelpDialog，读取完整 Tailwind/Astryx 样式：380×248、标题区44、左右与底部16、行间距8、背景#262626。原生已对齐这些布局及28关闭按钮，保留原生键位与原有键帽。Performance临时签名构建通过；帮助渲染和快捷键导航/帮助开关两项通过，0失败（`/tmp/coflux-help-layout-build.log`、`/tmp/coflux-help-layout-tests.log`）；渲染产物`/tmp/coflux-native-shortcut-help.png`已查看。此前205项全套早于这次样式增量，本次未重复全套。首次Benchmarks目录预览缺部分Tailwind工具类，未将其用作最终样式依据。保留19990输入法验收进程，其运行中的旧UI不代表本次新构建。

终端标签提示增量：OSC 标题不同于任务名时才显示全文提示，与 Web 触发规则一致；移除系统 help。通用按钮提示复用原生非激活子窗口，默认控件下方显示、底边翻转并限制在窗口内，避免 ScrollView 裁剪。Performance 临时签名构建及工作区/设备浮层9项通过、0失败、exit0（`/tmp/coflux-tooltip-below.log`）；包含新增下方定位/边缘避让及既有焦点保持、滚动关闭回归。独立构建目录 `/tmp/coflux-macos-tooltip-build`，未替换19990人工输入法窗口；真实悬停视觉与完整原生回归尚未重验。

最新完整回归（含通用提示子窗口）：20014独立Release后端环境，当前Performance构建215项，208通过、7钥匙串项按约束跳过、0失败，166.923秒、TEST EXECUTE SUCCEEDED、exit0（`/tmp/coflux-tooltip-full.log`）。包括真实变更页刷新/高亮、终端切换/输入/重连及全部原生单元回归。测试产物审计通过（`/tmp/coflux-tooltip-full-audit.json`），包含13个Mach-O（含XCTest注入框架与测试产物），无脚本资源/直接Web runtime链接，许可与临时签名通过；不代表正式分发产物。20014 fixture已完整退出清理，19990人工输入法环境保留。真实悬停视觉及表中其他待验项仍未完成。

最新变更页实操：215项全套通过的当前构建，在20015隔离环境完成中文/emoji代码与二进制标识展示、原生横滚动作到达长行RIGHT_EDGE、折叠高度收敛及重新展开恢复；截图和AX树互相核对。并非物理触控板或真实悬停验收，细节见VISUAL-PARITY最新节。App副本与fixture已退出，19990保留。

通用提示视觉修正：核对实际安装的Astryx Tooltip/useTooltip、neutral主题与Web index.css，原生按钮/终端标题提示从深底11pt改为#fafafa浅底、#262626深字、13pt、圆角12、横8纵4内边距，与工作区详情及Web暗色主题一致。Performance构建与浮层10项通过、0失败、exit0（`/tmp/coflux-tooltip-style.log`）；短提示未被撑宽、长中文/emoji路径换行回归通过。已查看原生渲染图`/tmp/coflux-workbench-tooltip-short.png`、`/tmp/coflux-workbench-tooltip-long.png`。前述215项全套早于这次纯样式修改；未重跑全套或将离屏渲染认定为真实悬停。

当前人工体验入口：`/tmp/coflux-native-current/CofluxPerformance.app`（最新提示样式，普通Performance build、无XCTest注入）。构建成功`/tmp/coflux-native-current-build.log`，包审计`/tmp/coflux-native-current-audit.json`通过：仅App+WebRTC两个Mach-O，无脚本资源/直接Web runtime链接，许可及临时签名完整。副本只把测试服务地址设为19990；CUA已登录、恢复两个真实终端并停在终端1的shell提示符。Finder新窗口已显示53字节`中文 空格 😀.txt`。已向用户请求真实简体拼音候选选词与终端2跨窗拖放反馈；尚未收到，不能认定通过。保留该App、19990 fixture与Finder窗口供用户操作。正式签名、公证与生产准入未完成。

运行时原生边界增量：独立未登录诊断副本确认，系统WebKit/JavaScriptCore是在WritingToolsUI动态加载期间由系统生成式助手依赖带入；对应dyld依赖链及加载区间已记录在NATIVE-AUDIT。当前未发现客户端终端、高亮或工作台执行JS的绕行，无产品代码改动。诊断副本已退出，19990用户体验窗口保留。

项目行反馈增量：对照Web sidebar.tsx项目行的group-hover图标，原生项目行悬停时由文件夹切换为对应展开/收起箭头，固定14pt占位避免文字移动；移出或行移除时清理悬停状态。Performance临时签名构建通过（`/tmp/coflux-sidebar-hover-build.log`，exit0）。CUA无真实悬停接口，此视觉状态仍待实操；当前用户体验App副本未替换，保持输入法/拖放验收不中断。项目路径及本地会话徽标的系统提示与Web title一致，工作区/设备详情使用自定义浮层和accessibilityHint，未发现重复绑定。

前提：主界面及终端为原生实现，功能对齐当前 apps/web；局部字体/高亮允许合理平台差异，登录页不要求视觉一致。开发与性能验证不访问钥匙串，不使用生产设备，不读取以前失败的原生尝试。

| 要求 | 当前实现和证据 | 尚需完成 |
| --- | --- | --- |
| 原生工程与登录 | SwiftUI/AppKit、Ghostty；内存凭据登录、失败重试、认证时限有真实集成和共享测试 | 正式版本准入与分发见下；登录页无需像素对齐 |
| 侧栏与工作区状态 | 项目/设备/工作区、折叠、宽度、活动聚合、Agent 图标与提示已有实现；80项目/60设备下独立滚动和42%设备高度上限回归通过，空设备引导、项目离线灰点和路径提示已补齐 | 真实 Agent 连贯状态与逐屏核对收尾 |
| 终端标签与快捷键 | 当前物理键位与 Web standalone 对应；保活、切换、新建、关闭、活动标签滚入视口已有测试 | 运行中终端关闭确认已实操；其余窗口场景交互核对 |
| 终端输入与恢复 | Ghostty 输入、ANSI、复制、选择、滚动、控制权、重连；最新构建双标签系统剪贴板粘贴及中文emoji回显已实操通过；TerminalUploadTests 37项通过，含候选窗定位、组合输入与三种鼠标模式选择回归（见VISUAL-PARITY） | 真实系统中文候选窗选词；Vim 编辑退出及 tmux 分屏/切换/缩放/脱离重接/退出已完成 CUA 实操，tmux 鼠标切pane/拖动分隔线/Unicode选区与滚轮copy-mode进入退出已实操通过（快捷键进入未确认） |
| 导入与 Git 工作区 | 原生目录向导、分支、重命名、删除；真实目录/Git/工作区生命周期测试，导入 CUA 验收 | 分支搜索、占用禁用、Escape取消及工作区删除确认已完成 CUA 实操；项目移除框文案/焦点/回车不执行/Escape及取消已实操通过；实际移除级联清理/主仓库保留已有真实集成验证；完整输入法交互仍待完成 |
| Git 变更 | 原生 Tree-sitter/TextKit、独立横滚、折叠、错误重试、大文件按需布局；语言覆盖见 HIGHLIGHT-COVERAGE；真实Git正文同统计值改写后重新进入刷新验证通过 | 折叠、同统计值手动刷新及空态恢复已完成 CUA 实操；其余关键状态视觉收尾、完整工作台滚动呈现性能仍待完成 |
| 文件和图片 | 实际系统图片复制粘贴与远端像素核对；上传及权限变化有测试，部分文件读取失败后的成功路径投递和后续上传真实回归通过 | Finder 跨窗口文件拖放（CUA未确认送达；现已在19990终端2及新Finder目录重新准备手动补验，旧19873环境不适用）；大图边界实机验收 |
| 端口预览 | 活动按钮、后台标签菜单、停止与重新发现到浏览器页面有隔离实操记录 | 生产等价 HTTPS/HMR 环境验证，不能拿 HTTP fixture 推断 |
| 连接能力 | 原生 direct/P2P/relay 与撤权、降级、恢复有分项真实或隔离测试 | 跨 NAT 与非本机网络验证 |
| 性能改善 | 当前 Ghostty/Web 相同负载组件对照；完整工作台8路PTY两端各三轮焦点切换对照（当前Web更快，行为差异见Benchmarks）；原生输入及CPU/内存基线；单轮Metal轨迹已覆盖两阶段GPU执行（无呈现表数据） | 启动、GPU帧呈现、浏览器整体CPU/内存，公网与多终端输入负载；尚不能宣称原生整体更快 |
| 完整回归 | 最新原生215项：208通过、7钥匙串项跳过、0失败；前次全套偶发进程崩溃仍保留记录，详见证据入口；共享Swift77项加3项XCTest通过；supervisor64项通过，Rust无警告构建 | 临时消息追踪已移除；此前完整运行失败已定位为vt100单行换行崩溃并修复。最终交付仍须完整UI/功能收尾和正式分发验证 |
| 正式构建与分发 | Performance 为临时签名并隔离凭据；产物资源/直接链接/许可/签名完整性审计通过 | Release 已强制显式 COFLUX_BUILD_ID 并核验实际产物；正式服务器准入登记、Developer ID、公证及安装运行未完成 |

## 证据入口

输入性能测量条件校正：Debug环境145ms daemon往返与143ms快照持锁高度重叠，另一个83ms尖峰同样重叠。改用无插桩Release Rust三端后，两端各六轮通过，原生持续输出最大样本8.6–13.9ms，本轮未见百毫秒尖峰；中位/P95为原生5.03/10.77ms、Web5.25/6.40ms。DPR与网格仍有差异，不能据细小差值称整体更快。新增performance-fixture.mjs固定Release路径，20013实际启动验证通过；Debug结果保留为诊断。没有改产品调度或生产服务，详见Benchmarks/README及results-input-release-backend-2026-09-08.json。

relay关联诊断：20010独立Rust relay副本记录opaque帧时刻，原生三轮通过；138探针全部唯一关联，损坏日志行不涉及探针。最大120.85ms尖峰中约106.86ms位于relay→daemon→输入应用确认段，relay内部输入转发约0.020ms，说明该次最大尖峰主要来自共享daemon往返，不能据此修改Ghostty或原生输出泵。未确认daemon内部根因，也不能推广为全部尾延迟；原始证据见Benchmarks/results-relay-frame-timing-2026-09-08.json。正式relay源码和默认二进制已恢复、构建无警告。

输入帧数诊断：同PTY轮换Ghostty/客户端两帧/客户端一帧，每种15次、三轮；再加入成功写入PTY后的协议确认，另一组三轮通过。单帧仍有约50/82ms尾延迟；145/166ms慢探针的输入应用确认和程序确认都很晚交回客户端。尚不能区分relay/daemon等待与客户端接收等待，下一步在隔离relay侧关联收发；关闭追踪后的正常空闲/持续输出两项集成通过、exit0；没有修改产品合帧或终端显示策略。原始数据见Benchmarks/results-input-frames-2026-09-08.json。

输入传输追踪增量：测试专用观察器补齐发送调用开始/完成及PTY确认帧交回时间。全Ghostty三轮、同PTY交替Ghostty/直接客户端三轮均通过；较慢探针多数时间在确认帧交回前，未显示绕过Ghostty的稳定改善。最终观察器增加真实输入字节与确认帧断言，单轮通过（`/tmp/coflux-input-trace-verified.log`）。关闭观察器后空闲与持续输出两项集成通过、exit0（`/tmp/coflux-input-trace-disabled.log`）。默认关闭，诊断结果独立保存；没有修改产品传输或输入桥接，尚未确认尾延迟根因，原始数据见Benchmarks/results-input-transport-trace-2026-09-08.json。

输入尾延迟诊断：临时测试插桩已撤回，数据及可复现补丁保存在Benchmarks。已完成的72.77ms/39.05ms慢探针，输出泵累计处理分别仅0.18/0.14ms；后者Ghostty输入回调0.38ms内完成，下一步追踪发送→PTY→回传段。两组诊断整体验证未通过：一组视口未读到ACK，另一组采样后视图释放检查超时，均伴随XCTest清理错误，原因仍未确定。恢复无插桩测试后持续输出输入集成三轮通过、exit0（`/tmp/coflux-input-diagnostic-restored.log`），不代表前述失败根因已修复。不能据局部采样宣布提速，详见Benchmarks/README。

真实输入对照补齐：20006隔离relay，两端1280×684工作台，空闲与持续输出各三轮；原生六次集成全部通过，Web六轮通过并清理。三轮统计量中位数：空闲原生4.96/P95 7.24ms、Web5.25/6.30ms；持续输出原生6.21/24.44ms、Web5.20/6.00ms。原生持续输出尾延迟波动较大，下一步追查；不能宣称整体更快。网格原生145×37、Web143×37，轮询与读取开销、非交错等边界见Benchmarks/README和results-input-paired-2026-09-08.json。首次Web准备失败未计入，补齐真实shell应答后通过；没有修改产品输入代码。

连接断开诊断修正：原生接收循环此前将 direct/P2P 断开统一报为 relay；现按通道实际类型显示本机直连、P2P 或 relay。两个新增状态机回归在原实现均准确失败（`/tmp/coflux-route-name-before.log`），修复后共享77项 Swift Testing 加3项 XCTest全部通过、exit0（`/tmp/coflux-route-name-after.log`）；既有relay诊断回归也通过。仅改诊断文字，未改恢复或选路。Performance临时签名构建通过、exit0（`/tmp/coflux-route-name-build.log`）；上方214项原生全套早于本次微调。

最新完整回归（含设备诊断与提示）：20005隔离环境，214项中207通过、7钥匙串项按约束跳过、0失败，177.792秒（`/tmp/coflux-device-214-full.log`）。当前Performance测试产物的资源、直接链接、许可文本和临时签名审计通过（`/tmp/coflux-device-214-audit.json`）。测试日志含无显示器场景的display link回退，不能将这次功能回归当作GPU呈现性能证据。此前212项基线由此次覆盖，物理交互和正式分发仍按上表待验。

设备提示增量：设备行复用工作区的原生非激活浮层，显示实际 direct/P2P/relay 路径、RTT、worker/supervisor 版本及诊断；连接探测、授权失败和断开有独立状态，断开清除旧延迟。仅补观察状态，未改线协议或选路行为。共享75项 Swift Testing 加3项 XCTest通过（`/tmp/coflux-device-diagnostics-swift-retry.log`）；设备/工作区提示8项通过、exit0（`/tmp/coflux-device-tooltip-native.log`），设备渲染图`/tmp/coflux-device-tooltip.png`已查看。物理悬停仍待验收。

最新完整回归（含帮助面板、Agent状态和工作区详情提示）：20004隔离环境，212项中205通过、7钥匙串项跳过、0失败，179.023秒，exit0、TEST EXECUTE SUCCEEDED（`/tmp/coflux-current-212-full.log`）。当前Performance测试产物的资源/直接链接/许可文本/临时签名审计通过（`/tmp/coflux-current-212-audit.json`），不是正式分发验证。此前205项全套及后续分项结果均早于这次完整运行。

浮层生命周期补齐：侧栏程序滚动、窗口关闭/移动/缩放/打开sheet/应用切出均清理旧提示；状态更新遇到失效锚点也清理。多换行留言超出可见窗口时采用内部滚动，滚动提示本身不关闭；组合输入期间的Escape不用于关闭提示。新增真实NSScrollView程序滚动、窗口关闭、90行留言限高及内部滚动回归通过；提示/活动合计8项通过（`/tmp/coflux-tooltip-lifecycle.log`），并纳入上方212项全套。物理鼠标悬停仍未验收，不以协调器调用代替。

本轮首次全套失败记录：20003运行212项，7跳过，`testChangesPageRendersRealGitFile`等待变更计数超时并伴随清理CancellationError（日志`/tmp/coflux-tooltip-current-full.log`）。新增Agent测试曾在共享临时仓库工作树内写辅助脚本，异步Git统计会干扰紧接着的diff基线；已将脚本置于fixture主仓库私有`.git/native-agent-UUID`目录并照常清理，未放宽diff断言。新环境Agent→diff连续两项通过（4.197/3.490秒，`/tmp/coflux-agent-diff-sequence.log`），随后完整212项也通过。20003和20004环境已清理；此前独立记录的Swift任务释放偶发崩溃仍未解释，不因本轮通过而标为修复。

工作区详情提示增量：系统`.help`已替换为原生非激活子窗口，按实际Web Tooltip显示标题、活动点阵、留言、进度、路径、设备及diff基准；200ms显示、100ms离开缓冲、移入阅读、窗口边缘翻转/限位、滚动/点击/Escape/窗口变化关闭，辅助功能保留完整说明。真实Web组件预览确认浅底#fafafa、12圆角、4×8内边距、13标题/11详情；Web留言浅字在浅底可读性不足，原生对此使用深色。长留言最初高度测量导致裁剪，已改为按最终宽度测量，短/长渲染图已查看。最新6项状态/提示测试通过、0失败、exit0（`/tmp/coflux-tooltip-complete-tests.log`），包括真实创建NSPanel、显示状态、焦点不变和移入阅读复用窗口。CUA在独立20002副本完成登录和工作区选择，但点击未可靠触发悬停；不能把工具点击或协调器测试当作物理悬停实操通过。此前“系统纯文本help”描述属于旧版本，当前剩余为真实悬停、滚动裁剪和窗口边缘逐屏验收。没有访问钥匙串或更改保留的19990会话。

Agent 状态链路补验：新增 `testAgentHookRoundProgressAndPresenceRecovery`，在20001隔离fixture的真实PTY内运行受控`claude`脚本，调用现有`cofluxd hook/progress/notify`，经daemon/server送达原生Swift客户端。执行→待批准→留言待回答→完成→重新订阅恢复→新一轮→进程退出全部通过；中文emoji进度、换行留言、跨hook进度保留、完成后问题隐藏及退出清除也通过。用例2.986秒，1通过、0跳过、exit0（`/tmp/coflux-agent-round-shell.log`）。没有运行真实模型，也未将此协议/状态验证算作逐屏或悬停视觉验收。首次缺scheme环境变量被明确skip；后续直接Python脚本未被进程识别而失败，改用现有黑盒测试的/bin/sh包装后通过，未修改产品presence识别逻辑。工作区详情目前仍为系统纯文本help，与Web图标分行Tooltip存在已确认的视觉缺口。

启动测量增量：独立临时签名副本App Launch三轮登录页首帧1498.14/751.79/759.36ms，中位759.36ms。系统sleep对照也在录制到时后返回54/SIGKILL，说明仅凭这两个字段不能认定应用崩溃。数据见Benchmarks/results-launch-instrumented-2026-09-08.json；有录制/缓存/副本身份影响，非正式冷启动、终端就绪或Web对照，完整启动性能仍未验收。

最新全套：19999新隔离环境，相同当前产物205项，198通过、7钥匙串项跳过、0失败，172.519秒，exit0，TEST EXECUTE SUCCEEDED（/tmp/coflux-current-full-retry.log）。此前异常退出用例单项三轮通过后，整个TerminalPerformanceTests 8项也通过1.869秒（/tmp/coflux-terminal-performance-suite.log）；本次完整重跑未复现异常。不是根因修复声明：上一轮任务内存释放崩溃继续保留为未解释偶发问题。

工具链核对：Xcode 26.6 (17F113)、Apple Swift 6.3.3；公开swiftlang/swift#75501报告相同错误，但已在更早版本有修复反馈，不能据错误文本认定本次同因。未升级工具链、未修改并发逻辑、未关闭测试。19999环境已清理，19990输入法环境保留。

标签集合通知修复：activate/activateCurrent对成员或值实际变化才写入，显式activationRequests仍递增。新增Observation回归原实现失败、修复后通过；17项状态/导航/自动滚动/连接回归通过。修复后固定40标签三轮基准通过，空闲/输出中位17.443/16.726ms；基线仅两轮成功，不能宣称整体加速，详见Benchmarks/README及results-membership-observation-2026-09-08.json。

**前次全套未通过（最新重跑结果见上）**：/tmp/coflux-membership-full.log（exit65）在TerminalPerformanceTests.testVisibleTerminalOutputKeepsMainActorResponsiveAndIndependent出现进程异常退出，日志freed pointer was not the last allocation；其余结果不能覆盖该失败。minidump本地LLDB回溯位于libswift_Concurrency任务释放及XCTest路径（/tmp/coflux-membership-crash-backtrace.log），未确定根因，不归因于Ghostty。相同产物单独三轮该用例通过0.509/0.497/0.498秒（/tmp/coflux-membership-visible-retry.log），不代表崩溃已修复。19997/19998环境已清理。

持续输出刷新诊断：19996隔离环境固定40标签/8路PTY，临时_printChanges在持续输出且不切换的一秒窗口内未记录RootView或TerminalWorkspaceView body重算。单项通过21.844秒；不能据此排除其他视图成本，也不把带诊断日志的计时加入性能基线。原始记录见Benchmarks/results-output-refresh-diagnostic-2026-09-08.json。诊断源码已撤回，无诊断产物重新build-for-testing成功（/tmp/coflux-refresh-restored-build.log），后续重点仍为切换布局成本。

连接取消追踪：生命周期测试增加阶段及Task取消状态日志；19995新隔离环境10轮全部完成、0失败，28.117秒，所有phase=完成/taskCancelled=false（/tmp/coflux-lifecycle-diagnostic-ten.log）。未复现上一轮首次CancellationError，根因仍未确定；没有修改产品连接逻辑或忽略异常。

项目移除生命周期补验：增强testDesktopDirectoryGitAndWorkspaceLifecycle，保留真实子worktree，经原生model.remove移除项目；断言项目/全部工作区记录及子目录清理，主仓库HEAD、refs和未跟踪文件保持。19994独立环境首轮0.509秒遇CancellationError，根因未定；同产物重跑1次及随后3轮全部通过（3.884秒、3.619/3.082/3.061秒）。日志/tmp/coflux-project-removal-{test,retry,three}.log。仅新增测试，未改产品代码；不能据后续通过宣称首轮连接问题已修复。

项目移除框补验：19990环境文案与Web当前源码一致；初始焦点关闭按钮，Return未触发移除，Escape及取消均保留项目和两个工作区。未执行实际移除，也未进行Web同屏像素差分，详见VISUAL-PARITY最新记录。

tmux鼠标补验：19990独立会话完成鼠标切pane、拖动分隔线、中文emoji选区复制到tmux缓冲区、滚轮进入copy-mode及q退出，界面与tmux查询一致。独立会话已停止，终端1及输入法环境保留；详见VISUAL-PARITY最新记录。

标签内容 Equatable 试验已撤回：固定40标签/8采样PTY三轮通过，但空闲/输出切换中位数为19.03/19.55ms，未显示收益；恢复此前全套覆盖的标签实现。非交错测量，不将全部差值归因于改动。原始数据见Benchmarks/results-label-equatable-experiment-2026-09-08.json。恢复后重新构建及三项标签布局/自动滚动回归通过，0失败（/tmp/coflux-label-restored-tests.log）。

最新固定负载对照：同一19991隔离环境、40标签、8采样PTY，两端各3轮全部通过并清理。原生空闲/输出切换中位17.56/17.10ms，Web12.30/12.80ms，Web仍更快；仅焦点就绪，不代表帧呈现或整体App性能。数据见Benchmarks/results-paired-fixed40-2026-09-08.json。19991及15278预览服务已停止，19990用户输入法验收窗口保留并恢复焦点。

图片试验已撤回：元数据尺寸路径未显示稳定内存收益，恢复204项全套覆盖过的图片处理实现。三轮交错原始数据及边界见Benchmarks/README；大图系统剪贴板实操仍待完成。

最新全套：19989新隔离环境、当前Performance构建204项，197通过、7钥匙串跳过、0失败，167.330秒，TEST SUCCEEDED、exit0；`/tmp/coflux-current-acceptance-full.log`。包含零尺寸布局、连接忙态及鼠标模式增量。实际产物审计`/tmp/coflux-current-acceptance-audit.json`通过；仅代表测试产物的资源/直接链接/许可/临时签名完整性。此前分项记录中的“未重跑全套”仅指当时状态，现由本次覆盖。

确认框增量：19988隔离环境完成工作区删除、运行中终端关闭、设备移除弹窗的CUA逐屏核对；初始焦点、Return不执行、取消行为通过。实际删除临时工作区后目录移除且分支保留，实际关闭终端后恢复空态。设备仅验证取消，项目移除框仍待验；未做Web同屏像素差分。环境已清理，详情见VISUAL-PARITY。

鼠标增量：1000/1002/1003模式的普通拖动报告与Shift本地中文/emoji选择已有事件回归，终端输入整组37项通过（`/tmp/coflux-shift-mouse-final.log`）。1003允许合法的按下前悬停；原生Shift选择与当前macOS Web默认配置存在平台差异，详见VISUAL-PARITY。本轮无产品代码修改，也未将自动事件回归视为真实tmux鼠标实操。

最新连接状态修复：重激活已持有控制权的终端，不再无条件显示连接转圈及启动500ms定时器。真实连接状态与输入/切换/上传/重连两项通过，共享Swift74项加3项XCTest通过。修复前独立回归三次重激活均准确失败；记录见Benchmarks/README。本轮性能基线第一轮准备超时，不能据此报告提速；未重跑原生全套。

最新增量：零宽/零高布局保留 Ghostty 已有网格，恢复尺寸及合法单行终端回归通过。终端输入整组36项通过（`/tmp/coflux-empty-layout-after.log`，exit0）。当时201项全套早于此增量，现已纳入上方204项全套验收。

完整终端应用增量：tmux 3.7c在19986隔离环境完成CUA实操，覆盖左右分屏、方向键切换、中文/emoji粘贴、pane缩放、工作台标签保活、detach/attach及退出恢复。截图与tmux实际pane内容相互核对，环境已清理。上表tmux待验项的上述部分现已完成；鼠标/copy-mode及真实系统输入法仍未验证。

- [VISUAL-PARITY.md](VISUAL-PARITY.md)：实际界面、测量、失败与修复记录。
- [Benchmarks/README.md](Benchmarks/README.md)：可复现测量方法、原始数据和边界。
- [HIGHLIGHT-COVERAGE.md](HIGHLIGHT-COVERAGE.md)：高亮语言覆盖，不要求与 Web 每个 token 相同。
- [NATIVE-AUDIT.md](NATIVE-AUDIT.md)：原生依赖审查历史；当前产物以最新 audit-bundle.py 结果为准。
- [100 目标计划](../../plans/100-macos-web-parity.md)：用户完整目标与授权边界。

## 本轮黑盒运行

宿主固定测试端口与另一工作区发生冲突，已中止；该次结果无效，不能归因于原生代码。其他工作区服务未停止。

有效运行使用 coflux-native-parity-tests:20260908 镜像，容器名 coflux-native-parity-tests-20260908，无宿主端口映射/目录挂载，内部创建 Postgres 和临时 daemon。日志 /tmp/coflux-native-container-blackbox.log。最终 265 项中 264 通过、0 失败、1 跳过，297.573 秒，exit 0；容器已自动清理。唯一跳过的 macOS ad-hoc 重签失败用例已在宿主单独通过（1 通过、0 跳过，exit 0），日志 /tmp/coflux-native-macos-cli-trust.log。该用例使用临时目录与模拟失败的 codesign，不访问钥匙串。

历史原生全套日志（早于快捷键修复，不代表当前验收）/tmp/coflux-current-full.log：200 项、193 通过、7 钥匙串项跳过、0 失败，175.135 秒，TEST SUCCEEDED，exit 0（2026-09-08 06:00）。产物审计 /tmp/coflux-current-audit.json 通过，许可文本一致、临时签名完整；测试配置的临时签名不代表正式分发签名。历史197项回归保留在VISUAL-PARITY记录中。


终端启动回归已修复：vt100在单行终端自动换行时发生整数下溢，污染会话锁；vendor/vt100补丁修复可见行与历史行边界。重新构建daemon后，19985独立环境原生201项全部完成（194通过、7钥匙串跳过、0失败，170.493秒，exit0；/tmp/coflux-vt100-fixed-full.log）。此前失败日志保留在VISUAL-PARITY中，不再作为当前状态。此轮采样含临时消息追踪，性能数值不作为新的正式基准。

vt100修复后的黑盒回归：独立容器265项，264通过、1跳过、0失败，298.201秒，exit0；日志/tmp/coflux-vt100-blackbox.log。临时容器及19983–19985诊断环境已清理。原生UI/输入法/分发等剩余项仍按上表推进。
