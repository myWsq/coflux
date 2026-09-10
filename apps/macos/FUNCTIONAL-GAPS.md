# 当前功能差距复核

2026-09-10 PR 收口：已同步主分支 3173ce2。主分支新增的计划 097「已退出终端历史查看与重启」需要单独补齐原生交互验收；本 PR 不宣称与最新 Web 全量功能、性能及发布条件完全对齐。

2026-09-10 稳定性待验：本轮完整原生测试在 `testFocusedWindowTerminalReleasesAfterRemoval` 出现一次 Ghostty 致命错误 `freed pointer was not the last allocation`。随后终端专项 37 项和完整 219 项（26 跳过）通过，但尚未定位根因，不能视为已修复；合并前需补充反复创建、输出、持焦关闭的稳定性验证。

2026-09-06。依据当前 Web 与本次原生实现，记录缺口及后续修复证据；局部绿测不代表全部验收完成。

## 中心断线后的终端删除

- Web：`packages/client/src/store.ts` 的 `closeTask` 先通过设备通道停止会话，`removeTask` 在中心未认证时记入 `pendingTaskRemovals`；`authOk` 在订阅后补发，登出清空。不会在没有中心确认时伪造目录删除成功。
- 原生最初缺口：`packages/swift-client/Sources/CofluxClientCore/CofluxClient.swift` 通过设备通道停止会话，但 `removeTask` 在中心离线时只报错，没有排队或重连补发。
- 后续已修复排队：按首次请求顺序去重，authOk 在订阅后补发，中心 taskRemoved 前不移除实体；显式登录、登出、认证失败或认证账号改变时清空，并用独立登录代次隔离旧异步关闭结果。协议测试覆盖离线已退出任务重复关闭、同登录重连、同账号重新登录和账号改变。共享全套 67 项 Swift Testing 与 3 项 XCTest 通过，日志 `/tmp/coflux-native-offline-removal-full-fixed.log`。
- 已补旧异步关闭隔离测试：在发出设备通道申请且等待 holder 时登出，不让出 MainActor 即投递同账号新认证，再恢复旧 continuation，验证不覆盖新错误、不向新连接发 taskRemove。AuthFlowTests 17 项通过，日志 `/tmp/coflux-native-stale-close.log`。这覆盖 reset 拒绝等待者的失败返回，不代表远端 stop 成功响应晚到已验证。
- 已补真实 P2P 关闭：隔离客户端先建立 WebRTC、执行终端输出和 Git，再断开并阻止该客户端中心 WS 重连；关闭后通过设备事件确认 EXITED，目录实体仍保留且无新错误，放开重连后自动删除。原有 P2P/relay 回退用例一并通过（2 项），日志 `/tmp/coflux-macos-offline-close-p2p.log`。worker 的中心连接保持在线，不代表整个中心服务故障或跨 NAT。
- 已补本机 direct 同类真实测试：复用同一关闭流程，显式只注入内存凭据的本机 provider，断线前确认 direct 模式；完成后撤销测试 grant。direct、P2P 离线关闭与原有回退共 3 项通过，日志 `/tmp/coflux-macos-offline-close-direct.log`。
- 已补停止失败协议测试：假设备完成 attach，观察 sessionStop 后返回 operationAck(ok=false)，验证错误显示、任务保持 RUNNING、当前控制连接无 taskRemove、同登录重连无补发。TaskRemovalTests 1 项通过，日志 `/tmp/coflux-stop-rejected.log`；不代表真实 worker 故障注入。
- 仍需：旧远端停止成功跨登出完成的专项验证。上述缺口尚不能整体标为完成。
- 影响：中心短断但设备连接存活时，停止可能已生效，目录任务却无法自动清理；用户要在重连后再次关闭。
- 修复验收：离线停止成功或设备明确返回 session_not_found 后记账；未知停止错误不能删目录；同账号重认证后补发且重复关闭去重；中心确认前保留实体；登出、换账号及旧异步关闭返回不能污染新登录。需要协议发送测试及真实 direct/P2P 断中心场景，不能只断言一个 Set 的内容。

## 终端连接中的标签反馈

- Web：`workspace-terminal.tsx` 仅在确实进入 attaching 时显示 spinner；未发起 attach 的后台任务保持普通终端图标，detached 显示 unplug。
- 原生原先只有 detached、AgentGlyph、普通终端图标；现已加入 attachingTaskIDs 与原生 mini ProgressView，仅 startTask 实际请求进入，成功/被接管/退出/错误/删除/登出清理。RUNNING attach 沿用 Web 500ms 视觉 grace，启动设 15s 兜底；视觉结束不授予 holder。
- 共享 70 项 Swift Testing 与 3 项 XCTest 通过，新增验证后台不误转、grace 不授予控制权、失败/删除/登出清理；日志 `/tmp/coflux-attach-indicator-core.log`。macOS 真实终端和工作区定向回归见 `/tmp/coflux-macos-attach-indicator.log`，实际窗口 spinner/焦点仍待视觉验收。
- 修复验收：反映真实请求生命周期，成功、失败、超时、被接管和卸载均收敛；不能用 RUNNING 且没有控制权直接推断 attaching，否则旁观或隐藏终端会无限旋转。

## 本轮已核对且未发现差异

- 当前任务的端口快捷入口均使用服务端提供的 URL；原生通过系统浏览器打开 HTTP/HTTPS，Web 打开新标签。
- 两端任务标签均提供各自端口菜单；当前 Web 顶栏未提供复制地址动作，不能把额外添加复制功能当作现有对齐要求。

本文只记录本轮查证的差距，不是完整功能清单。逐屏 UI、真实输入法/拖放、语言覆盖与性能对比仍须另行验收。

### 2026-09-06：设备浏览请求取消延迟修复

- 新增离线不发起、取消后重试的 WorkbenchStateTests，发现底层 Device RPC continuation 未响应取消：两次取消共等待约40秒，直到请求超时才释放创建忙态。
- DeviceRouter.request 现在通过 cancellation handler 移除对应 pending request、取消超时任务、以 CancellationError 恢复等待，并 releaseIdle；不取消其他请求共享的连接。主 actor 中以设备ID和唯一requestID定位，避免跨隔离捕获 Route。
- 增加取消必须1秒内退出的断言；修正后完整用例0.025秒，原生状态13项通过（`/tmp/coflux-device-cancel-fixed.log`）。共享客户端70项 Swift Testing + 3项 XCTest通过（`/tmp/coflux-core-cancellation.log`）。这是授权等待阶段取消的验收，不表示已发出的远端操作可撤回。
- 新增设备离线/等待/错误离屏渲染夹具；渲染组9项通过（`/tmp/coflux-device-states.log`），这三张新增图尚未完成与 Web 的逐状态视觉核对。

### 2026-09-06：取消的并发与迟到响应回归

- `DeviceRouterTests.cancellingOneDirectoryRequestPreservesOtherRequest` 在同一 fake relay 上实际发送两个 FsList，取消其一，注入其迟到 FsListed，再返回另一个请求结果。
- 验证取消1秒内返回 CancellationError，存活请求路径正确、无路由错误、仅建立一次 relay。共享全套71项 Swift Testing + 3项 XCTest通过，日志 `/tmp/coflux-core-cancel-concurrent.log`。

### 2026-09-06：共享取消与 UI 调整后的完整原生回归

- `COFLUX_NATIVE_TEST_URL=ws://127.0.0.1:19873/client`、Performance、临时签名，显式移除钥匙串开发/测试环境开关；完整 XCTest 123项，116通过、7钥匙串测试跳过、0失败，120.542秒。
- 日志 `/tmp/coflux-macos-post-ui-full.log`，结果 `/tmp/coflux-macos-093-build/Logs/Test/Test-Coflux-2026.09.06_15-14-58-+0800.xcresult`。包含真实隔离PTY/Git、direct/P2P、离线关闭、租约自然到期与续期，以及当前原生状态/渲染测试。
- 测试后 fixture 恢复1daemon/0clients/6sessions，与运行前一致；无残留测试App、XCTest或xcodebuild进程。
- 构建结束后审计 `/tmp/coflux-post-ui-audit.json`：13个Mach-O（含测试依赖）、0脚本资源、0直接Web运行时链接，许可文本匹配、临时签名完整。
- 该回归不证明完整Web功能/UI对齐、真实输入法/拖放/帧率、正式签名公证或跨NAT。未提交，仓库全套提交门仍待执行。

### 2026-09-06：diff 高亮回填保留 TextKit 布局

- DiffSelectionView 原先每次高亮结果回填都 setAttributedString。当前仅在源行完全相同时用 NSLayoutManager 的 foregroundColor 临时显示属性更新，正文/字体/段落不变；完整内容变化时清临时属性再替换。纯颜色更新不重复设置选区。
- 同一5000行用例比较：直接编辑文本存储颜色路径约199.6ms（`/tmp/coflux-diff-color-layout.log`），临时显示属性路径约24.1ms（`/tmp/coflux-diff-color-display.log`）。均测更新及ensureLayout，布局字符保持133889，选区保留；不是原始版本整段替换的完整对照，也不是窗口帧率。
- 新测试验证高亮颜色、撤掉高亮恢复基础颜色、已有布局不丢失和选区不变；diff文档12项通过，包含连续复制及固定行高等已有回归。
- 首次远距离跳转仍需顺序排版，此优化不解决那条独立路径。临时显示属性用于屏幕高亮，文本存储中的颜色不作为最新渲染颜色来源；当前原生diff复制的是纯文本。

### 2026-09-06：TextKit 临时高亮绘制与失效验证

- 新增生产 DiffSelectionView 离屏 cacheDisplay 检查：纯红 const 仅通过临时属性加入，位图实际检测到红色字形并保存 `/tmp/coflux-diff-temporary-highlight.png`。这是透明背景组件图，不是完整diff页面配色验收。
- 同正文切换为hunk标题后，临时颜色清除、字体恢复11pt、行高22pt；随后缩短正文，旧颜色仍不残留。原有连续选择/复制回归保持通过。
- diff文档13项通过（`/tmp/coflux-diff-render-validation.log`），5000行颜色更新及布局检查约23.4ms，已布局字符不变。未把这条局部结果当作真实窗口帧率或首次远跳性能。

### 2026-09-06：可见 diff 分批预布局

- 关闭 AppKit 自动 backgroundLayout，改由 NativeDiffText 的 active 状态驱动：每批请求最多2048个字符的连续布局，批间休眠8ms让出主线程；隐藏、卸载或替换正文时取消旧代次。纯颜色更新继续复用原布局。
- 新测试在5000行文档中确认首批尚未布局全文、隐藏40ms期间无进展、恢复可见后完成、总高度100000pt不变。预布局完成后末尾访问约0.009ms；此值不能与未预布局的首次远跳直接比较，也不代表总布局成本消失。
- diff文档14项测试通过（`/tmp/coflux-diff-prelayout.log`）。当前每批按字符数限制，不是硬实时预算：单段超长文本仍可能让TextKit超出预期；真实窗口帧率、首开立刻远跳和能耗仍待测量。


### 2026-09-06 15:50：近期高亮、登录和 diff 改动后的完整回归

- 当前 Performance XCTest 131项：124通过、7项钥匙串用例跳过、0失败，121.659秒。显式使用临时签名及隔离 fixture，未启用钥匙串测试。
- 日志 `/tmp/coflux-macos-current-parity-full.log`；结果 `/tmp/coflux-macos-093-build/Logs/Test/Test-Coflux-2026.09.06_15-48-03-+0800.xcresult`。共享客户端另有71项 Swift Testing +3项 XCTest通过，日志 `/tmp/coflux-swift-current-parity-full.log`。
- 产物审查 `/tmp/coflux-current-parity-audit.json`：13个Mach-O，0脚本资源、0直接Web运行时链接，许可文本匹配、临时签名有效；29项锁定依赖的许可检查通过。
- 隔离服务运行前后均为1daemon/0clients/6sessions；测试结束无 CofluxPerformance 或 XCTest 进程残留。
- 此证据更新完整原生回归基线，不代表完整UI/功能对齐、真实输入法/拖放/滚动帧率、跨NAT或正式签名公证已验收。仓库提交门仍待执行，未提交。


### 2026-09-06：已发出停止请求后的跨登录迟到响应

- TaskRemovalTests 通过真实协议编码发送 sessionAttach/接收 sessionAttached，确认 sessionStop 已发送，再登出并完成同账号或另一账号登录，最后向旧设备连接投递 operationAck(ok=true)。验证新错误不被覆盖、同ID任务保留、当前连接及后续重连均无 taskRemove。
- 参数化测试3种场景（停止拒绝、同账号重登、切换账号）通过，日志 `/tmp/coflux-stop-late-login.log`。测试夹具首次漏设新token导致重连等待，已停止该次运行、补齐认证响应后重跑通过。
- 此证据覆盖旧连接成功帧晚到：登出会拒绝旧pending请求。尚不覆盖成功ack已被路由处理、但closeTask成功continuation尚未恢复时切换登录的更窄调度窗口；不能把本项宣称为那个窗口的验证。生产逻辑未改。


### 2026-09-06：完整页面屏外大文件首次布局修复

- 新真实Git测试用80行前文件和5000行后文件，暴露此前组件测试漏掉的屏外全文布局（127798字符已全部排版）。仅限制任务active不足以阻止NSTextView首次填充/挂载的同步布局。
- NativeDiffText现在保留完整DiffTextDocument与模型确定尺寸，首次进入视口才填充TextKit；已显示过的文件离屏后继续保留文本和选区，只暂停预布局。sizeThatFits直接返回模型尺寸；未挂载/零尺寸时不请求重绘，挂载后的脏区域与bounds求交。
- 诊断记录显示未挂载visibleRect近乎无限大；仅裁剪或尺寸覆盖均不足以单独修复。临时日志已移除。
- 测试明确驱动外层纵向NSScrollView（内层横向容器的scrollToVisible不会让屏外文件进入纵向视口）。屏外布局为0且80ms无进展，进入视口后生成完整文本、高亮并出现布局进度。
- 16项定向回归通过（14项diff组件 + 真实长行页面 + 多文件视口），日志 `/tmp/coflux-multifile-outer-scroll.log`；当前运行的随机文件由测试清理。
- 此验证是离屏窗口程序滚动，不是触控板或FPS测量。首次进入超大文件的同步TextKit成本、再次离屏后选区保持的整页交互及真实能耗仍需验证。整体目标未完成。


### 2026-09-06：多文件往返视口保留选区

- 扩展真实Git5000行测试：首次显示后选中second_12，外层滚动回顶部，等待大文件离屏；再滚回大文件。断言文档对象相同、末行仍在、选区不变。
- 离屏暂停时仅布局11127/127798字符，等待80ms无进展，因此暂停证据不是全文已布局完的空判断。
- 定向测试通过（`/tmp/coflux-multifile-selection-retained.log`，3.996秒）。仍为离屏AppKit程序滚动，不代替真实触控板、跨文件拖选或帧率验收。


### 2026-09-06 16:30：Kotlin与多文件延迟TextKit之后的完整回归

- 当前Performance完整XCTest136项：129通过、7钥匙串测试跳过、0失败，127.152秒。日志 `/tmp/coflux-macos-lazy-diff-full.log`；xcresult `/tmp/coflux-macos-093-build/Logs/Test/Test-Coflux-2026.09.06_16-28-30-+0800.xcresult`。
- 共享客户端71项Swift Testing及3项XCTest通过，日志 `/tmp/coflux-core-lazy-diff-full.log`，包括参数化的跨登录迟到停止响应场景。
- `/tmp/coflux-lazy-diff-audit.json`测试产物审查通过：无脚本资源/直接Web运行时链接、许可一致、临时签名有效。30项锁定依赖许可检查通过。
- 隔离服务结束为1daemon/0clients/6sessions，无CofluxPerformance、XCTest或共享测试进程残留。未启用钥匙串测试，未提交。
- 最新完整回归基线更新；不代表完整Web功能/UI、真实输入法/拖放/帧率或正式签名公证验收完成。仓库提交门仍未全跑。


### 2026-09-06：终端会话更换时取消旧上传

- 核对Web与原生上传/粘贴路径后，发现原生Coordinator在sessionID变化时只清输出及待粘贴路径，未取消旧uploadTask；批量文件取消后仍继续循环检查所有剩余URL。
- 现会话ID变化取消旧上传，批处理catch遇到任务取消立即break；pastePaths既有取消、sessionID和控制权检查继续阻止旧结果输入新会话。
- TerminalUploadTests 8项通过（`/tmp/coflux-upload-cancel-lifecycle.log`），覆盖已有后台取消传播、拖动遮罩、IME提交和图片准备。该组不直接覆盖Coordinator会话切换期间的在途RPC，不能声称远端已写入的临时文件被撤回；真实Finder拖放仍待验收。


### 2026-09-06：上传任务的会话边界验证

- 新Coordinator测试绑定旧会话与可观察任务句柄，先普通刷新再替换sessionID；确认普通刷新不取消任务且保留待粘贴路径，会话替换取消旧任务并清空旧路径。
- TerminalUploadTests共9项通过（`/tmp/coflux-upload-session-boundary.log`）。此项验证绑定生命周期与取消信号；没有发起网络上传，不证明在途RPC清理或新上传忙态收尾无竞争。真实Finder拖放仍待验收。


### 2026-09-06：终端行距调整后的真实窗口与PTY尺寸

- 扩展testRealLoginTerminalSwitchAndReconnect：在拿回控制权后将真实NSWindow缩至1040×700，再恢复1360×800，等待原生栅格改变与尺寸防抖，远端执行stty size并与当前SwiftTerm行列数逐次比较。
- 用例通过（`/tmp/coflux-window-pty-resize.log`，4.366秒），同时执行错误密码/正确登录、真实PTY输出、终端切换、控制权接管、重连与退出后重启等既有流程。
- 此项验证实际窗口尺寸更新到真实PTY的链路，窗口尺寸由测试程序设置；不等同于人工拖动窗口、跨屏幕缩放或FPS验收。


### 2026-09-06：真实标签关闭后释放挂载对象

- 在真实登录/PTY/切换/上传/接管/重连场景末尾，关闭测试创建的第二个任务；等待服务端目录归约后检查弱引用，确认对应TerminalView与NativeTerminal.Coordinator都已释放。
- 收窄测试中第二终端临时强引用作用域，避免测试自身阻止回收。原有首终端与fixture继续保留。
- 用例通过（`/tmp/coflux-mounted-terminal-release.log`）。这补充了独立组件释放测试，覆盖真实SwiftUI挂载和会话消费订阅；长期反复开关及全App泄漏分析仍未完成。


### 2026-09-06 17:01：终端配置与 Elixir 接入后的完整回归

- Performance XCTest共142项：135通过、7项钥匙串用例跳过、0失败，127.110秒。覆盖近期生产终端历史/行距/色板、上传会话取消、窗口PTY尺寸同步、终端释放、多文件diff延迟布局与Elixir高亮。
- 日志 `/tmp/coflux-native-elixir-full.log`，结果 `/tmp/coflux-macos-093-build/Logs/Test/Test-Coflux-2026.09.06_16-58-49-+0800.xcresult`。共享客户端71项Swift Testing和3项XCTest通过，日志 `/tmp/coflux-core-elixir-full.log`。
- 使用临时签名和内存凭据；未启用钥匙串测试。测试结束无CofluxPerformance/xcodebuild/xctest进程残留，隔离服务恢复1daemon/0clients/6sessions基线。
- 产物审计 `/tmp/coflux-native-elixir-full-audit.json`：13个Mach-O（含测试框架），无脚本资源及直接Web运行时链接，许可文本匹配且临时签名有效。
- 本次是当前原生自动化回归证据，不能代替完整Web功能和视觉验收、真实IME/Finder拖放/触控板、跨NAT、性能优于Web及正式分发验收。仓库提交门未完成，未提交。


### 2026-09-06：上传取消后的忙态与迟到完成隔离

- 发现会话更换/视图释放原先只cancel上传，uploadTask和界面忙态仍等旧任务返回才清理，可能阻塞新会话上传。
- 现统一startUpload/cancelUpload生命周期：取消立即清除任务槽与忙态；上传代次使旧任务defer无法清掉新上传句柄或忙态。图片和文件共用该路径，仍保留取消、会话ID和控制权检查以拒绝旧路径粘贴。
- 新测试用可控continuation模拟不立即响应取消的上传，验证会话更换后新上传可开始、旧完成不清新忙态、新完成正常收尾。13项终端上传回归通过 `/tmp/coflux-upload-generation.log`。
- 真实原生窗口集成用例通过 `/tmp/coflux-upload-generation-integration.log`（4.199秒），覆盖真实多文件/图片上传、后台暂存、控制权接管、PTY窗口尺寸与重连/释放流程。隔离服务恢复1daemon/0clients/6sessions。
- 此修复不撤销远端已写入文件，也不证明网络在途操作能立即终止；验证的是会话忙态/完成顺序隔离，完整Finder拖放与所有真实取消时序仍待验收。


### 2026-09-06：上传取消通知避开 SwiftUI 更新周期

- 取消入口来自updateNSView/dismantleNSView，上一版同步onUploadState(false)会在视图更新/卸载中回写可观察模型。现保持任务槽立即清空、取消立即生效，界面清理改为下次MainActor调度发送；上传代次阻止旧通知清除同轮新上传。
- 重复release在无上传句柄时不再推进代次，防止把第一次排队的清理通知作废。通知短暂保留coordinator，确保卸载后的清理能送达。
- 新测试验证释放前任务尚未运行时不启动操作、卸载内不回调界面、重复释放最终只清理一次；已有迟到完成测试同时覆盖取消后同轮新上传使旧通知失效。
- 14项终端上传测试与1项真实窗口/上传/重连集成测试全部通过，日志 `/tmp/coflux-upload-deferred-state.log`；未出现Modifying state/Publishing changes诊断。隔离服务恢复1daemon/0clients/6sessions。
- 这补齐生命周期调度边界，不能代替完整真实Finder拖放/网络取消验收；整体目标仍未完成。


### 2026-09-06 17:38：近期语言与上传生命周期改动后的完整回归

- 当前Performance XCTest共151项：144通过、7项钥匙串测试按默认策略跳过、0失败，129.580秒。包含新增至SQL的原生高亮、上传代次/延迟界面通知，以及既有登录/直连/P2P/真实窗口/多文件diff/终端性能用例。
- 日志 `/tmp/coflux-native-sql-full.log`；结果 `/tmp/coflux-macos-093-build/Logs/Test/Test-Coflux-2026.09.06_17-35-41-+0800.xcresult`。共享客户端71项Swift Testing和3项XCTest通过，日志 `/tmp/coflux-core-sql-full.log`。
- 34项远端锁定依赖及4项本地原生语法的许可/源码检查通过；产物 `/tmp/coflux-sql-full-audit.json` 审计通过，无脚本资源及直接Web运行时链接、许可匹配、临时签名有效。
- 全程临时签名和内存凭据，未启用钥匙串测试。测试结束无CofluxPerformance/xcodebuild/xctest进程残留；隔离服务恢复1daemon/0clients/6sessions。
- 这是当前自动化回归基线，不证明完整Web视觉/功能对齐、真实输入法/Finder拖放/触控板、跨NAT、性能优于Web或正式分发完成。仓库提交门仍未执行，未提交。


### 2026-09-07：窗口激活状态同步终端焦点

- SwiftTerm在become/resignFirstResponder发送1004焦点报告，但窗口主状态通知仅更新光标动画。窗口切到后台且终端仍是第一响应者时，缺少终端程序的失焦通知。
- UploadTerminalView按当前NSWindow绑定didBecomeKey/didResignKey，移窗时清旧监听；仅window.firstResponder为该视图时同步setTerminalFocus，其他窗口/后台终端不误报。
- 18项终端测试通过 `/tmp/coflux-window-focus.log`。新测试输入DECSET1004后调用真实NSWindow becomeKey/resignKey，核对ESC[I/ESC[O顺序，并验证其他窗口及非第一响应者不输出。
- 这是AppKit窗口生命周期/协议输出验证，不等同人工切换应用、真实vim/tmux或所有窗口重挂载边界验收；整体目标未完成。

### 近期改动完整回归（2026-09-07）

- Performance XCTest 161 项：154 通过、7 项钥匙串用例按约定跳过、0 失败，132.684 秒。覆盖 R/INI 高亮、终端链接/拖选/鼠标报告/OSC8/焦点/Option 输入及重命名校验。日志 `/tmp/coflux-native-rename-full.log`；xcresult `/tmp/coflux-macos-093-build/Logs/Test/Test-Coflux-2026.09.07_22-40-09-+0800.xcresult`。
- 共享 Swift 客户端 71 项 Swift Testing + 3 项 XCTest 通过，日志 `/tmp/coflux-core-rename-full.log`。
- 原生产物审计通过：无 JS/HTML/WASM 资源，无 WebKit/JavaScriptCore 直接链接，许可文本一致，临时签名有效。审计 `/tmp/coflux-native-rename-audit.json`；许可校验 36 项远端依赖 + 4 项本地语法，160282 字节。审计产物含测试框架，不是正式分发产物。
- 开发入口使用内存凭据；未启用钥匙串测试。测试结束无 xcodebuild/CofluxPerformance/xctest 进程，隔离 fixture 恢复 1 daemon / 0 clients / 6 sessions。
- 全量逐屏视觉、人工键盘/IME/拖放交互、同数据 Web 性能对照及正式签名公证仍未完成；当前结果不能作为整个目标的完成证明。

### 终端链接协议与确认差异（2026-09-07）

- 对照 xterm 6.0.0 `OscLinkProvider.ts`：URL 解析后仅接受 HTTP/HTTPS，协议大小写不敏感。原生 `requestOpenLink` 已改为按小写协议匹配并拒绝缺失主机的地址。
- 通过注入打开回调验证真实 Coordinator 入口：普通、小写/大写/混合大小写 Web URL 可打开；file/javascript/mailto/相对路径/空主机不打开。未实际启动浏览器。终端测试 21 项通过，日志 `/tmp/coflux-terminal-url-scheme.log`。
- 新发现的未对齐项：Web xterm OSC8 默认 `defaultActivate` 会先弹确认，普通 WebLinksAddon 不弹；原生当前两者均直接打开。SwiftTerm `requestOpenLink` 回调没有显式/隐式标记，内部 `LinkMatch.isExplicit` 非公开，需要可靠获取点击链接类型后补原生确认，不应对全部普通链接一律增加确认。

### OSC 8 原生确认已接入（2026-09-07）

- 继续核查 SwiftTerm 公开 API 后，使用其 `characterIndex(for:)`（1.15 实现接受窗口坐标）与 `Terminal.link(at: .screen, mode: .explicitOnly)` 识别本次松开位置的显式目标。标记仅在当前鼠标回调期间存在，回调返回即清除。无需改依赖或引入 JS。
- Coordinator 仅对匹配的 OSC 8 目标显示 NSAlert 窗口 sheet；取消不打开，接受后交 NSWorkspace；普通文本 URL 保持直接打开。无所属窗口则取消显式链接打开。
- 真实 NSWindow 中注入鼠标事件，通过可控确认回调验证取消/接受与后续普通 URL 不受标记污染。终端测试 22 项通过、0 失败，日志 `/tmp/coflux-terminal-explicit-confirm.log`。没有启动浏览器，也没有要求系统权限。
- 上节“显式链接没有确认”的差异已修复；系统 sheet 的人工外观/键盘验收、滚动历史/自动换行/宽字符下点击位置的专项测试仍待完成，当前测试不等同于这些场景全覆盖。

### OSC 8 换行与历史点击验证（2026-09-07）

- 新增真实 NSWindow 鼠标事件测试：在行尾剩两格时开始中文 OSC8 链接，点击自动换行后的宽字符后半格；再写入 80 行并通过公开滚动接口回到历史，重复点击。两次均进入同一实际 URL 的确认回调，取消均未打开浏览器。
- `TerminalUploadTests` 23 项通过，0 失败，日志 `/tmp/coflux-terminal-wrapped-links.log`。此验证覆盖指定中文宽字符、自动换行与历史视口组合；不泛化为所有字体缩放、备用缓冲区及真实触控板行为已验证。系统确认 sheet 的人工外观/键盘验收仍未完成。

### 已退出终端的重启画面边界（2026-09-07）

- 对照Web `performActivation` 的 EXITED reset 路径，新增生产Coordinator+SwiftTerm组件回归：仅切回工作区保留旧输出且不启动；明确激活后进入启动状态、清除旧输出、将旧程序开启的鼠标报告模式恢复为off。
- 终端测试24项通过，0失败，日志 `/tmp/coflux-terminal-restart-reset.log`。客户端使用断开地址和内存凭据，测试结束释放Coordinator；未启动真实shell。该测试证明组件状态边界，不替代真实进程退出/重新启动的完整协议往返验收。
- 检查当前Web未发现终端搜索入口，本次未额外增加搜索功能。

### 真实终端重启输出验收（2026-09-07）

- 扩展现有 `testRealLoginTerminalSwitchAndReconnect`：第二终端输出拆分参数拼接的旧标记，exit后明确激活，等待新的sessionID与控制权；验证复用同一AppKit视图、旧标记消失，并通过真实新shell输出新标记。标记不直接出现在发送命令中，避免把PTY回显当执行成功。
- 真实集成场景通过，5.040秒、0失败，日志 `/tmp/coflux-real-restart-output.log`。同一场景仍覆盖切换/上传/接管/重连/resize，并在结束前关闭本测试创建的第二任务，验证视图与Coordinator释放。
- 结束后fixture恢复1daemon/0clients/6sessions，无CofluxPerformance/xctest/xcodebuild残留；内存凭据与临时签名。此前“真实退出与重启完整往返待验收”的这一具体项已有本轮证据，但不代表全部异常退出、断网重启或整体UI验收完成。

### 全套回归发现并修复 P2P 状态读取竞态（2026-09-07）

- 用户已明确登录页无需视觉一致，该范围调整写入plan093；工作台/终端/diff仍按原目标推进。
- 全套167项第一次因UnifiedDiffTests旧22pt累计高度预期失败，已改为50×21.5+4950×20=100075；第二次该项通过，但P2P通道打开出现偶发失败。全套日志 `/tmp/coflux-native-workbench-full.log`、`/tmp/coflux-native-workbench-full-fixed.log`，不能称全绿。
- P2P独立10轮40项曾全部通过，随后带诊断复现：`/tmp/coflux-p2p-diagnostics-final.log`记录失败瞬间state=1(open)、peerAvailable=1、timedOut=0。原循环while读一次readyState、guard又读一次，WebRTC线程在两次读取间从connecting变open时被guard错误拒绝。
- 修复为每轮只读取一次readyState，先接受open，再检查connecting与期限；授权、取消、移除后的validate仍保留。失败日志只记录状态/可用性/超时，无凭据。
- 修复后P2P组连续20轮80项通过，0失败，日志 `/tmp/coflux-p2p-state-race-fixed.log`。尚未完成此修复后的整套原生回归及真实P2P链路验证，下一步继续，不能据此宣布整体完成。

### P2P 竞态修复后完整回归（2026-09-07）

- Performance XCTest167项：160通过、7钥匙串用例按约定跳过、0失败，129.795秒。日志 `/tmp/coflux-native-p2p-race-full.log`。包含半点diff行高/大文件可见范围、快捷键面板、终端链接确认与真实重启输出等近期改动。
- 真实P2P终端/RPC/relay回退通过2.288秒；中心断线后的direct关闭与目录删除恢复通过1.305秒，P2P同场景通过1.197秒。P2P provider移除/取消/复用组也通过。
- 产物 `/tmp/coflux-p2p-race-final-audit.json` 审计通过：无JS/HTML/WASM资源，无WebKit/JavaScriptCore直接链接，许可文本一致，临时签名有效。产物包含测试框架，不是正式分发验收。
- 结束fixture为1daemon/0clients/6sessions，无App/测试/构建进程残留。该轮解决了此前全套失败；整体工作台视觉、实际IME/触控板/拖放、同数据Web性能比较及分发仍未完成。登录页按用户要求不作视觉一致性门槛。

### IME 连续组合与取消（2026-09-07）

- 生产配置终端经NSTextInputClient接口连续更新n/ni/你好😀，逐次验证markedRange与越界子串读取按UTF16长度截断、PTY无输出。unmark取消后仍无输出，下一轮再见提交只发送新文字。
- TerminalUploadTests25项通过，0失败，日志 `/tmp/coflux-ime-composition-cancel.log`。这是组件协议层验收；未驱动系统中文输入法，候选窗位置、真实键盘/焦点切换和多输入法体验仍需实际验收。

### 滚动条热点优化与集成待查（2026-09-07）

- 对隔离Performance测试进程做5秒/1ms sample，`/tmp/coflux-terminal-profile.sample.txt`。输出泵分支388个采样中384在feed/parse，其下100个采样进入滚动通知，63个进入updateScroller；这是调用树包含计数，不是总体CPU百分比。
- UploadTerminalView.feedOutput在每个4KiB输出块内合并scrolled回调，末尾调用super一次；缓冲区滚动不变，用户主动滚动即时处理。生产泵使用此入口，其他TerminalView继续原feed。
- 同8×5000行三轮186.70/180.64/177.37ms，最大心跳8.68/9.43/8.20ms；相对此前约281ms中位耗时下降约36%，仅该组件负载。日志 `/tmp/coflux-terminal-scroll-coalesced.log`。
- 7项性能+26项终端组件通过，含新增150行输出只通知最终滚动位置、主动滚动即时通知、历史视口不被新输出拉回底部。日志 `/tmp/coflux-terminal-scroll-validation.log`。
- 同次真实集成在第二终端创建/激活处超时，单独重跑在切回首终端等待控制权处超时；`/tmp/coflux-scroll-real-recheck.log`。尚未确定原因，不能称优化已完成集成验收。
- 使用隔离device-harness经relay停止并删除这两次运行创建的任务4344781a-3b58-4c39-915d-a954e72e91ed、dde896e1-8595-4565-9a54-9645d7c391f1；真实fixture恢复1daemon/0clients/6sessions，未改其他既有任务。下一步应定位控制权失败，必要时A/B回退此优化验证因果。

### 控制权超时定位与测试隔离（2026-09-07）

- A/B 恢复原始 feed 后仍在相同控制权等待点失败（`/tmp/coflux-scroll-control-baseline.log`）。诊断日志 `/tmp/coflux-control-diagnostic.log` 确认设备返回 `session logical client identity 已达上限 256`；当前标签、Coordinator 绑定和显式激活序号均正确。设备保留逻辑身份的上限是现有协议行为，未修改它。
- 真实集成改为每轮创建独立首终端，取得控制权后才发输入；按 task ID 找视图，输出用 UUID 拆参数生成，排除旧 snapshot 和输入回显。成功和失败时统一清理本轮同工作区新增任务，保留 fixture 原任务。
- 隔离后原始输出实现的完整切换/上传/重连/接管/重启用例通过，6.032 秒（`/tmp/coflux-isolated-control-baseline.log`）。生产输出泵已恢复滚动合并入口；优化版双轮回归结果随后补记。
- 本次清理 A/B 失败任务 `17ed8289-662f-4778-a7cc-462c1b174e19`。不将该修正解释为整体 App 性能验收通过。

- 优化入口恢复后的双轮回归通过：68 次执行（真实集成 2、性能 14、终端组件 52），0 失败；集成用例 6.054/5.696 秒，日志 `/tmp/coflux-scroll-isolated-validation.log`。此前控制权超时已由设备身份上限解释，独立会话复验支持保留滚动优化。
- `/tmp/coflux-scroll-final-audit.json` 通过：无 JS/HTML/WASM 资源，无 WebKit/JavaScriptCore 直接链接，许可一致且临时签名有效。仍为含测试框架的 Performance 产物，不代表正式分发签名/公证验收。

- 随后完整原生回归通过：169 项中 162 通过、7 项钥匙串测试按约定跳过、0 失败，134.344 秒；`/tmp/coflux-scroll-full-regression.log`。这次通过包含恢复后的滚动合并、独立会话集成、IME 组合取消用例；不等于人工输入法/触控板验收或仓库 TS/Rust 全套提交门通过。

### 2026-09-08：终端选区保留 ANSI 前景色

- Web 终端仅配置 selectionBackground；SwiftTerm 1.15.0 原生分支无条件覆盖选中文字/下划线/删除线前景色，之前的固定浅灰色会丢失 ANSI 颜色。
- 在 Vendor/SwiftTerm 固定上游 dd2fb8ac5b861e7bf617c872895e338f38165648，新增 macOS 默认 false 的 preservesSelectionForeground，App 显式开启。只有 AppleTerminalView 与 MacTerminalView 两个上游源码文件发生改变；补丁、原始/修改后源码 SHA-256 和原始 MIT LICENSE 均保留，许可脚本负责校验。不修改 SwiftPM 缓存。
- 34 项终端组件/性能回归通过，`/tmp/coflux-selection-render-fixed.log`。新增实际 AppKit 位图测试确认选中后 ANSI 红绿仍存在，关闭新选项并强制白色时两色消失；首次负向对照误统计 Emoji 自带色彩，已改为只包含可着色文字的样本，未放宽断言。
- 已查看 `/tmp/coflux-terminal-selection-colors.png`。`/tmp/coflux-selection-final-audit.json` 通过：无脚本资源/直接 Web 运行时链接、许可证一致、临时签名完整。当前为 Performance 测试产物。
- 仍需验收 ANSI 背景色与半透明选区的叠加、反色/装饰线组合及真实拖选；本轮不代表所有选区效果或完整 Web 视觉已完成。

- 本地 SwiftTerm 补丁后的完整原生回归通过：172 项中 165 通过、7 项钥匙串测试按约定跳过、0 失败，136.930 秒；日志 `/tmp/coflux-selection-full.log`，含 Dart、终端组件/性能、真实会话/重连/上传与 P2P 用例。未运行 TS/Rust 全部提交门，未提交；整体目标仍未完成。
