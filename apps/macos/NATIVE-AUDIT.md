# 本次原生实现审查

当前摘要更新：2026-09-08。后文日期条目为历史记录。范围为本次 `apps/macos`、它当前使用的 Swift 共享核心、实际构建依赖及 App 产物。
未查阅以前失败的原生化尝试。原则：整体 UI/交互与完整功能对齐，局部表现允许合理平台差异，优先原生实现。

| 部分 | 当前实现 | 判断 |
| --- | --- | --- |
| 工作台、侧栏、表单 | SwiftUI + AppKit | 原生；继续补功能和整体视觉，不为复刻 DOM 增加网页层 |
| 终端 | Ghostty 完整嵌入式核心，Metal/CoreText + external 字节 I/O | 原生；没有 JS、WebView 或本地 shell 转发 |
| 网络与协议 | Foundation URLSessionWebSocketTask、原生 WebRTC、SwiftProtobuf、Swift 状态机 | 原生；没有调用 TS client 或 Node 子进程 |
| 图片/文件上传 | FileHandle、ImageIO、CoreGraphics，后台准备数据 | 原生；沿用 Web 的预算参数不等于复用 Web 运行时 |
| Git 变更 | 请求设备执行 Git，Swift 解析，AppKit TextKit 连续文本与 SwiftUI 容器绘制 | 原生；设备执行 Git 是产品的远程工作区能力，不是本机 JS UI 包装 |
| 登录与凭证 | SwiftUI 表单；Debug/Performance 固定内存凭据，Release 使用 Security Keychain | 原生；开发入口不接受钥匙串环境开关 |
| 对话框、菜单、快捷键 | 原生 sheet/alert/contextMenu、AppKit 键盘事件 | 保留原生机制，修正文案、布局和行为；不要求系统弹窗像素级复刻网页 |
| Tooltip 与活动点阵 | 非激活NSPanel + SwiftUI / Canvas | 原生绘制；可保留产品视觉，无需移植网页渲染逻辑 |
| Agent 动画 | 当前 Web 插画导出静态矢量帧，Swift Task 播放 | 原生图片绘制；没有执行 SVG/JS 动画逻辑 |
| Lucide 图标 | 开发脚本导出静态 SVG，由 Asset Catalog 编译 | Node 只用于资源生成，App 不运行脚本 |
| 隔离联调脚本 | Node 启动测试服务器与临时设备 | 开发测试工具，不打包进 App |
| 高亮 | JavaScriptCore/Shiki 尝试已从源码撤掉，已接入原生 Tree-sitter（JS/TS/JSX/TSX、Rust、Python、Go、JSON、Bash、C、CSS、HTML、C++、Java、YAML、TOML、Swift、Markdown、Ruby、Lua、C#） | 唯一发现的运行时 JS 绕行；已纠正方向，其他语言与长 diff 性能仍待补齐 |

## 当前运行时复核（2026-09-08）

当前源码（apps/macos/Sources及packages/swift-client/Sources）未发现JavaScriptCore、WKWebView、JSContext、evaluateJavaScript、本地Process启动Node/shell等调用；Tree-sitter的node是语法树节点，JS语法解析不等于执行JS。端口预览通过NSWorkspace打开系统浏览器，是独立网页预览功能。

最新普通Performance包`/tmp/coflux-native-current/CofluxPerformance.app`的审计通过（`/tmp/coflux-native-current-audit.json`）：仅App和WebRTC两个Mach-O，无脚本资源或直接WebKit/JavaScriptCore链接，许可和临时签名完整。

**这不等于进程没有系统Web框架。** 对已登录且恢复终端的PID 26267读取vmmap后，sample的Binary Images进一步确认系统WebKit、WebCore和JavaScriptCore已加载。1秒空闲采样未出现相关执行栈。当前系统dyld共享缓存4085节点中，App直接依赖可达717节点的静态链接图未找到通向这些框架的路径；动态加载来源尚未定位，不能宣称不存在、不能归因具体组件，也不能由此断言应用在执行JS。

证据：`/tmp/coflux-native-current-runtime-audit.json`、`/tmp/coflux-native-system-dependency-paths.json`、`/tmp/coflux-native-current-loaded-images.json`及`/tmp/coflux-native-current-sample.txt`。源码、资源、静态链接和单时刻运行态各有覆盖边界，不能互相替代。未关闭或改变用户待验收窗口。

### 系统动态加载来源已定位

后续使用独立临时签名副本`/tmp/coflux-loader-audit/CofluxLoaderAudit.app`，仅添加DYLD_PRINT_LIBRARIES/DYLD_PRINT_APIS诊断环境；未登录，也未使用终端或高亮。`/tmp/coflux-loader-audit.log`第23796行开始dlopen系统WritingToolsUI，第36011行返回；WebKit、WebCore、JavaScriptCore等加载均发生在该调用内。当前macOS dyld依赖图给出路径：WritingToolsUI → GenerativeAssistantSettings → GenerativePartnerServiceUI → WebKit → JavaScriptCore。

结构化证据`/tmp/coflux-writing-tools-loader-evidence.json`包含路径和日志行号。因此上节“来源尚未定位”已由本次证据解决：本次观察到的系统Web框架来自系统写作工具依赖，不能归因于客户端终端/高亮执行JS。不为消除系统正常依赖而改变原生功能。诊断副本已退出，当前用户体验App PID26267仍保留；原产品源码未添加诊断开关。该结论限定于当前macOS和本次启动路径，不声称穷尽所有系统动态加载行为。

## 同类取舍与后续处理

- 不再把分词器结果或系统弹窗外观逐项完全相同作为约束；高亮用原生解析与近似主题配色。
- 终端现由 Ghostty 解析并通过 Metal 绘制；输出保留主线程分批与合计积压背压，尺寸变化后的首块会先同步 I/O resize。当前性能与内存证据见末尾 Ghostty 验收记录，早期 SwiftTerm 数字保留为历史基线。
- 变更页已保活；每个文件使用连续 NSTextView，TextKit 负责文本与选区，背景按脏区域绘制。跨行复制、高亮刷新保留选区、Tab 和末尾空行已有组件测试。文档准备已按每 64 行让出主线程并检查取消，完整准备后发布；单个超长行、最终文本存储替换及布局仍可能占用主线程；真实拖选/自动滚动、长 diff 的帧延迟/内存证据仍缺失。
- 共享设备路由已接入原生 direct/P2P/relay 竞争、提升与回退。2026-09-06 隔离中心和真实 Rust worker 联调通过原生 P2P 终端/Git，以及断开 P2P 后相同 PTY 回退 relay。Debug 默认禁用 Keychain/loopback 持久凭据，但可使用无持久凭据的 P2P。已补 session 心跳和指数退避并通过注入计时测试；中心短断的 15 秒 session 宽限已通过状态机和真实 P2P 输入联调；尚需真实网络静默丢包、跨网络打洞及更多竞争边界；真实本机网关 lease 自然到期已用纯内存密钥完成验证：45 秒后 RPC 拒绝、普通 catalog 可用、旧 lease 握手拒绝、新 lease 恢复目录 RPC；客户端路由自动恢复与跨网络故障仍需独立验收。

## 产物检查

源码扫描未发现剩余 JavaScriptCore/WebKit 导入或脚本执行桥。
审查发现旧 Debug App 仍包含已撤销尝试的 `diff-highlighter.js` 和 JavaScriptCore 链接；
源码删除不能证明成品干净。已完成 clean build：App 内全部 3 个 Mach-O 均无 JavaScriptCore/WebKit 直接链接，资源中无 JS/HTML/WASM。
原生高亮后续构建也将复查此条件。

## 最新源码复核（2026-09-06）

- 多文件 diff 的预布局按文件与视口的交集启停；只在可见性变化时更新集合，避免滚动坐标的每次变化写入整页状态。保留完整文本容器和选区能力。Performance 定向回归 14 项通过，日志 `/tmp/coflux-diff-visibility-transition.log`；使用临时签名，结束后未发现 Coflux 测试进程残留。此回归覆盖 TextKit 布局、颜色和选择行为，不证明生产页面多文件滚动的可见性接线或真实帧率，后两项仍待验收。

本次只扫描当前 apps/macos/Sources 与 packages/swift-client/Sources，未发现 JavaScriptCore、WKWebView、JSContext、evaluateJavaScript 或本机 Node 进程调用。此项仅是源码检查，不替代本轮产物与动态运行验收。


## CSS / HTML 原生高亮（2026-09-06）

- 接入 TreeSitterCSS / TreeSitterHTML 0.23.2，CSS、HTML/HTM 使用原生 C 解析器和上游查询；5 项高亮测试通过，覆盖语义色与 Unicode 范围。HTML 内嵌 JS/CSS 的语言注入及其他 Web 语言仍待补齐。
- 最新测试 App 扫描 13 个 Mach-O（含 XCTest 支持框架），无 JS/HTML/WASM 资源、无 WebKit/JavaScriptCore 直接链接，许可一致且临时签名完整。报告 `/tmp/coflux-macos-093-css-html-audit.json`；这是测试产物，不是可分发构建。

- 后续已接入 HTML script/style 正文的原生 JS/CSS/JSON 解析，6 项高亮测试通过；按 type 区分常用代码/数据类型，未知模板保持纯文本。HTML 属性中的内嵌语言及更多方言仍待补齐。

- 后续补入 C++/Java 原生解析，7 项高亮测试通过；最新测试产物审查见 `/tmp/coflux-macos-093-cpp-java-audit.json`。

- 新增 YAML/TOML 原生语法，8 项高亮测试通过；最新测试产物检查见 `/tmp/coflux-macos-093-yaml-toml-audit.json`，仍非正式分发验收。

- 新增 Swift 原生解析（锁定官方带生成文件提交），9 项高亮测试通过；测试产物审查见 `/tmp/coflux-macos-093-swift-grammar-audit.json`。

- Markdown 块/行内/已支持语言围栏已用 C 解析器接通，10 项高亮测试通过；字体样式、更多方言及逐屏视觉仍待验收。

- 解析已使用原生 20ms timeout/resume 时间片并在片间让出 actor/检查取消；11 项高亮测试验证续算完整性和长任务取消。查询匹配及结果映射的同步阶段、真实窗口帧率仍需评估。

- 查询收集、颜色转换和 Diff 行映射也已分批让出并检查取消，12 项高亮测试通过；原生单次匹配与排序仍是同步阶段，尚不能承诺固定取消延迟。

- 新增 Ruby/Lua 原生解析，13 项高亮测试通过；当前扩展名分派覆盖 35/61，详细缺口见 HIGHLIGHT-COVERAGE.md。

- 新增 C# 原生解析，14 项高亮测试通过；当前扩展名分派覆盖 36/61。

- Dockerfile 文件名与 Markdown 围栏已接入原生解析，15 项高亮测试通过；RUN 等 shell 子语言尚未补齐，整体目标未完成。

- 多泵输出改为按当前有积压终端数分摊 4ms 预算；8 终端组件样本最大心跳间隔从 35.125ms 降到 9.646ms，6 项输出测试通过。单次 feed 可超预算，仍不代表真实帧率。

- Makefile 文件名与围栏已接原生解析，配方正文由 Bash 解析；16 项高亮测试通过，复杂 Make 展开/自定义 shell 仍待验收。

- UTF-16 输入改为单次编码、32 KiB 分块读取，17 项高亮测试通过（含跨块代理对）；最新完整 Performance 回归 107 项中 100 通过、7 项钥匙串用例跳过、0 失败。日志 `/tmp/coflux-macos-093-latest-full.log`。真实 UI 与正式分发仍未完成，不能据此判定整体目标达成。

- Dockerfile shell_command 正文已使用原生 Bash 解析，18 项高亮测试通过，JSON exec 数组不走 shell；heredoc/自定义 SHELL 等仍有差距。测试产物审查见 `/tmp/coflux-macos-093-docker-shell-audit.json`。

- 当前完整回归 112 项中 105 通过、7 项钥匙串跳过、0 失败，日志 `/tmp/coflux-macos-current-full.log`；包含近期离线关闭与连接反馈改动。产物 13 个 Mach-O，无脚本资源/Web 运行时直接链接，许可及临时签名一致，报告 `/tmp/coflux-macos-current-audit.json`。仍非完整 UI 或正式分发验收。


### 2026-09-06：终端性能基准改用生产配置

- TerminalPerformanceTests现在通过NativeTerminal.configuredView创建终端，并设置相同1000×600尺寸；覆盖当前10000行历史、1.25行距与配色，不再测SwiftTerm默认500行配置。
- 6项通过（`/tmp/coflux-terminal-production-perf.log`）。8终端各5000行样本总耗时0.640秒、最大主actor心跳间隔10.244ms；单终端345016字节分7批，最大批4.257ms；持续8.48MB输出峰值待处理4704464字节、最大批4.543ms、总耗时0.928秒。
- 同步5000行对照主线程27.655ms。以上为组件输出与调度测量，不是实际窗口FPS，也不是严格跨版本性能对照；进程物理内存和能耗尚未测量。


### 2026-09-06：8终端内存样本

- 用Mach TASK_VM_INFO.phys_footprint读取当前测试进程；创建8个生产配置终端前29852704字节，分别消费5000行输出后202867864字节，增量173015160字节（约165MiB）。采样在提取buffer断言字符串之前，减少测试全文副本干扰。
- 同一轮最大主actor心跳间隔9.891ms、总耗时0.643秒，用例通过，日志 `/tmp/coflux-terminal-memory.log`。
- 这是整个测试进程的增量，包括终端对象、字符/字体缓存、历史与框架开销；不能视为纯历史内存，也不是Web进程内存对照。关闭后回收、满10000行和长期反复创建销毁尚未验证，不能据此宣称无泄漏或内存优化完成。


### 2026-09-06：终端重复创建释放

- 新测试连续3轮创建8个生产终端，每个输出5000行并验证末尾标记；释放视图和输出泵后，通过弱引用确认两类对象均已销毁。优化构建下显式withExtendedLifetime确保填充采样时视图存活。
- 有效日志 `/tmp/coflux-terminal-release-live.log`：基线29623328字节；第一轮填充202556568、释放后82445464；第二轮84903064/44369024；第三轮46777496/46793880。用例通过，1.765秒。
- 初次 `/tmp/coflux-terminal-release.log` 未显式延长对象生命期且无输出完成断言，填充内存异常偏低，不作性能结论依据。
- 证明本测试范围的TerminalView和TerminalOutputPump未被强引用滞留；物理内存未立即回到基线，且各轮受缓存、分配器及系统页面记账影响，不能据此宣称全App无泄漏。真实挂载窗口、会话Coordinator及长时间循环仍需另验。


## 2026-09-08：Ghostty 接入进行中

- 当前工作台已替换为 Ghostty，固定提交与可复现补丁见 `Ghostty/upstream.json` 和 `Ghostty/apply-remote-io.py`。前面的 SwiftTerm 数字属于历史基线。
- 首次完整 App 构建成功：`/tmp/coflux-ghostty-app-build.log`。C 接口和生产视图独立烟测分别通过：`/tmp/coflux-ghostty-smoke.log`、`/tmp/coflux-ghostty-surface-smoke.log`。
- 原生窗口 CUA 截图确认 Metal 正常呈现中文、emoji 和选区。像素测试直接读取 Ghostty 已呈现的 IOSurface，ANSI 选区保色及强制白字负向对照通过。
- 首轮迁移回归尚未全绿：鼠标报告优先级、宽字符链接和旧测试同步时序正在修正；不得将该轮称为接入验收完成。
- 同为八个终端各 5000 行，首轮处理约 14.2 ms，主线程心跳最大间隔约 6.24 ms；旧 SwiftTerm 基线约 177–187 ms。这是组件输出处理测量，不能等同整窗帧率或整体使用体验。
- Ghostty 第三方原文纳入 App notices，包含构建期依赖；许可锁定哈希见 `Ghostty/licenses.json`。


### Ghostty 时序修复后的验收记录

- 37 项终端与真实会话专项全部通过：`/tmp/coflux-ghostty-sync-tests.log`。
- 修复了初始 resize 还未在 I/O 线程生效时就解析输出的问题。独立探针在同一调用栈内读取第二行，修复前仍是旧列数下的 `x`，修复后立即为正确的 `文链接`；新增三种宽度的回归测试。
- 滚动位置改为直接读取真实终端状态，接入原生覆盖式滚动条。前述约 14 ms 的初版数字由本段数据取代：最终组件同负载约 52.6 ms，最大主线程心跳间隔约 11.34 ms，最长输出批次约 6.14 ms；仍不代表整窗帧率。
- 三轮八终端创建、填充、释放后，物理内存分别约 156/159/156 MB，视图和输出泵均释放。跨库内存比较仍需匹配可见窗口与 GPU 条件。
- `Vendor/SwiftTerm` 已移出工程保存到 `/tmp/coflux-swiftterm-retired-F3VLQh/SwiftTerm`。工程、运行时 Swift 源码和 notices 都使用 Ghostty。
- 最终包资源、直接链接、许可文本和临时签名检查通过：`/tmp/coflux-ghostty-final-audit.json`；这是 Performance 测试产物，不是正式签名、公证或发布验收。


### 全套原生回归

- `/tmp/coflux-ghostty-release-final.log`：176 项，169 通过、7 项钥匙串测试按配置跳过、0 失败，136.507 秒。包含真实设备会话、direct/P2P/relay、租约到期、高亮、UI、输入、像素、上传和性能回归。
- 新增持焦窗口移除后的释放测试；关闭时显式清理输入上下文、跟踪区域和宿主回调。真实视图释放检查对 AppKit 桥接数组使用自动释放池，避免临时引用干扰释放判断。
- 最终当前包审计：`/tmp/coflux-ghostty-release-audit.json`，资源、直接链接、许可和临时签名检查均通过。

### Ghostty 接入收尾验证

- 在上述完整回归之后补齐右键与其他按钮拖动转发，左右键按 NSEvent 事件类型识别。右键专项严格验证 SGR 按下 `<2;`、拖动 `<34;` 和松开 `m`，避免合成事件 buttonNumber 为 0 时误判。
- `/tmp/coflux-ghostty-input-verified.log`：最终 39 项终端、性能及真实登录/切换/重连专项全部通过，0 失败，14.341 秒，xcodebuild 明确返回 TEST SUCCEEDED。
- 最新产物审计 `/tmp/coflux-ghostty-final-current-audit.json` 通过：无 JS/HTML/WASM 资源，无 WebKit/JavaScriptCore 直接链接，许可一致、临时签名有效。许可检查通过，共 486798 字节。
- 验证结束后隔离 fixture 健康，1 daemon、0 clients、6 sessions；没有停止原有 fixture 服务。此次完成终端核心接入，不代表整体 Web 功能/UI 对齐或正式发布验收完成；钥匙串测试仍为明确跳过。


### Less 高亮接入

- 原生 C 语法加入 Less，语言扩展名覆盖提升到 55/61。39 项高亮回归全部通过，日志 `/tmp/coflux-less-highlight.log`。
- 最新产物审计 `/tmp/coflux-less-final-audit.json` 与许可/源码哈希检查通过。本轮为高亮定向回归，未重复全部网络/终端测试；没有访问钥匙串，也未做正式分发验收。


### Vue/Svelte 原生模板高亮

- Vue/Svelte 独立语法及模板内表达式、TS/JS 脚本、CSS/SCSS/Less 样式接入；扩展名覆盖提升至 57/61。保留原生实现，不执行组件代码。颜色差异与方言边界详见 HIGHLIGHT-COVERAGE.md。
- 最终 42 项高亮回归全通过：`/tmp/coflux-components-verified-highlight.log`。新增指令蓝色断言发现并修复查询优先级问题。
- 最新测试包审计 `/tmp/coflux-components-final-audit.json` 及许可/源码哈希检查通过；仍不是完整 UI/功能/性能或正式发布验收。


### PowerShell/Perl 原生高亮

- PowerShell 和 Perl 原生解析接入，扩展名覆盖 59/61；44 项高亮回归通过，日志 `/tmp/coflux-perl-powershell-highlight.log`。
- Perl 生成器真实输出 ABI 14，固定输入及独立重生成哈希一致；原始 scanner/头文件和独立 BSD 许可均已纳入清单。原始 C 窄化警告记录在 HIGHLIGHT-COVERAGE.md，未掩盖。
- 最终构建成功，`/tmp/coflux-perl-powershell-final-audit.json` 通过；当前 Performance App 已无测试框架，仅主程序/WebRTC 两个 Mach-O。源码/许可校验通过，不代表整体目标或正式分发完成。本轮没有访问钥匙串。


### Groovy/Zsh 与 61 种语言入口

- 最后两种原生语法接入，Web 61 种扩展名全部有对应入口。定向回归发现并修复 Groovy 尾随闭包调用漏色、Zsh 引号变量分类，以及 Markdown 代码正文继承围栏底色的问题。
- 47 项高亮测试全部通过：`/tmp/coflux-groovy-zsh-fixed-highlight.log`。生成解析器独立重建哈希一致，源码/许可检查通过。`/tmp/coflux-groovy-zsh-final-audit.json` 通过。
- 此为语言入口与所列语义的验收，未宣称全部方言、完整 UI/交互、性能和正式分发完成。本轮没有访问钥匙串。后续回到整体 UI 与真实交互验收。


### 导入向导实际交互修复

- 对照 Web 修复初始/撤销/过滤后的键盘选择、已导入目录不可进入，以及数字行 ID 导致跨目录残留旧行的问题；目录顺序与类型过滤一致。两项定向回归通过，`/tmp/coflux-import-identity-parity.log`。
- CUA 验证真实设备目录切换、已导入目录进入、重复导入禁用、无效路径错误与有效路径恢复；未提交导入操作。`/tmp/coflux-import-identity-audit.json` 通过。
- 本轮磁盘空间故障已通过清理本轮临时构建缓存恢复，既有本地容器运行环境及测试 Postgres 恢复，服务健康。登录挂起的超时恢复问题另记 VISUAL-PARITY.md，不能视为已解决。

### 登录断线与认证超时恢复

- 修复控制连接终止后仍保持 authenticating、界面永久加载的问题。认证从建连开始计时，10 秒无认证结果即回到可重试表单；普通入站不能解除认证期限。
- 超时先废弃连接代际、恢复状态，再异步关闭底层连接；迟到的建连结果或认证发送不能复活旧状态。显式密码登录停止旧 token 的自动重试，既有 token 的网络重连保持原有策略。
- 共享 Swift 全部 74 项测试通过（8 suites，2.890 秒，exit 0），日志 /tmp/coflux-auth-recovery-swift.log。新增断线后重试成功、无关入站后的认证超时、建连挂起及迟到连接关闭测试。原生集成验收另记后续结果。
- 原生真实登录/终端切换/重连集成通过：1 项，6.254 秒，0 失败，TEST SUCCEEDED，exit 0；日志 /tmp/coflux-auth-recovery-native.log。产物审计 /tmp/coflux-auth-recovery-audit.json 通过，本次为包含 XCTest 的 Performance 测试包。源码/许可检查通过，fixture 验证后恢复 1 daemon、0 clients、6 sessions。

### 活动终端标签滚动恢复

- 修复多标签时新建/切换后选中标签不可见。AppKit 真实滚动范围专项通过，CUA 窗口验证新建末尾标签与返回变更。见 VISUAL-PARITY.md。
- /tmp/coflux-selected-tab-scroll-audit.json 通过，当前为包含 XCTest 的 Performance 测试包，无脚本资源或 Web 运行时直接链接，许可匹配、临时签名完整。没有访问钥匙串。完整目标及仓库提交门仍未全部完成。

### 当前原生全套回归（2026-09-08）

- 登录认证恢复、活动标签滚动与鼠标选区测试加入后的当前 Performance 全套执行 189 项：182 通过、7 项钥匙串相关跳过、0 失败，144.958 秒，TEST SUCCEEDED，exit 0。日志 /tmp/coflux-native-current-full.log；xcresult 位于 /tmp/coflux-macos-093-build/Logs/Test/Test-Coflux-2026.09.08_02-35-09-+0800.xcresult。
- 覆盖当前所有原生测试组，包括真实 Git/目录/工作区、原生终端、direct/P2P/relay、租约到期恢复、diff、上传、Agent 状态及 47 项高亮。此结果不包含整库 TS/Rust/黑盒提交门、跨 NAT 实网、真实输入法候选或正式签名分发。
- /tmp/coflux-native-current-full-audit.json 通过；源码/许可检查通过。当前测试包含 XCTest，无脚本资源和 Web 运行时直接链接，许可匹配、临时签名完整。全套及后续 CUA 验收结束后 fixture 为 1 daemon、0 clients、6 sessions。
- 终端负载测试通过，但本轮属于全套功能回归中的单次测量，不能用其中 feed 耗时或总排空耗时证明端到端帧率优于 Web。

### 变更页错误恢复补验

- 离线错误提示去除内部 RPC 术语，增加真实断开/恢复控制连接后点击重试的集成用例，1 项通过，见 VISUAL-PARITY.md 与 /tmp/coflux-diff-retry.log。
- /tmp/coflux-diff-retry-audit.json 通过，仍为包含 XCTest 的 Performance 测试包。上一轮完整 189 项结果不包括本轮新增用例；本轮只运行相关新用例，不重复全套。
