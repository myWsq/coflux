# 2026-09-08：图片路径试验已撤回

上一节图片元数据优化的三轮交错测量未证明稳定收益，产品代码已恢复原路径。原始数据见Benchmarks/results-image-object-experiment-2026-09-08.json；先前试验记录仅为历史，不代表当前实现。

# Web / 原生同状态视觉核对

## 空工作区、中心断线（2026-09-06）

- Web：隔离浏览器上下文 native-parity，http://127.0.0.1:15273，直接使用当前 Workbench、Theme 与 LayerProvider；客户端只在内存注入快照，未登录服务器或修改服务端数据。
- 原生：ErrorToastLayoutTests 的 testRenderWorkbenchWithIsolatedSnapshot，生产 RootView + NSHostingView 离屏绘制，内存凭据及独立 UserDefaults。
- 两端同为 1360×860 逻辑尺寸、2 倍像素；数据为 coflux 项目、main/feature/native-client 工作区、开发 Mac 设备、0 任务。Web 用临时 matchMedia 覆盖模拟 standalone，使文案前缀为 ⌘；这不是 PWA 安装或键盘拦截验收。
- Web 截图已直接查看。截图工具拒绝本轮指定输出路径，故未保存 Web 图片；原生为 `/tmp/coflux-native-workbench-snapshot.png`。此处不是自动像素差分报告。

| 核对项 | 当前证据 / 处理 |
| --- | --- |
| 侧栏宽度、横幅/顶栏高度 | Web DOM 为 260、28、36px；原生使用对应 pt，画面分界基本对应 |
| 空工作区标题 | Web computed font-size=13px / weight=500；原生原为16pt，已改13pt medium |
| 分支、变更按钮 | Web computed font-size=13px；原生原为12pt，已改13pt |
| 说明正文与主按钮 | Web 正文12px、line-height20px、384px上限；按钮13px、28px高。两端位置和换行仍有细微差异，尚未逐项收敛 |
| 侧栏列表 | 项目、主工作区/分支、选中底色均可见；不同字体渲染与行间距仍待细查 |
| Web 底部裁切 | 当前 aside 自身860px高但起点y=28，设备行y=848、高28，超出视口；原生未裁切，不复制该缺陷 |
| 进度图形 | 原生 AppKit spinner 与 Web LoaderCircle 保留合理平台差异，不执行 JS 动画 |

修改后原生重新渲染并查看，相关3项测试通过，日志 `/tmp/coflux-workbench-type-parity.log`。该记录只覆盖这一静态状态，不证明整体 UI、弹窗、真实终端内容或交互完整对齐。

## 三个终端标签（2026-09-06）

- 同一隔离状态增加“终端 1”“运行单元测试与构建验证”“终端 3”，伪 RUNNING/session 标识，只在内存中存在。没有连接真实设备；原生另断言没有 session 控制权。等待视觉 grace 后比较，不能把截图当成终端连接成功。
- Web 实测：终端标签正文12px、图标12×12、标签28px高、关闭按钮20×20；三标签容器宽约92.95/192/94.90px。原生对应字号及尺寸一致，字体字宽造成少量位置差异仍在。
- Web 普通终端图标选中opacity=.9、未选中=.5；原生原为全亮，已修正。AgentGlyph 同步按 Web 源码的选中.9/未选中.7处理；Agent具体图形不在这份三标签快照中，需另验。
- 原生截图 `/tmp/coflux-native-tabs-snapshot.png`；渲染/尺寸组4项通过，日志 `/tmp/coflux-tabs-opacity.log`。离屏窗口未激活，原生光标不显示，不能据此判定其与浏览器有光标功能差异。悬浮关闭、拖动、溢出滚动和真实输入仍待验收。

## 十二个长标题标签（2026-09-06）

- 两端同一 1360×860 / 2x 状态，12 个标题均包含中文、英文、Emoji 和路径片段。新增 `testRenderWorkbenchWithOverflowingLongTerminalTabs`，只注入内存快照。
- Web DOM 实测标签208×28px、图标12×12px；标题省略，标签在横向容器中溢出。原生离屏截图中图标和省略文字正常，右侧同样裁切在滚动视口。
- 修正原生标签先画背景再限制宽度造成的选中底色偏窄：把208pt宽度限制移到背景之前。修正后重新查看 `/tmp/coflux-native-overflow-tabs-snapshot.png`，底色覆盖完整标签宽度；字体与分支区域仍有少量位置差异。
- 五项渲染/布局测试全部通过，日志 `/tmp/coflux-overflow-tabs-fixed.log`。日志签名身份为 `Sign to Run Locally`，测试后检查无残留 App / XCTest / codesign 进程。
- 本次未验证鼠标悬浮关闭按钮、实际滚动手势和视口外标签切换。Web 与原生当前均未显式实现选中标签自动滚入视口，不凭这一点单独判定原生功能缺失。

## 设备首次开终端空状态（2026-09-06）

- 在同一隔离 Web 页面选择「开发 Mac」，设置 online=true、无目录工作区；原生新测试 `testRenderDeviceEmptyState` 使用同一设备选择和内存快照。
- Web DOM 实测标题13px/500、正文12px/两行40px、正文上距6px、按钮100×28px。原生修正默认系统按钮为 WorkbenchPrimaryButtonStyle，并明确标题/正文字号、正文与按钮间距、错误提示间距。
- 原生实际截图 `/tmp/coflux-native-device-empty-snapshot.png` 已查看，标题、说明、新建按钮完整可见。字体度量与整体纵向位置仍存在细微差异，不能宣称像素一致。
- 渲染/布局组6项通过，日志 `/tmp/coflux-device-empty-parity.log`；测试后无残留 App / XCTest / 签名进程。这里只覆盖在线设备空态，未点击真实创建、未覆盖离线/失败/等待画面。

### 设备异常状态原生画面检查（2026-09-06）

已查看 `device-offline`、`device-creating`、`device-error` 三张离屏快照：离线说明与灰色按钮、等待 spinner 与灰色按钮、按钮下红色错误均完整可见，未见裁切。错误状态仍显示可用的新建按钮。Web 隔离页切换同一设备 online=true/false 的快照，离线按钮禁用状态另通过 DOM 核实；忙态与失败态仍需 Web 同状态对照。截图不能代替真实点击与错误重试验收。

### 设备等待与失败的 Web 同状态对照（2026-09-06）

- 隔离浏览器页临时替换 listDeviceDirectory 为受控 Promise，点击真实页面按钮进入等待，再返回相同 HOME 解析错误；未发设备请求，完成后恢复原方法。
- Web 忙态 disabled=true、opacity=.5、aria-busy=true，隐藏原内容并居中显示14px spinner。原生原先保留文字和左侧 spinner，现 WorkbenchPrimaryButtonStyle 新增 isLoading，保留内容占位并居中覆盖原生 ProgressView，设备/工作区空态创建按钮接入。
- 失败后 Web 按钮恢复 enabled，红字12px、上距12px；与原生同文案快照比较后确认布局语义对应，仍有字体度量与整体纵向位置的细微差异。
- 原生重渲染9项通过（`/tmp/coflux-primary-loading-parity.log`），等待画面已查看：居中与隐藏文字生效，但原生 spinner 在禁用按钮上对比度偏低，仍需调整。测试后无残留 App 进程。

## 首次项目引导与首快照等待（2026-09-06）

- 修正无选择时原生只有「选择一个工作区」的缺口：收到空项目快照后展示「从一个项目开始」、与 Web 相同说明以及导入按钮，按钮打开现有原生 importProject 对话框；有项目时显示选择工作区说明。
- 首快照未到时主区域仅显示原生加载进度，不把未加载判为空账号。新增 onboarding / awaiting-snapshot 离屏夹具并查看图片。
- folder-git-2 通过现有 sync-icons.mjs 从当前 Web Lucide 包导出为原生矢量资源，不在运行时执行 JS。Web 隔离页已确认同一空项目状态文案、13px标题。
- 11项渲染/布局测试通过（`/tmp/coflux-onboarding-final.log`）。按钮动作接到现有导入流程，但本轮未进行窗口点击验收。首快照未到时侧栏仍显示「还没有项目」，这处误导空态尚待修正。
- 等待按钮内 ProgressView 已强制浅色外观并独立启用，重新渲染后仍较灰，不能声称对比度问题已解决。

### 2026-09-06：加载状态复核

- 重新读取当前 SidebarView，已存在 snapshotRevision > 0 空态条件；最新 awaiting-snapshot 离屏图已确认侧栏不再显示「还没有项目」。此前待办已被当前代码与渲染证据消除，本轮未重复改侧栏。
- 主按钮改用 SwiftUI Circle/trim/stroke 实现 ProgressViewStyle，固定14pt、深色2pt圆环；按钮仍保留原生 Button 与 ProgressView 语义，不包含运行时 JS。响应 accessibilityReduceMotion，减弱动态效果时保留静态圆环。
- 最新 device-creating 离屏图确认深色圆环清晰可见且居中，替代 AppKit spinner 的低对比度结果。11项渲染/布局测试通过（`/tmp/coflux-native-ring.log`）。截图只证明静态可见性；真实窗口动画流畅度及系统减弱动态效果切换仍未实测。

## 登录失败与重试（2026-09-06）

- Web CredentialsForm 在失败后保留上层username/password状态；原生原先提交即清密码且LoginView在认证中被卸载。现密码改为RootView内存状态绑定，失败保留、成功清空，不写钥匙串或偏好。
- 认证中两端均隐藏表单显示加载，这一点与Web一致，不改成按钮原地等待。
- Web错误Banner实测背景rgba(255,158,151,.24)、圆角12、padding12/16、14px文字与circle-x；原生已改同结构并从Web Lucide导出图标。错误文案沿用协议层现有文本。
- 新增LoginFailure离屏画面并查看，12项渲染/布局测试通过（`/tmp/coflux-login-parity.log`）。密码重试为状态生命周期修正，真实键盘输入/失败再提交/成功清空仍需窗口交互验证，不能用静态截图代替。
- Web隔离注入host最初未设置高度，登录壳按内容高度布局导致靠上；已把测试host设100vh，勿据此前注入环境截图把原生居中布局改错。输入焦点差异仍受离屏非key window限制。原生禁用登录按钮比Web更暗，尚待修正。

### 登录按钮禁用色（2026-09-06）

- Web实测按钮336×32px、底色#ebebeb、前景#171717、禁用opacity=.5。原生移除手写灰色底与plain样式，复用WorkbenchPrimaryButtonStyle，新增height参数默认28、登录指定32。
- 最新登录失败截图确认底色已从过暗恢复；12项渲染/布局回归通过（`/tmp/coflux-login-button.log`）。不改变禁用条件和提交动作。该截图仍不代替真实键盘重试验收。


### 2026-09-06：diff 自定义字阶对齐

- 依据当前 apps/web/src/index.css，text-xs实际11px、text-2xs实际10px。原生diff此前正文/文件名12pt、hunk/文件计数11pt，均大一档。
- 正文、增删标记和文件名改为11pt；hunk标题、二进制标签及文件计数改为10pt。纯重命名说明改10pt并对齐水平12/垂直8的内边距。
- DiffTextDocumentTests 14项通过，日志 `/tmp/coflux-diff-web-fonts.log`；包含Tab宽度、固定行高、选择复制、高亮回填和实际绘制。已查看更新后的临时高亮组件图，文字完整可见。
- 这是按Web源码字阶的修正与组件验证；完整diff页逐屏对照、字体度量及真实滚动仍待验收。hunk行高暂保留原生22pt，Web10px×1.35+8px为21.5px，半点差异尚未处理。


### 2026-09-06：真实 Git diff 整页离屏渲染

- NativeIntegrationTests.testChangesPageRendersRealGitFile 在隔离fixture主工作区以随机文件名创建27行TypeScript，真实Git/设备RPC加载ChangesView，等待原生高亮完成后通过NSHostingView/cacheDisplay保存整页；最终删除该测试文件。用例通过，日志 `/tmp/coflux-diff-real-page.log`。
- 图 `.coflux-dev/macos/changes-real-git.png` 已查看：文件头、hunk、27行新增背景与符号、中文/emoji/高亮正文完整。窗口不显示，无钥匙串凭据。
- 夹具目前把创建文件前的workspace值传给页面，因此顶部总计显示旧0；这不是总计功能验收。后续需等待真实workspace更新再截取，并加入删除行与长行横滚场景。
- 页面正文上下存在横向ScrollView高度额外12pt造成的留白，Web正文容器未设置对应padding，待同状态核对修正；当前尚不能宣称完整diff视觉对齐或真实滚动通过。


### 2026-09-06：diff 正文留白与计数夹具修正

- 移除横向ScrollView外层额外12pt高度，按正文确定行高布局，避免上下各出现多余空隙。
- 真实Git渲染测试等待设备推送新增27行的workspace状态，并使用更新后的值构建页面。定向用例通过（`/tmp/coflux-diff-spacing.log`，2.292秒），最新 `.coflux-dev/macos/changes-real-git.png` 已查看：顶部和文件头均+27/−0，hunk紧接文件头分隔线，末行可见。
- 该图仍是单文件新增场景。长行横滚、系统始终显示滚动条、删除行、多文件滚动及Web同状态逐屏仍需验证。


### 2026-09-06：真实 Git 长行与横向定位

- 真实Git夹具增加超宽中文字符串和末尾RIGHT_EDGE，共28行；验证文本宽度超过窗口宽度，调用原生scrollRangeToVisible后visibleRect.minX>0、选区不变、开头Unicode原文仍在。
- 定向测试通过（`/tmp/coflux-diff-long-line.log`，2.514秒）。已查看 `.coflux-dev/macos/changes-real-git-right-edge.png`，末尾标记完整可见且被选中，文件头仍固定在文件容器宽度内，顶部/文件计数均+28。
- 此项验证完整页面的程序化横向定位与文档保留；不代表真实触控板/鼠标横滚、始终显示滚动条或多文件交互已经验收。测试文件已由清理步骤删除。


### 2026-09-06：Web同状态diff工具栏对照

- 浏览器隔离页使用当前ChangesView组件与28行同内容Git补丁，模拟exec仅供Web渲染，未写服务器；容器1040×780。DOM实测工具栏45px、文件头30.84375px、hunk21.5px、正文20px。
- 原生工具栏此前36pt，改45pt并加入1pt底部分隔线；增删总计改等宽数字并以4pt间隔分组，对应Web单个计数组。
- 原生真实Git页面及长行定位定向回归通过，日志 `/tmp/coflux-diff-toolbar-parity.log`。尚有hunk半点高度、变量高亮颜色及系统字体度量差异；完整diff对齐仍未完成。


### 2026-09-06：const 声明名配色

- Web同状态diff图中greeting/value等const声明名为蓝色，原生此前为默认前景。JS/JSX/TS/TSX配置现以前置原生Tree-sitter查询捕获const的直接identifier绑定为constant，保留后续上游函数等具体规则的覆盖顺序；不改动下载的上游资源。
- 新用例覆盖4种扩展名、Unicode前缀、字符串、普通const、箭头函数绑定及let不误染色；高亮组23项通过（`/tmp/coflux-const-highlight.log`）。不引入JS运行时。
- 此修正针对已实测差异；解构绑定、使用点颜色与其他语言仍需分别对照，不能推定所有token与Web完全一致。


### 2026-09-06：终端基础颜色与历史容量

- Web terminal-pane.tsx前景/光标#e4e4e4、选择背景#3a3a3a88、scrollback10000；原生前景此前#d4d4d4且选择颜色未配置，scrollback沿用SwiftTerm默认500。
- 生产创建路径提取为NativeTerminal.configuredView，前景/光标/选择背景按Web配置，历史容量设10000；ANSI white仍为#d4d4d4，不把普通前景和ANSI白色混为一项。
- 新测试通过生产创建路径输入11000行，确认900行后首条仍在、超过容量后首条淘汰且最新条仍在。TerminalUploadTests10项通过（`/tmp/coflux-terminal-history-parity.log`）。容量增加会保留更多本地历史，实际多终端内存仍需测量。
- 当前SwiftTerm选择前景是统一NSColor，现设#e4e4e4保证暗背景可读；Web未设置selectionForeground，仍保留各ANSI字色，这处差异未解决。行高和整屏终端视觉仍待对照。


### 2026-09-06：终端文字栅格密度

- 当前浏览器隔离测量（同Web fontFamily/fontSize12/lineHeight1.25、DPR2）：xterm css cell7.225×17.5px。临时测量实例完成后已dispose并移除DOM。
- 本机原生12pt等宽字体CoreText ascent11.6015625、descent2.53125、leading0，SwiftTerm默认ceil得到15pt，显著偏密。现lineSpacing设1.25，按SwiftTerm算法ceil得到18pt。
- 生产终端创建路径600pt高得到33行，TerminalUploadTests10项通过（`/tmp/coflux-terminal-line-spacing.log`），历史/粘贴/IME相关既有回归保持通过。
- SwiftTerm整点取整造成与Web17.5px有0.5pt差异，本次未修改第三方排版算法。真实窗口截图、窗口缩放后PTY尺寸以及其他屏幕缩放仍需验收。


### 2026-09-06：ANSI高亮色对齐

- 在当前Web依赖xterm实例中应用terminal-pane.tsx主题并读取实际16色：高亮色9至15为ef2929/8ae234/fce94f/729fcf/ad7fa8/34e2e2/eeeeec；原生此前重复使用普通色且亮白为ffffff。
- 原生16色调色板改用该实际值。新增OSC 4颜色查询测试，逐个核验生产终端返回的16位RGB颜色，避免只断言配置常量。
- TerminalUploadTests11项通过，日志 `/tmp/coflux-terminal-ansi-parity.log`。临时Web测量实例已销毁；这是颜色协议值验证，整屏渲染及选区保留ANSI字色仍待验收。


### 2026-09-06：终端16色实际绘制对照

- 新生产终端离屏快照 `/tmp/coflux-terminal-palette.png` 已生成并查看，包含普通/高亮16色、中文emoji、粗体、下划线与24位真彩色；用例通过（`/tmp/coflux-terminal-palette-render.log`）。
- 浏览器临时xterm以相同文本、主题、字号与行距实际绘制并截图；检查确认颜色层级与文本内容对应。测量结束已销毁实例和临时DOM。
- 仍有原生字形栅格取整带来的横向宽度与行高差异，块字符绘制也有实现差别；当前对照未包含选择高亮、动态光标或窗口交互，不能视为整个终端逐像素验收。


### 2026-09-07：终端链接点击与拖选

- 当前Web使用WebLinksAddon默认普通点击打开；SwiftTerm默认hoverWithModifier要求Command。生产配置改为hover，普通点击可触发原生链接delegate，仍由Coordinator限制http/https。
- AppKit组件测试发现SwiftTerm拖选URL后mouseUp仍触发打开，且点击路径不检查linkReporting。UploadTerminalView记录拖动，只在拖动结束时临时使用要求Command的模式并将该松开事件的Command移除，保留其他修饰键及基类鼠标收尾，随后恢复模式。
- 15项终端测试通过 `/tmp/coflux-terminal-link-selection.log`，新增真实NSWindow中直接调用AppKit mouseDown/mouseDragged/mouseUp验证无Command点击识别URL、拖选不重复打开；delegate记录URL，不实际打开外部网站。
- 此为AppKit组件行为证据，不等同人工鼠标、终端鼠标报告模式、OSC8和全部链接边界验收；总体目标仍未完成。


### 2026-09-07：链接不能吞掉终端鼠标报告

- 新NSWindow组件测试用实际DECSET 1000/1006启用VT200/SGR鼠标报告，点击URL位置；修复前只收到按下帧ESC[<0;5;1M，松开被链接打开吞掉（两条断言失败）。
- UploadTerminalView在allowMouseReporting且鼠标模式非off、未被Shift绕过时，也抑制该次mouseUp链接激活；仍调用基类以发送终端松开报告。保留普通模式点击链接、拖动不打开的已有行为。
- 16项终端测试通过 `/tmp/coflux-mouse-report-fixed.log`，验证URL上的按下/松开报告及无链接回调。使用临时签名，不打开外部网页。
- 本次是组件协议输出证据，尚未覆盖人工vim/tmux、全部鼠标模式、Shift捕获扩展及OSC8边界，不代表整体目标完成。


### 2026-09-07：OSC8 与 Shift 绕过报告

- 新原生窗口测试输入OSC8序列，显示文字CLICK HERE与目标URL不同；普通点击delegate收到实际URL。开启1000/1006后不打开显式链接，鼠标松开报告仍发送；Shift点击默认绕过报告并触发链接。
- 17项终端测试通过 `/tmp/coflux-terminal-osc8-shift.log`，包括普通URL点击、拖动抑制、SGR报告及OSC8/Shift。测试delegate仅记录链接，不启动浏览器。
- 本轮生产代码未改；新增证据验证前一轮鼠标修复没有破坏上述交互。人工终端应用、Shift捕获扩展、跨行URL/OSC8和完整交互仍待验收。


### 2026-09-07：Option 字符输入与基础键盘协议

- 当前Web未覆盖xterm的macOptionIsMeta=false默认值；SwiftTerm默认optionAsMetaKey=true，Option字母会变为ESC序列。生产configuredView现设false，保留macOS字符层。
- `/tmp/coflux-option-input.log` 19项终端测试通过，真实AppKit keyDown/interpretKeyEvents验证Option+F字符ƒ原样发送，不变为ESC+f。
- 追加Ctrl+C、普通左右键和DECSET1应用光标模式字节验证后20项通过 `/tmp/coflux-keyboard-parity.log`；普通左键为ESC[D，应用模式为ESC OD。
- 未验证全部Option方向/删除键、不同键盘布局、死键、Kitty键盘协商和人工IME流程；这组结果不代替完整终端交互与总体目标验收。


### 2026-09-07：删除确认信息对齐

- 当前Web workbench.tsx对项目、工作区、设备分别说明删除范围。原生原先通用提示遗漏主仓库保留、分支保留及重新登记设备等信息。
- WorkbenchDialogs现逐项使用Web相同标题/描述/按钮；Sidebar两个工作区删除入口传branch，避免将自定义显示名误写成分支名。
- Performance临时签名构建通过 `/tmp/coflux-removal-copy-build.log`。本轮仅展示文案修改，没有实际删除操作；弹窗完整视觉/键盘和删除后服务器行为仍按既有验收清单核对，不能由构建通过推断完成。

### 重命名入口校验与提示对齐（2026-09-07）

- 对照 Web `dialogs.tsx`：设备和项目名称统一 trim 后禁空，工作区允许清空恢复分支名；校验放在 `WorkbenchModel.rename`，回车不能绕过按钮禁用。
- 补齐设备/项目标题、三种说明和输入提示、自动聚焦；工作区显示名等于分支时输入框初始留空。
- Performance 临时签名、内存凭据下 `WorkbenchStateTests` 14 项通过，0 失败，日志 `/tmp/coflux-rename-validation.log`。新增验证空设备/项目名称不进入发送路径，空工作区名称仍进入发送路径且离线时保留对话框。
- 本轮未验证真实窗口回车/聚焦、线上重命名往返及逐像素外观；不代表整体 UI 验收完成。

### 终端普通点击的多余重绘（2026-09-07）

- SwiftTerm 1.15 的 `linkHighlightMode.didSet` 无同值保护，每次赋值都会清除链接高亮、更新跟踪并请求全屏重绘。原生鼠标松开处理原先无条件恢复模式，使普通点击也触发这一额外路径。
- 现仅在拖选或鼠标报告需要临时切换模式时设置/恢复，且避免同值赋值。普通点击保留基类处理，拖选不打开链接、鼠标报告不吞松开帧的行为保持。
- `TerminalUploadTests` 20 项通过，0 失败；日志 `/tmp/coflux-terminal-click-redraw.log`。验证包括普通URL、拖选、OSC8、SGR鼠标报告及Shift绕过。属于消除可确认的冗余调用，尚无FPS或CPU收益测量。

### 创建工作区等待状态字阶（2026-09-07）

- Web `text-base/text-sm` 实际来自项目主题 13px/12px，原生等待状态标题原为16pt且正文继承13pt。现分别改为13/12，并对齐图标后16、说明前6、内容最大宽384的布局参数。
- 新增隔离等待状态渲染场景，通过 `ErrorToastLayoutTests/testRenderPendingWorkspace` 生成 `/tmp/coflux-native-pending-workspace-snapshot.png`，已查看图像，文字完整、等待内容居中且未裁切。日志 `/tmp/coflux-pending-workspace-layout.log`。
- 快照直接注入pending状态，无真实工作区创建；连接未启动，因此顶部显示断线横幅。按源码主题核对参数，不代表与同状态Web截图的像素对比已完成。

### 等待状态浏览器样式实测（2026-09-07）

- 在隔离浏览器 `http://127.0.0.1:15273/` 的实际 coflux 主题内挂载同 class 的等待状态样式片段，读 computed style：标题13px/行高18.2px/上距16px；正文12px/行高20px/上距6px；最大宽384px。片段测量后已移除，未发送创建命令。
- computed font-family 为 Figtree + 系统候选，但 document.fonts 无加载字体且网络无字体资源；这不能证明真实使用 Figtree，不能据此引入字体文件。需另查实际字形字体或直接量测文字宽度。
- 浏览器resize外窗1360×860后实际viewport1360×817；不得与原生1360×860快照直接按全图坐标比较。后续视觉对照应对齐实际viewport。
- 这次实测是隔离样式片段，不是完整React创建流程或同状态截图验收。原生lineSpacing与Web固定20px行高的精确对应仍需测量。

### 快捷键帮助面板（2026-09-07）

- 按 Web `shortcutRows(true)` 对齐七行顺序和说明，拆开上/下一个终端；保留原生纯Command前缀。增加独立键帽（11pt等宽、20pt高/最小宽、4pt键间距、主题muted底色#1b1b1a），右上角关闭并保留Escape关闭。
- 渲染与工作台状态15项定向测试通过，日志 `/tmp/coflux-shortcut-help.log`；底色修正后单独渲染测试通过 `/tmp/coflux-shortcut-help-color.log`。已查看最终 `/tmp/coflux-native-shortcut-help.png`，七行和关闭图标完整显示，键帽右对齐无裁切。
- 该离屏渲染不证明真实sheet的Escape/Command+/事件派发及Web像素级外观完全一致；现有快捷键状态测试只覆盖模型行为。

### Hunk 标题半点行高对齐（2026-09-07）

- Web真实主题隔离元素实测：hunk标题10px、行高13.5px、上下padding各4px，总高度21.5px。原生原为22pt，现改为21.5pt；代码行仍20pt。`DiffTextMetrics`统一提供行高，TextKit段落与DiffRowLayout共用，避免多hunk累计偏差。
- 14项DiffTextDocumentTests通过，日志 `/tmp/coflux-diff-half-point.log`；实际TextKit usedRect、尾部空行起点与选区切换验证半点布局不会被取整。
- 两项真实Git页面/离屏长文件集成通过，日志 `/tmp/coflux-diff-half-point-integration.log`；fixture恢复1daemon/0clients/6sessions。此前hunk半点高度差已修复，完整逐屏视觉及性能对比仍未完成。

### 同负载终端组件初测（2026-09-07）

- 修正原生并发基准结束点：输出队列排空后立即停止计时，再做buffer全文断言；原先elapsed包含了断言，不能直接对比。原生日志 `/tmp/coflux-terminal-comparable-native.log`。
- 两端8个未挂窗口/DOM的终端，131×33网格、10000历史行；每终端5000行相同ANSI绿色中文/emoji/ASCII文本，再附COMPLETE-i标记，共2280096 UTF8字节。均验证8个buffer有各自完成标记且无串流。构建/实例创建不计入，输入构造计入。
- 单次原生生产TerminalOutputPump约289.84ms，2ms主actor心跳最大间隔10.79ms、38次；进程footprint增量173031544字节（不与浏览器堆内存比较）。
- 浏览器xterm6.0通过公开write回调计时，首次119.1ms但任务期间心跳未执行，因此不能把最大间隔0当成流畅。修正测量为负载前启动心跳、完成后再等一个timer回合，第二次110.1ms、最大心跳间隔110.2ms、1次。
- 当前只说明该组件负载下原生分批处理吞吐较慢但主线程让出更频繁。两端调度路径不同；Web未经过完整生产controller/网络分帧，两端无可见渲染、无FPS/切换/启动测量，且仅少量样本，不能推断原生整体更快或替代完整性能验收。

### 终端组件预热与分块敏感性（2026-09-07）

- Web生产consumer直接terminal.write(data)，store也同步交付；xterm WriteBuffer在写入块之间使用12ms预算。不能把上一轮单个大块测试当成所有网络分帧场景。
- 同样8×5000行、131×33、10000历史、2280096字节。在预热的同一浏览器中轮换4KiB/64KiB/整终端一块各5轮，结果如下（毫秒，中位数）：

| 路径 | 完成耗时 | 最大心跳间隔的中位数 |
| --- | ---: | ---: |
| Web 4KiB块 | 48.5 | 42.6 |
| Web 64KiB块 | 56.6 | 50.0 |
| Web 整终端一块 | 56.3 | 51.9 |
| 原生生产分批泵，5轮 | 280.5 | 10.9 |

- 原生原始耗时384.08/280.48/282.60/254.30/251.41ms，最大心跳间隔44.63/9.99/8.98/10.85/11.40ms；第一轮也有明显抖动，不能把4ms调度预算当硬上限。日志 `/tmp/coflux-terminal-native-repeat.log`，5轮全部通过输出独立性断言。
- Web三种块大小首轮均验证输出标记与不串流，后续15轮为计时采样。各轮均dispose实例并清timer。该结果仍为未挂载组件、同一JS回合同步排队突发数据，未包含网络到达间隔、可见渲染、生产onOutput副作用或用户交互。Web预热后比首轮明显更快，原生吞吐差距仍在；下一步应定位原生耗时并测可见工作台，不能宣称原生整体更快。

### 原生输出处理耗时拆分（2026-09-07）

- TerminalOutputPump复用既有每批起止计时，累计totalDrainMS；性能测试输出合计处理耗时、批数及单批最大值。该值包含feed/队列推进/预算判断，不等于纯解析器CPU时间；不包含批次开头的活动泵扫描。
- 同8×5000行三轮全部通过：总耗时309.57/264.69/281.27ms，批次内部累计275.98/255.35/266.77ms，占约89%/96%/95%；批数454/402/415，最长批次1.49/1.55/1.47ms。日志 `/tmp/coflux-terminal-drain-cost.log`。
- 证据指向处理路径内部为主要成本，不能把差距简单归咎于主队列等待，也不能靠放大主线程预算宣称性能优化。SwiftTerm feed包含解析、搜索失效、选区和显示调度，后续需细分热点；当前未据此改变分批预算或渲染路径。

### 2026-09-08：导入项目空态与搜索反馈

- 原生补无在线设备的登记入口、无匹配设备提示、空目录/无匹配文件夹/读取中提示；设备与文件夹过滤按 Web 去首尾空格，底栏补键盘提示。
- 隔离 Web 挂载真实 ImportProjectWizard + neutral Theme/LayerProvider，不接真实导入接口。实测 dialog 520×420、底色 rgb(38,38,38)、header 44 高、无设备图标 y=44、标题13px、正文12px、主按钮32px；原生据此从居中空态改顶部排列，补步骤标签、对应底色/按钮尺寸。Web 主题仅工具提示存在 App 自定义覆盖，与本次弹窗无关；临时挂载已移除。
- 原生离线快照经 NativeSearchField 文本变更桥接验证无匹配→带空格匹配，Esc 关闭；`/tmp/coflux-import-layout-parity.log` 用例通过。已查看 `/tmp/coflux-import-no-devices.png`、`/tmp/coflux-import-no-match.png`、`/tmp/coflux-import-matched.png`。后两图初版反馈已验收，最终顶部空态另复核。
- 此轮验证设备选择页；目录空态/读取中的真实网络交互及所有弹窗完整视觉仍待验收。未运行整套提交门，目标未完成。


## 2026-09-08：Ghostty 终端替换

- 工作台现使用 Ghostty Metal/CoreText 原生表面，保留 12pt、1.25 行高、Web 16 色、前景/背景/光标颜色与 10000 行历史。配置随包分发，不加载用户 Ghostty 配置。
- 选区文字使用 `cell-foreground`，实际 IOSurface 像素验证保留 ANSI 红绿文字；选区底色使用 Web 默认暗背景上的合成色 `#242424`，带独立单元格背景色的选区仍可能存在原生差异。
- Ghostty 保留 17.5pt 行高，600pt 对应 34 行；此前 SwiftTerm 向上取整的 18pt/33 行断言已改为实际 Web 行高目标。
- 链接保留普通点击、OSC8 确认、拖选不打开、鼠标报告与 Shift 绕过、折行宽字符后半格和历史视口行为，均纳入原生测试。
- 原生覆盖式滚动条、聚焦、跨屏内容缩放、输入法提交、快捷键、上传粘贴和会话保活继续由工作台集成层管理。初始尺寸先于输出解析，快照替换重建表面。
- 独立窗口已通过 CUA 查看真实绘制；调色板和选区像素测试读取 Ghostty 已呈现的 IOSurface。


### 导入向导键盘、目录身份与恢复（2026-09-08）

- CUA 操作隔离 Web（15273）确认：初始 Enter 不选择设备，Down 后才进入；切换/过滤后无默认行选择。原生改为 -1 初始选择，首行 Up 可撤销选择，过滤/目录/隐藏项变化清除选择；悬停行同步键盘选择。
- 修复原生禁用已导入目录导致无法浏览其子目录的问题：行仍显示“已导入”但允许进入，只在提交当前目录时防止重复导入。目录只接受与 Web 相同的 DIR 类型，并保留设备返回顺序；设备行副文案改为 Web 的“设备”，主机名仍可搜索。
- CUA 实机发现更关键的旧行复用错误：路径已切到 .coflux-dev，但旧 Applications 行仍残留。目录行/键盘滚动目标改用完整路径、设备行改用 daemon ID，消除跨目录复用数字索引导致的错误；实机重跑确认 .coflux-dev 正确显示 coflux-native-ui-import-6rmyta7h、ghostty、macos。
- CUA 点击已导入的隔离项目成功进入，空目录提示正确、重复导入按钮禁用；输入不存在路径显示“路径越界或不存在”，再改回有效目录，错误清除、列表恢复。只读浏览，没有新导入、删除或修改文件。
- 两项原生导入测试通过，日志 `/tmp/coflux-import-identity-parity.log`，0 失败，1.550 秒；包括初始 Enter、Down/Up 撤销选择、过滤重置和明确选择后进入。测试与真实 CUA 行为互为补充，不代表全部弹窗/IME/完整视觉验收。
- 本轮环境曾因磁盘不足导致 OrbStack I/O 停止：清理本轮已校验的重复重生成目录及 Ghostty .zig-cache，保留源码/最终框架/日志；恢复既有 OrbStack 服务和独立 coflux-postgres 容器后，19873 health 返回 ok=true。未使用残留 Supabase 数据库。正式分发、整体验收仍未完成。
- 环境故障期间原生登录停留加载，恢复数据库后需重启 App 再登录；登录请求超时/错误恢复仍需独立处理，不把环境恢复视为该行为已修复。

### 登录加载失败恢复

- 已修复前述环境故障暴露的永久加载：密码登录断线或认证总时限 10 秒到期后显示网络/超时错误，并回到可重试登录表单。登录布局不作逐像素对齐要求。
- 确定性共享层测试覆盖断线重试、无关入站不能取消认证超时、建连挂起及迟到连接，完整共享测试 74 项通过。原生真实错误密码重试与登录后终端切换/重连集成 1 项通过，见 /tmp/coflux-auth-recovery-native.log。
- 本轮未通过停数据库重演故障，也未新增 CUA 手工超时验收；认证时限由可控时钟测试验证。完整 UI/交互和正式分发验收仍继续。

### 活动终端标签可见性（2026-09-08）

- 实际 CUA 窗口发现：长标签列表末尾新建终端后，终端已打开，但活动标签被裁在右侧。当前 Web 横向标签容器没有显式自动跟随逻辑；本次作为原生使用体验改进，保留既有布局与样式。
- 原生 ScrollViewReader 使用 ForEach 的真实任务 ID，选择变化后滚动目标进入可见范围；覆盖变更标签、新建占位和初次恢复。终端输出/标题变化不触发重新跟随，保留用户手动滚动。
- AppKit 实际滚动范围测试覆盖末尾标签、变更、快捷键循环、创建占位和重新显示工作台。初版附加 ID 目标无法定位，测试检出；统一为真实任务 ID 后通过：1 项，1.075 秒，0 失败，TEST SUCCEEDED，exit 0。日志 /tmp/coflux-selected-tab-scroll.log。
- 最终构建经 CUA 验证：新建“终端 20”后高亮标签完整可见，切到“变更”后左端标签可见。两次本轮创建的终端均停止并删除，原有 fixture 不重置；退出后 health 为 1 daemon、0 clients、6 sessions。
- 此为标签可见性证据，不覆盖完整 IME、拖放、跨网络及整窗性能验收。

### 真实终端输入、滚动与选区（2026-09-08）

- CUA 在隔离真实 PTY 中粘贴含中文与 emoji 的 printf 命令，窗口确认参数完整、回车后只执行一次。CUA paste 报等待剪贴板读取超时，但实际粘贴已完成，未重复投递。
- 生成 160 行编号文本并滚轮上翻两页，视口从第 117 行附近移动到第 68 行，滚动条由 1 变为约 0.588；可正常回到底部。
- 清屏后的两行固定文本通过真实跨行拖选显示选区，Command-C 后在 cat 中 Command-V，收到选中的 ection-hello 与 second-line。早期拖选误拖侧栏及无明确选区的操作不计为通过；侧栏宽度已恢复。
- 新增 TerminalUploadTests/testMouseDragCreatesTextSelection，真实 Ghostty 适配方法接收 AppKit 鼠标按下/拖动/松开后核对 selection-hello，1 项通过，0.076 秒，TEST SUCCEEDED，exit 0，日志 /tmp/coflux-terminal-selection.log。
- Control-Space 后输入拼音仍为普通 ASCII，未见系统候选窗口；不把直接 Unicode 粘贴或已有组合文本回调测试当成真实输入法候选验收。此项继续保留。
- 核对清理时发现上一轮 a49c5ffb 临时终端已停止但列表删除未完成，已补完成删除。当前两次临时终端 92f6be8e、25a571e6 均等列表确认消失后才退出；三者最终均不在 AX 列表。

### 真实变更页折叠与刷新（2026-09-08）

- 隔离主工作区新增本轮 native-diff-ui-ip3y4hdj/中文示例.ts 和 sample.bin。CUA 确认两个文件、+13/−0、中文/emoji 高亮正文，以及二进制提示均可见。
- 折叠文本文件后手动刷新，折叠状态保留。保持 13 行不变，将 value0 从 0 改为 99，手动刷新再展开，AX 与实际截图均显示 value0 = 99；没有依赖增删计数变化才更新内容。
- 删除本轮两个临时文件及目录后，实际页面自动回到“这个工作区还没有变更”，侧栏/标签增删数同步清零。已退出验收 App，未修改原有仓库文件。
- 若 CUA 点击后返回 AXError.failure，先观察实际状态；本轮此错误出现时点击已生效，没有重复点击造成折叠状态反转。此为工具观察异常，不记作产品错误。
- 本轮未制造真实 Git/RPC 故障验证错误重试，仍不把成功刷新等同于错误恢复验收；亦非全部逐屏 Web/原生像素对照。

### 变更页离线错误与按钮重试（2026-09-08）

- 真实隔离客户端登录并创建唯一临时 Git 文件后，仅 suspend 此客户端控制连接；变更页收到本地离线拒绝。原始错误直接暴露“高权限 Device RPC”，现显示“连接已断开，暂时无法读取变更。请恢复连接后重试。”；在线 Git 错误仍保留原始诊断。
- 恢复同一客户端连接、确认新快照后，通过实际 NSWindow 鼠标按下/松开事件点击截图中“重试”按钮，恢复显示 const recovered = 42;。没有直接调用内部 load；只有预期真实文件重新出现才通过。
- NativeIntegrationTests/testChangesRetryAfterControlConnectionRecovery 1 项通过，1.020 秒，TEST SUCCEEDED，exit 0，日志 /tmp/coflux-diff-retry.log。已查看 .coflux-dev/macos/changes-offline-error.png 与 changes-retry-recovered.png，确认错误提示、重试按钮、恢复后的文件正文可见。
- 初期通过本进程 SwiftUI AX 树寻找按钮失败，而截图已显示按钮；最终测试使用可见窗口与截图确定的位置投递 AppKit 事件。未将 AX 查找失败误报为产品加载故障。
- 所有 native-retry-*.ts 临时文件均已清理，fixture 为 1 daemon、0 clients、6 sessions。未停止服务器或 daemon，未访问钥匙串。

### Ghostty 与当前 Web 同负载组件复测（2026-09-08）

- 旧 SwiftTerm 对比使用 131×33 网格，不能套用到当前 Ghostty。本轮按当前原生实际 142×34、8 个终端、10000 行历史、每终端 5000 行 ANSI/中文/emoji 文本重新建立基准；2280096 UTF-8 字节。
- 新增 Benchmarks/index.html、benchmark.mjs、vite.config.mjs 和 README，Web 基准使用当前 xterm 6.0.0 公开 write，4KiB 块；原生沿用生产输出泵。源码确认 ghostty_surface_feed 同步执行 processOutput，队列排空代表本组件处理完成，不代表 Metal 可见呈现完成。
- 修正原生心跳终点：排空后至少再观察一个心跳，并在全文断言前取消心跳，覆盖最后一批停顿；Web 同样处理。两端不同时采样，均先 1 轮预热再 5 轮，均核对完成标记与流隔离。
- 五轮中位数：Ghostty 完成 30.67ms、最大心跳间隔 11.71ms；Web 完成 56.40ms、最大心跳间隔 48.30ms。原始数据与边界保存于 Benchmarks/results-2026-09-08.json；原生日志 /tmp/coflux-ghostty-comparable-six.log，6 次测试全过，TEST SUCCEEDED，exit 0。
- 此为未挂载窗口/DOM 的组件突发负载，不能推断整窗帧率、输入延迟、网络、启动或实际工作台内存。后续仍需可见工作台同场景测量。基准页与临时 15276 服务已关闭。
- /tmp/coflux-benchmark-audit.json 通过，Web 测量工具未进入原生测试包，仍无脚本资源或 Web 运行时直接链接；未访问钥匙串。

### 一个可见终端与七个后台终端负载（2026-09-08）

- 原生测试扩展真实 1000×600pt 窗口，首个 Ghostty 视图挂载窗口，七个后台 surface 设为不可见；Web 基准增加可见模式，首个 xterm 挂载 1000×600px 容器，其余不挂 DOM。均为 142×34、8×5000 行、2280096 字节，独立先后采样。
- 原生六轮测试通过，首轮预热，日志 /tmp/coflux-visible-native-six.log，TEST SUCCEEDED，exit 0。Web 通过全部完成标记与流隔离检查。五轮中位数：原生完成 24.80ms、最大心跳间隔 7.32ms；Web 完成 66.20ms、最大心跳间隔 59.40ms。
- 原始数据在 Benchmarks/results-visible-2026-09-08.json；模式、配置和命令见 Benchmarks/README.md。与全部未挂载模式后台可见性设置不同，不用两次结果相减估算渲染成本。
- 这是存在可见终端时的处理/主线程心跳测量，终点仍为输出处理完成，没有 GPU 呈现完成信号，不代表完整工作台帧率或真实输入往返。整体性能验收继续。
- 基准页和15276服务已关闭；/tmp/coflux-visible-benchmark-audit.json 通过。Web 基准资源未进入原生测试包；本轮没有读写钥匙串或改动生产服务。

### 原生工作台真实输入链路（2026-09-08）

- 新增明确测试入口 NativeIntegrationTests/testRealInputRoundtripThroughPTY，在真实 RootView 独立终端中，经原生文本提交和回车、隔离 relay、PTY 程序确认，测量直到终端缓冲区收到唯一 ACK。PTY 关闭本地回显，准备程序编码启动以排除回显假阳性。
- 首次环境开关未被 Xcode scheme 透传，原集成测试通过但没有采样，因此该次不算测量。最终改为独立入口，实际产出 1 次预热和 30 次采样，中位 7.26ms、P95 12.14ms。原始数据见 Benchmarks/results-input-native-2026-09-08.json。
- 测量后的切换、上传、重连回归继续通过；最终 1 项测试通过，6.520 秒，TEST SUCCEEDED，exit 0，日志 /tmp/coflux-native-roundtrip.log。测试程序恢复 PTY 设置，测试任务按既有流程清理。
- 这是本机中继的输入到缓冲区基线，包含 1ms 轮询开销；不是物理输入到屏幕、不是公网/高负载或 Web 对照验收。整体目标继续。

### 持续输出输入验证（2026-09-08）

- 新增真实 PTY 持续输出输入验收，30 次探针均确认期间输出增长，最终 257792 字节；当前视口读取测得中位 9.52ms、P95 20.59ms，空闲对照 7.87ms、12.08ms。
- 排除了反复全文读取导致的测量开销；准备标记滚出视口造成的首轮准备失败已修正。方法、原始结果与失败边界见 Benchmarks/README.md。
- 最终负载测试及随后切换、上传、重连通过，9.240 秒，/tmp/coflux-native-roundtrip-loaded-final.log，TEST SUCCEEDED、exit 0。仅改测试，无产品改动，不等于公网、GPU 呈现或全部目标完成。

### 实际工作台短错误浮层修复（2026-09-08）

- CUA 真实窗口复现：仅一行 session logical client identity 已达上限 256，错误浮层却被拉高为大块面板。Web 浮层按正文自然高度排列；原生 ViewThatFits 外层接受了 overlay 的高尺寸提议。
- 新测试 testErrorToastUsesContentHeightInsideWorkbenchOverlay 在 1200×860 的实际 NSWindow 父浮层中读取几何尺寸，不只检查 fittingSize。修复前短文和长文均 480×376，短文断言失败；日志 /tmp/coflux-toast-overlay-before.log。
- WorkbenchErrorToast 在限制宽度后固定内容高度。修复后短文 480×80（含外边距），长文仍 480×376 并保留滚动能力；三个布局/渲染测试通过，/tmp/coflux-toast-overlay-after.log，TEST SUCCEEDED、exit 0。
- CUA 重新登录同一隔离服务，实际窗口确认提示恢复右下角紧凑单行，关闭按钮清除提示；最终已退出 App。产物检查 /tmp/coflux-toast-overlay-audit.json 通过。
- 本轮另只读核实系统已有简体拼音，Ctrl-Space / Ctrl-Option-Space 切换快捷键均启用，但 CUA 逐键输入 ni 未产生候选窗；仍不能作为真实 IME 通过或产品失败证据。未修改系统输入法配置，已退出系统设置。临时终端 f0e0e92c-6b3b-480e-bef5-d452e9789fd4 已退出并关闭，AX 确认标签消失。

### 输入法与系统文本服务选区状态（2026-09-08）

- GhosttyTerminalView.selectedRange 原先始终返回最后一次 setMarkedText 的选区：取消、提交、重建终端后仍是旧拼音/候选位置；真实终端文本选区也没有反映给 AppKit。
- 新测试 testInputClientSelectionDoesNotRetainPreviousComposition 覆盖中文 emoji 组合选区、取消、提交、快照重建、真实 Ghostty select_all 及移除。修复前 6 条断言失败，/tmp/coflux-input-selection-before.log，TEST FAILED。
- 现在组合期间返回组合选区；非组合状态按 Ghostty 当前上游 AppKit 宿主方式使用 ghostty_surface_read_selection 返回的视口选区坐标。无选区或核心已释放时返回 NSNotFound，取消/重建同时清除缓存候选位置。不把核心视口坐标宣称为全文 UTF16 索引。
- TerminalUploadTests 全组 33 项通过，0 失败，6.201 秒，/tmp/coflux-input-selection-after.log，TEST SUCCEEDED、exit 0。覆盖输入、组合提交/取消、选区、焦点、鼠标协议和上传等现有行为；不等同系统候选窗口实际选词已验收。
- 当前临时签名产物审查 /tmp/coflux-input-selection-audit.json 通过。未访问钥匙串、未修改系统输入法设置或启动生产服务。

### 仓库共享层验收与黑盒隔离（2026-09-08）

- 当前工作树 Server tsc --noEmit 与 Web tsc -b 均 exit 0；日志 /tmp/coflux-native-final-server-types.log、/tmp/coflux-native-final-web-types.log。
- cargo build -p coflux-supervisor -p coflux-worker -p coflux-relay 通过，无警告，/tmp/coflux-native-final-rust-build.log。共享 Swift 74 项、8 suites 通过，2.931 秒，/tmp/coflux-native-final-swift.log。
- 宿主 pnpm -C tests test 开始后，前几个 agent-activity 用例超时。lsof 确认固定 8856 端口被 /Users/wsq/Workspace/coflux 的既有服务占用（PID 4608），其他既有服务还占 8830/8861/8833/8835。已对本轮测试 runner 82369 发送 SIGINT，命令 exit 1；停止后确认没有本轮新测试服务残留，其他工作区服务保持运行。
- /tmp/coflux-native-final-blackbox.log 属于端口冲突后主动中止的无效全套运行，不能作为原生回归失败或通过的证据。后续改为仓库 Dockerfile 完全隔离端口与 Postgres；本次源码上下文排除 .coflux-dev、原生工程及编译缓存，保留完整 server/web/protocol/Rust/tests 源码。镜像标签 coflux-native-parity-tests:20260908，构建日志 /tmp/coflux-native-container-build.log。

- 容器镜像构建 exit 0；已启动 docker run --rm --name coflux-native-parity-tests-20260908 coflux-native-parity-tests:20260908。运行日志 /tmp/coflux-native-container-blackbox.log，当前命令 session 54153，容器状态 running。已观察前 15 项通过，整套仍在运行，不能宣称全部通过。后续继续观察该句柄和容器，不重复启动。

### 黑盒整套完成与 macOS 补测（2026-09-08）

- 隔离容器命令 exit 0，265 项中 264 通过、0 失败、1 跳过，4 suites，297.573 秒。日志 /tmp/coflux-native-container-blackbox.log；容器 --rm 清理完成，docker ps 无对应容器。
- 唯一跳过项为 cofluxd macOS ad-hoc 重签失败时保留旧 pair。宿主使用 node --import tsx --test --test-name-pattern 定向补跑，1 通过、0 跳过，exit 0，/tmp/coflux-native-macos-cli-trust.log。该用例的 codesign 是临时目录内 exit 1 的模拟程序，不使用开发者凭据或钥匙串。
- 原生隔离 fixture 健康，1 daemon、0 clients、6 sessions。开始当前 Performance 原生全套，日志 /tmp/coflux-native-final-full.log；必须等最终汇总，不能引用旧 189 项作为新全套结果。

### 当前原生完整回归与产物检查（2026-09-08）

- 当前 Performance 全套 195 项：188 通过、7 项钥匙串用例跳过、0 失败，154.506 秒，TEST SUCCEEDED、exit 0。日志 /tmp/coflux-native-final-full.log；xcresult /tmp/coflux-macos-093-build/Logs/Test/Test-Coflux-2026.09.08_03-40-45-+0800.xcresult。
- 覆盖最新错误浮层布局、输入法选区状态、diff 重试、Ghostty 可见输出及真实输入负载等新增回归。整套中的性能数字仅作回归观测，不替换 Benchmarks 中独立采样的对照结果；离屏测试中有显示链接创建失败并降级渲染日志，不能由全套通过宣称真实屏幕帧率通过。
- /tmp/coflux-native-final-audit.json 通过，13 个去重 Mach-O 无脚本资源或直接 Web runtime 链接，许可内容一致、临时签名有效。notices --check 通过：34 项锁定依赖、12 本地原生语法及其他许可共 497580 字节。
- 结束后隔离 fixture 仍健康：1 daemon、0 clients、6 sessions。总体目标仍按 ACCEPTANCE.md 未完成项推进，不由这次完整回归替代逐屏、跨网络、系统交互与正式分发验收。

### Release 版本标识构建约束（2026-09-08）

- project.yml 将 COFLUX_BUILD_ID 写入 Info.plist 的 CofluxBuildID，沿用 App.swift 已有认证 clientVersion 读取路径；新增每次构建执行的 validate-build-id.sh，只有 Release 要求显式标识。拒绝空值、dev/unreleased、未展开变量、非允许 ASCII 字符与超过 128 字符的值。
- 9 个脚本场景通过。实际 Xcode Release 缺少标识时在该构建阶段明确失败，exit 65，/tmp/coflux-native-release-id-missing.log；提供 macos-0.1.0-validation 后 BUILD SUCCEEDED、exit 0，/tmp/coflux-native-release-id-valid.log。
- PlistBuddy 从实际 Release/Coflux.app/Contents/Info.plist 读到相同标识；/tmp/coflux-native-release-id-audit.json 通过，2 个独立 Mach-O，无脚本资源或 Web runtime 直接链接，许可一致，临时签名有效。构建仍有 AppIntents 未依赖而跳过元数据提取的 Xcode 提示。
- 本次仅宿主架构、临时签名构建，未启动 Release、未访问钥匙串。服务器仍沿用现有允许版本集合，未改生产配置；正式准入登记、签名、公证与安装运行仍待验收，不能拿测试标识作为已发布版本。

- Performance 不提供 COFLUX_BUILD_ID 的实际构建同样通过，/tmp/coflux-native-release-id-performance.log，BUILD SUCCEEDED、exit 0；开发运行时仍由编译分支使用 dev。此次仅构建配置变化，未重复已通过的完整行为回归。

### 重命名弹窗视觉与键盘对齐（2026-09-08）

- 临时 Web 页面加载当前 ProjectRenameDialog、neutral Theme 和 LayerProvider，无网络客户端或保存动作。截图已查看；通过 CUA 浏览器只读 DOM 实测弹窗 400×158.65625，标题 13px，外层左右16px，输入框368×32、圆角10，主次按钮约50×32、间距8。最初按 role=dialog 查找得到空结果，未采信；最终从真实 h2/input 祖先链测量。
- 原生项目/设备/工作区重命名改为同样400pt宽、16pt水平留白、32pt输入框及按钮。说明跟随标题紧凑排列，使用 #262626 弹窗底色和较亮说明文字；保存沿用原生主按钮样式，取消使用新增原生次按钮样式。
- 三种原生渲染均400×154pt；与Web约5pt高度差源于当前标题文字度量/间距，未宣称逐像素相同。初始15项（渲染1 + 工作台状态14）通过，/tmp/coflux-rename-dialog-parity.log；配色修正后渲染1项通过，/tmp/coflux-rename-dialog-colors.log。截图 /tmp/coflux-rename-project-parity.png 已查看，设备/工作区图同目录。
- CUA实际打开隔离项目重命名：名称coflux已选中并聚焦；清空后保存禁用，Return仍保留表单；Escape关闭后侧栏名称仍coflux。未实际更改项目数据，已退出App。关闭终端和移除确认仍须独立核对，不由重命名结果推定。
- Web临时页面/源码文件及浏览器页已删除/关闭，apps/web无本轮残留改动。/tmp/coflux-rename-dialog-audit.json通过；本轮未访问钥匙串或生产服务。

### 关闭与移除确认统一原生布局（2026-09-08）

- 当前 Web ConfirmActionDialog 隔离实测400×147px；按钮32px高、间距8，危险按钮背景rgba(255,158,151,.24)、前景rgb(255,198,193)，正文13px。截图及只读DOM均已核对；临时页无真实确认动作，已关闭并清理对应源码。
- 新增 WorkbenchConfirmationView（SwiftUI），关闭终端与移除项目/工作区/设备共用400pt宽、16pt左右留白、同源主次/危险按钮和#262626底色。关闭终端从系统alert换为原生sheet，原有model确认/取消动作保持，危险按钮无默认回车快捷键。
- 原生实际NSWindow测试验证Return不确认、Escape触发取消；加既有WorkbenchStateTests共15项通过，/tmp/coflux-confirmation-parity.log，TEST SUCCEEDED、exit 0。/tmp/coflux-confirmation-parity.png已查看。
- CUA新建独立终端30（58ddde08-82c1-4943-a5ef-5ccd2405ee7b），Cmd-W出现真实确认，初始焦点在关闭按钮。Esc返回后执行printf并看见CANCEL-KEPT-PTY，证明取消保留可用会话；再次Cmd-W点击停止并关闭，完整AX确认taskID消失、工作台仍在。已退出App，未操作其他终端或项目删除。
- 实体移除复用同一布局，未据此声称三类真实删除都已复验。/tmp/coflux-confirmation-audit.json通过；apps/web临时文件已清理，本轮未访问钥匙串或生产。

### 添加设备安装引导（2026-09-08）

- 对照当前 Web EnrollmentDialog 源码统一480pt宽、标题说明、12pt运行提示、命令块、居中授权说明及32pt完成按钮；左右留白16pt、弹窗底色#262626。此轮未重新测量Web像素，不宣称逐像素一致。
- 实际窗口检查发现自定义资源图标组件不支持SF Symbols名称，复制图标为空；已改用SwiftUI Image(systemName:)。最终CUA截图确认复制图标正常。无JS或WebView路径。
- CUA隔离登录后打开引导，点击复制即时显示“已复制”，剪贴板读回精确npm i -g cofluxd && cofluxd up，随后标签复位为“复制”。Esc和点击“完成”均关闭sheet返回工作台；最终App已退出。未执行命令或安装daemon，未访问钥匙串。
- 最终WorkbenchStateTests 14项通过、0失败，TEST SUCCEEDED、exit 0，/tmp/coflux-enrollment-final.log；/tmp/coflux-enrollment-audit.json通过。该状态测试不替代上述实际UI验收。完整原生回归仍为较早195项版本，最近弹窗修改收敛后需重跑。

### 分支列表统一高亮与图标（2026-09-08）

- 对照Web branch-menu.tsx发现原生通用按钮样式有独立hover高亮，与键盘selected并存；指针经过其他行后回车仍操作旧项。分支行改为plain Button配单一selected背景，onContinuousHover更新同一索引；已占用行不参与选择。新增原生SF Symbols加号和当前分支勾选。
- 最终构建BranchChoicesTests 4项通过，/tmp/coflux-branch-parity.log。首次指定的集成测试名称未匹配，日志明确0项，未当作通过；用正确testDesktopDirectoryGitAndWorkspaceLifecycle补跑1项、3.595秒、0失败，/tmp/coflux-branch-lifecycle.log，含真实原生输入提交、Git/worktree创建、分支同步及错误占位恢复。
- CUA实际菜单确认main显示绿色勾选、native-ui已占用禁用；下键跳过占用项、Return关闭当前分支。输入ma显示带加号的新建候选行；下键后截图确认只高亮main，Return关闭而未新建。Esc/工具激活导致的popover关闭不用于冒充分支操作证据。App已退出。
- 本轮未重新度量Web像素；自动化工具无独立鼠标移动API，未将截图/键盘验收宣称为真实鼠标与键盘交替移动全覆盖。菜单开关、长列表滚动及鼠标交替仍应在完整人工交互中检查。

### 最近弹窗与分支修改后的完整回归（2026-09-08）

- Performance完整197项：190通过、7钥匙串项跳过、0失败，157.726秒，TEST SUCCEEDED、exit 0；/tmp/coflux-native-dialogs-full.log。包含最近重命名与确认新增的2项及安装引导、分支菜单生产代码，取代较早195项作为当前回归证据。
- /tmp/coflux-native-dialogs-audit.json通过：13个去重Mach-O、无脚本资源或直接Web runtime链接，许可一致、临时签名完整性有效。sync-notices --check通过，497580字节。
- 完成后隔离fixture健康，1 daemon、0 clients、6 sessions。未访问钥匙串或生产。整体目标仍有ACCEPTANCE列出的系统交互、真实工作台性能、跨网络与正式分发验收，不能由本次回归推断完成。

### 完整工作台切换基准与未采用优化（2026-09-08）

- 新增testWorkbenchSwitchPerformanceWithEightLiveTerminals，8个真实隔离PTY、每个5000行预填历史、1360×800pt RootView、40个工作区标签；5次预热后60次切换，分别空闲与8路持续输出，计时到目标NSView取得焦点。断言只有一个active Coordinator、视图持续复用、所有输出计数增长且不串流；每轮清理本轮创建的8个任务。
- 原始三轮中位数：空闲18.65ms、P9521.62ms；持续输出18.62ms、P9522.30ms。CPU/physical footprint、原始60点和输出计数均落Benchmarks/results-workbench-switch-2026-09-08.json。不是GPU呈现延迟，也尚无同条件Web对照。
- 尝试局部缓存派生任务列表/当前任务后，三轮切换19.18/19.33ms，CPU小幅下降，未证实收益。两处生产文件已按本轮改前副本恢复并逐字节断言一致；保留负结果，不声称性能提升。先前基准Swift6局部变量跨Task检查失败已改为MainActor统计对象，编译失败未当作测量数据。
- 最终新基准+ErrorToastLayoutTests+WorkbenchStateTests共35项、0失败、30.222秒，TEST SUCCEEDED、exit 0，/tmp/coflux-workbench-switch-final.log；产物审计/tmp/coflux-workbench-switch-audit.json通过。此前197全套对应产品代码仍未变化，新增基准单项另有本次验收，不将全套数量虚增为198已运行。
- fixture最终1 daemon、0 clients、6 sessions，未碰生产或钥匙串。下一步需用采样分析定位实际成本，并补Web完整工作台对照，不能从微小CPU变化推断实际流畅度改善。

### 工作台采样与滚动方向验证（2026-09-08）

- 新增profile-workbench-switch.py和基准计时外阶段标记，先核对新阶段mtime、实际可执行文件路径、pid及同一runID，再对idle/loaded各sample 1秒。脚本最终实际运行成功，进程64570、runID switch-benchmark-2FDF1B62-E67F-4616-A54B-E5B627944FF7；报告/tmp/coflux-switch-profile-final/{idle,loaded}.txt及同名json。
- 首轮主线程仅24/356个快照，loaded中55个含scrollTo链路，提示布局/滚动值得调查；不是互斥CPU百分比。两种“目标可见则不scrollTo”试验均通过滚动功能测试及3轮基准，但没有空闲、负载同时受益：可见集合方案19.26/19.33ms，非观察几何缓存17.50/20.09ms，对照18.65/18.62ms。全部原始数据见Benchmarks/results-workbench-scroll-experiments-2026-09-08.json。
- 两种产品改动均已撤回，TerminalWorkspaceView与本轮前副本逐字节一致。保留采样工具、测试阶段标记和负结果；未把这些试验称作产品提速。
- 最终原行为构建，ErrorToastLayoutTests、WorkbenchStateTests及真实8路基准共35项通过、0失败、28.401秒，/tmp/coflux-switch-profile-final.log，TEST SUCCEEDED、exit 0。本次有sample附加开销，数字不更新正式基线。/tmp/coflux-switch-profile-final-audit.json通过。
- 最终fixture 1 daemon、0 clients、6 sessions。未访问钥匙串或生产。停止围绕该局部继续猜测，后续优先完整Web对照和剩余系统交互验收。总体目标仍未完成。

### 完整工作台两端三轮对照（2026-09-08）

- 当前入口统一工作台1280×684、2倍像素、40标签、8路独立PTY、每路5000行历史；原生/Web依次各三轮完成。输出程序全部就绪再统一发送go，原生网格145×37、Web143×37。
- 三轮统计中位数：原生空闲18.50ms/P95 21.20ms、持续输出17.71ms/P95 20.37ms；Web空闲12.40ms/P95 13.40ms、持续输出12.75ms/P95 14.00ms。完整原始样本见Benchmarks/results-paired-workbench-2026-09-08.json。
- Web真实Workbench生产构建入口仅用于测试，不进入原生包。原生挂载8个视图、Web40个xterm；原生有活动标签自动滚入视口，当前Web无此行为。数据反映当前产品焦点就绪，不能归因于渲染核心或推断GPU帧率，也没有证明原生整体更快。
- Web每轮8个测试任务均显示清理完成。独立入口类型检查及生产构建通过；原生最新三轮通过，不把它表述为新增基准后的全套回归。早期HMR、缺样式、DPR1结果排除。后续继续系统交互、真实Agent连贯状态及正式分发验收。

### 系统输入源检查与候选窗定位回归（2026-09-08）

- CUA启动当前Performance应用并登录19873隔离服务，新建独立终端b64cb792-ec39-4f42-880a-dcd655091924。Ctrl-Space后逐键n/i仍显示ASCII，未见系统候选窗，不能算真实拼音选词通过，也不能单凭此现象判断应用有输入法缺陷。
- 系统设置界面只读确认：输入法包含ABC、简体拼音及另一输入源；“选择上一个输入法”Ctrl-Space和“下一个输入法”Ctrl-Option-Space都已启用。未修改系统设置。自动化仍未取得真实候选窗证据，后续不要重复用ASCII或粘贴中文冒充验收。
- 新增testIMECandidateAnchorTracksCursorAndWindowCoordinates：真实AppKit窗口内终端有侧栏/底部偏移，验证候选锚点在终端屏幕范围内、ASCII前进一格、中文前进两格、换行向下、窗口移动70/40pt同量跟随、离开窗口后归零。它检验NSTextInputClient的定位合同，不替代候选窗实际显示与选词。
- 首跑错误地要求插入点矩形宽度大于零，仅此断言失败；零宽插入点合法，修正为非负宽度、正行高后，新用例及组合提交/取消/选区清理共4项通过，0失败，0.899秒；/tmp/coflux-ime-anchor-final.log，TEST SUCCEEDED，exit 0。没有修改产品输入逻辑。
- CUA“停止并关闭”清理本轮终端，协议快照确认该task不存在；退出手工验收应用，fixture回到1 daemon、0 clients、6 sessions。未访问钥匙串、未操作生产或用户真实终端。

### Finder实操准备与上传部分失败恢复（2026-09-08）

- CUA在Finder打开本轮专用目录/var/folders/t8/9n03v5314030xfnq_vz_8k200000gn/T/coflux-finder-drop-7hh535d5，文件“拖放 中文 file.txt”50字节，SHA256为8387f9aa8e6a1a53207faf23b10cace89f18d5638ed82f63f13b35a7ebbb3dd1。元数据另存/tmp/coflux-finder-drop-fixture.json。没有使用用户文件。
- 原生本机隔离服务新建终端33，taskID 74023647-8471-4cc4-aa18-8d4d1f4a662f。Finder和原生窗口通过系统菜单分别移到左/右侧；两次CUA drag均未看到路径插入，不能据此判定功能成功或判定产品缺陷。已请求用户补充一次真实拖放，等待回应期间保留两窗口及该测试PTY，不把这个有意保留的验收会话当成已清理。
- 操作窗口菜单时曾因使用重排前AX索引打开既有“终端1”的关闭确认，立即取消，未执行关闭。后续按最新AX索引操作；该既有任务未删除。
- testRealLoginTerminalSwitchAndReconnect的多文件用例加入一个已不存在的中间文件：目录跳过；正常文件A、失败文件、正常文件B依次处理，错误ID更新且消息非空；切到其他终端后两个成功路径仍留在原Coordinator，设备回读内容为native-upload-anative-upload-b。随后图片转换/上传/回读及原终端路径插入、重连流程继续通过，证明失败未使上传状态卡住。
- 本轮是增强现有真实集成测试，未修改产品逻辑。/tmp/coflux-upload-partial-failure.log：1项通过、0失败，5.807秒，TEST SUCCEEDED、exit 0。不替代Finder真实drop事件、全套回归或大图边界实机验证。
- 最后fixture健康：1 daemon、1 client、7 sessions；多出的client/session为上述等待手动验收的原生窗口和独立终端。未访问钥匙串或生产。

### 长设备列表侧栏布局修复（2026-09-08）

- 当前Web sidebar.tsx的设备section具有max-h-[42%]和独立overflow-y-auto；原生此前是无限增高的VStack，设备多时可挤掉上方项目列表。SidebarView现测量设备内容自然高度，少量设备收缩；含分隔线最多占侧栏42%，超出部分使用独立原生ScrollView。
- 补上与Web相同的“添加第一台设备”空态入口，复用.enrollment引导；仍保留设备标题旁加号。
- 新增testLongDeviceSidebarKeepsProjectsVisibleAndScrollsIndependently：80项目、60设备，600/300/800pt窗口高度下设备区均不超过42%，项目区保留至少58%；设备末尾可达、滚动不改变项目位置；缩为1设备时收回空白。1项通过、0失败，1.087秒，/tmp/coflux-sidebar-scroll.log，TEST SUCCEEDED、exit 0。
- /tmp/coflux-sidebar-empty-device.png已实际查看：空态按钮与底部设备标题完整可见，上方项目保持滚动区域。该测试用内存快照及离线设备，不连生产，不替代真实Agent长时间连续状态验收。

- 侧栏修复后完整原生回归：200项、193通过、7钥匙串相关跳过、0失败，174.424秒；/tmp/coflux-sidebar-full.log，TEST SUCCEEDED，exit 0。覆盖新增候选定位、上传部分失败和长设备列表；本轮性能用例仅作回归，不纳入成对基准。
- /tmp/coflux-sidebar-audit.json：13个Mach-O，未发现脚本资源或直接Web运行时链接，许可文本一致、临时签名完整。fixture保持1 daemon、1 client、7 sessions，保留的手动拖放终端未被本轮测试清理。

### 项目离线标记与侧栏提示补齐（2026-09-08）

- 对照当前Web sidebar.tsx：原生项目行此前缺少设备离线/记录缺失时的6pt灰点，以及repoPath提示。现仅在关联设备不在线或不存在时显示灰点，提供“设备「名称」离线”或“设备记录缺失”的辅助功能说明；在线项目保持无标记。
- 项目提示包含仓库路径及异常设备说明。项目/设备行沿用工作区行的系统.help提示，避免在侧栏ScrollView中用固定宽度overlay显示长路径，也避免父子两层提示重叠。系统提示的实际悬停显示仍需实机核验，不能以离屏快照证明。
- renderWorkbench夹具增加缺失设备场景和/work/coflux仓库路径，复用既有离线渲染测试。已查看device-empty、device-offline、device-missing三张快照：在线项目无灰点，离线和缺失记录有灰点；缺失记录时“添加第一台设备”入口完整显示。
- packages/client/src/store.ts与WorkspaceActivity.swift的聚合规则核对一致：approval > question > active > done，旧waiting映射done；离线不显示活动态但保留独立progress。没有修改该逻辑，不替代真实Agent连续状态验证。
- 最终布局及活动状态23项通过、0失败，8.212秒，/tmp/coflux-sidebar-status-final.log，TEST SUCCEEDED、exit 0。此前三项初测通过；最终测试针对统一为系统提示后的源码。200项完整回归发生在本次小改动前，未将其当成本次源码的全套结果。

### Git正文相同行数修改后的重新进入验证（2026-09-08）

- 对照Web changes-refresh.ts：增删行数只触发活跃时快速刷新，重新进入与手动刷新都是独立失效入口。原生ChangesView的task键包含active/defaultBranch/workspace/统计/revision，与这一规则对应；没有以统计值当作正文版本。
- 扩展testChangesPageRendersRealGitFile：沿用真实隔离Git文件和原生TextKit文档，先验证中文、emoji、高亮、长行末尾横滚，再切为inactive；通过真实设备exec把hello替换为updated-same-line-count，断言行数相同；重新设active时沿用完全相同的workspace值，等待新正文和原生高亮完成，并断言旧hello正文不再存在。
- /tmp/coflux-diff-reentry.log：1项通过、0失败，2.152秒，TEST SUCCEEDED、exit 0。仅增加真实行为验收，未修改产品加载逻辑，不替代实际鼠标折叠/手动刷新/全部错误状态逐屏验证。
- 测试文件最终清理，隔离repo无native-render-*.ts残留；fixture仍1 daemon、1 client、7 sessions，手动Finder验收终端继续保留。未触碰生产或钥匙串。

### 首次有效Metal工作台轨迹（2026-09-08）

- 增加显式COFLUX_SWITCH_METAL_TRACE测试方案变量及计时外15秒附加准备，普通基准路径不等待；观察器核对新阶段文件、PID和可执行路径，不附加到等待手动验收的原生窗口。
- Metal System Trace成功录制26.245秒并保存，空闲和8路持续输出两个阶段都在轨迹范围内。目标PID21340有1832条Vertex/Fragment Active GPU事件；阶段区间并集合计144.33ms/447.01ms。记录与范围解释见Benchmarks/results-metal-workbench-2026-09-08.json和README。
- 没有屏幕呈现表行，不能报告FPS；没有Web GPU对照。未把轨迹成功或零potential-hangs记录当作流畅度已达标，也不把采样轮混入正式性能基线。
- 首次因Xcode方案未传开关而没有开始采集；修正并重新生成工程后实际采样测试1项通过、37.037秒、TEST SUCCEEDED、exit 0。fixture仍1 daemon、1 client、7 sessions，手动拖放会话保留；未访问钥匙串或生产。

### 启动轨迹诊断，不作为基准（2026-09-08）

- App Launch模板启动Performance构建，隔离内存凭据；可导出轨迹含初始登录界面首帧渲染结束1123.90ms的阶段记录。
- xctrace返回54，目标进程33837标记SIGKILL，原因未确认。保留为Benchmarks/results-launch-diagnostic-2026-09-08.json诊断记录，不算正式启动验收，不推断Web比较结果。
- 定向终止本轮同一启动时刻留下的33836，保留手动Finder验收进程57987。没有修改产品或访问钥匙串。

## 2026-09-08：Git 折叠刷新与分支弹窗实操

在保留中的 Performance 窗口，通过 CUA 操作隔离 fixture main 工作区。创建本轮专用 native-collapse-review.ts（2 行）后，变更页自动显示 +2；点击文件头，正文消失且截图确认折叠。将同一文件正文改写但保持 2 行，点击刷新变更，折叠状态保留；再次展开，AX 正文和截图均显示“折叠后刷新成功”及 count = 2，验证手动刷新不依赖增删行数变化。两次文件头 AX 点击返回 failure，但后续 AX 与截图证明动作已生效，因此没有重复点击。

分支弹窗实操确认：main 标记当前分支，native-ui 标记已被检出且禁用；输入 main 后过滤到当前分支；输入不存在名称出现从 HEAD 新建入口；Escape 关闭弹窗，未执行切换或创建。非法名称的服务端错误处理不计作本轮验证。

只删除本轮创建且内容校验一致的临时文件，AX 确认变更页恢复空态，随后切回终端 33，保留 Finder 拖放验收现场。本轮没有产品源码变更；不把这些分项实操扩展为全部 Git/UI 验收完成。

## 2026-09-08：Vim 全屏交互实操

通过 CUA 在隔离 main 新建终端 41（1396c707-25ab-4ed5-9080-3d0058b77162）。工具 paste 两次超时且画面未见命令，未视为成功；普通实体按键可输入，随后 Ctrl-U 清空输入，通过逐键输入 vim -u NONE 启动 Vim 9.1.1752。截图确认备用屏幕进入。插入 abc、换行 def，Escape 回普通模式，上箭头回首行、0 定位、x 删除后截图显示 bc / def；随后 u 和 :q! 退出，截图确认原 shell 命令及提示符恢复。未写编辑文件，也未把此结果视为真实中文 IME、tmux 或粘贴通过。

点击本轮终端关闭按钮，确认弹窗明确显示终端 41，执行停止并关闭；后续 AX 确认该 task 标签消失。关闭时自动选中旧终端曾显示 logical client identity 上限 256（长期 fixture 已知限制）；已切回保留的终端 33。原生源码本轮未变，自动化粘贴失败仍需区分工具限制与产品行为。

## 2026-09-08：后台终端编辑快捷键焦点修复

排查 CUA paste 超时时发现 GhosttyTerminalView.performKeyEquivalent 未检查 firstResponder，未聚焦的常驻终端也会消费 Command-C/V/A。新增两视图回归 testClipboardShortcutOnlyTargetsFocusedTerminal，用 paste 探针而非系统剪贴板，先后切换焦点验证后台不得消费、前台恰好消费一次。修复前5处断言失败（/tmp/coflux-paste-focus-before.log，exit65）；增加 window.firstResponder 身份检查后，TerminalUploadTests 全部35项通过，0失败，6.559秒，TEST SUCCEEDED、exit0（/tmp/coflux-paste-focus-after.log）。

此证据确认并修复原生快捷键焦点缺陷，不足以确认此前 CUA paste 超时的唯一根因；工具粘贴与多标签实机仍需在重新启动的最新产物复验。保留的验收进程未重启，仍是旧版本。上一次200项完整回归早于此修复，不能视为当前改动的全套结果。

## 2026-09-08：多行中文粘贴模式切换

核对固定 Ghostty 上游版本：ghostty_surface_text 经 textCallback 调用 completeClipboardPaste，具有原生 bracketed paste 处理；无需 JS 或自行包装转义序列。在既有 testUploadedPathsRespectBracketedPasteMode 上增加“第一行 😀\nsecond line\n”：开启2004模式时实际输出完整200~/201~包装且内部换行、UTF-8内容不变；随后关闭2004模式，同一文本的输出不再包装，换行按核心规则转换为CR。/tmp/coflux-multiline-paste.log：1项通过、0失败、0.119秒，TEST SUCCEEDED、exit0。此为真实Ghostty核心输出验证，不代表系统剪贴板和CUA接口已复验。

## 2026-09-08：最新 App 多标签剪贴板实机复验

通过 CUA 退出旧进程57987，使用 COFLUX_MACOS_TEST=1、隔离服务器及无钥匙串环境启动最新 Performance 构建（PID88278，日志/tmp/coflux-latest-manual.log）。重新登录后新建终端41（8ec224c5-a4e7-4c3e-aa0a-9d1f963bc7ab）和42（0aa42c9b-2785-4821-9201-6ce5818a54ba）。分别用 CUA paste 粘贴 echo PASTE_FOCUS_8EC224 与含“第二标签粘贴 😀 0AA42C”的echo命令。两次工具仍报读取剪贴板超时，但截图均确认命令已正确粘贴；仅按一次Return后各自得到预期回显。切回41，截图仍只有41的命令及回显，没有42内容。此结果验证当前系统剪贴板到活跃终端路径及两个标签间隔离；不证明工具超时的内部原因，也不代表真实IME输入已通过。

两测试终端经明确的停止并关闭确认清理，AX确认标签均消失，health恢复1 daemon/1 client/7 sessions。切回终端33，保留Finder测试文件和最新验收进程。旧会话身份上限256提示仍属长期fixture未解决限制。

## 2026-09-08：会话身份上限原因核对

当前 supervisor/sessiond.validate_attach 按 transport_bindings 累计身份实施256上限，transport/input/resize账本保持一致，已准入身份即使满额仍可提升generation迁移。Web device-router同样在实例创建/登出时更换身份，普通transport恢复保留。原生DeviceRouter对应生命周期一致，不能仅持久化UUID而丢弃输入游标，否则产生序号碰撞。未修改daemon上限或旧会话数据。

为Swift现有授权恢复测试的provider记录clientInstanceID，并在 expired、scopeDenied 两条真实路由状态机测试分支断言恢复后身份不变且generation增加。swift test --package-path packages/swift-client --filter elevatedAuthorizationRecoveryPreservesOperationIdentity 通过（1测试、2参数用例，0.008秒，exit0；/tmp/coflux-identity-renewal.log）。该证据排除了这些恢复路径新增身份的问题；长期fixture旧会话累计名额耗尽仍未修复，也不宣称所有重连路径均已验证。

## 2026-09-08：完整回归失败，待定位

快捷键修复后完整回归在长期19873环境失败：201项，7跳过，9个失败用例/13个失败断言或异常，311.062秒；/tmp/coflux-focus-full.log，exit65。共享Swift74项通过（/tmp/coflux-focus-swift-full.log），产物审计通过（/tmp/coflux-focus-audit.json），均不抵消集成失败。精确清理此轮5个新增且确认idle无session的任务，原任务未删。

为排除长期fixture，另起19983临时stack（/tmp/coflux-focus-fresh-fixture.json，日志/tmp/coflux-focus-fresh-fixture.log），原19873及其他工作区服务保留。针对LocalGatewayTests、P2PRouterIntegrationTests、testRealLoginTerminalSwitchAndReconnect的9项运行8通过、1钥匙串跳过、0失败，55.045秒，exit0（/tmp/coflux-focus-fresh-recheck.log）。同一新环境完整201项再次失败：7跳过，7个失败用例/11个失败断言或异常，330.587秒（/tmp/coflux-focus-fresh-full.log）。因此不能把失败仅归于旧环境。主要停在新建终端运行状态等待，之后P2P用例也失败。已补TERMINAL_START_DIAGNOSTIC输出任务状态、视图数及连接错误，待下一次缩小测试组定位；当前尚无根因和修复结论。19983保持运行供后续定位，最终需要正常停止清理。

## 2026-09-08：启动失败最小组合与消息追踪

NativeIntegrationTests独立9项运行仍4个用例失败（/tmp/coflux-native-group-diagnostic.log，exit65）。新增超时诊断证实当前task为idle、无session，2个原生视图已挂载、中心connected，最终错误为启动超时。进一步仅运行创建设备终端合并点击与真实登录启动两个用例，第二项仍失败（/tmp/coflux-startup-wire.log，2项中1失败，20.915秒，exit65）。

测试专用StartupTraceTransport记录消息类型和长度，不记录凭据、路径或正文。确认taskStart经过发送路径，收到preparedDeviceOperation以及ok的deviceRelayGrant，设备面有发送和接收流量；尚未区分设备操作执行阻塞、消息分发或fixture残留pending operation。此时不能声称根因已定位，也不能通过修改超时或跳过测试消除失败。19983隔离fixture仍保留供后续追查。

## 2026-09-08：捕获 vt100 单行屏幕崩溃并修复

更正此前最小组合结论：19983已进入异常状态，不能据此认定两个用例之间有必然顺序依赖。新建带 COFLUX_TEST_DEBUG=1 的19984 fixture后，同一两项组合通过（/tmp/coflux-startup-clean-payload.log，exit0）。随后完整运行在daemon日志捕获vt100 0.16.2 grid.rs:683的attempt to subtract with overflow，随后sessions.rs:1021出现PoisonError（/tmp/coflux-startup-debug-fixture.log）。worker仍回应ping，而sessionCreate不再完成。旧19873/19983对应supervisor已不在进程表，worker成为孤儿；19984则捕获到了线程panic，不能把这些不同观察都称为进程崩溃。

独立Rust复现：TerminalState::new(1,4,16)接收abcde，即自动换行发生行号0减1下溢，/tmp/coflux-single-row-repro.log确认失败。将vt100 0.16.2源码及许可保存在vendor/vt100，通过Cargo patch固定；唯一产品源码改动为col_wrap在上一行滚出屏幕时更新历史行wrap，避免对可见行索引做下溢运算。最小用例通过（/tmp/coflux-single-row-fixed.log）；supervisor64项通过（/tmp/coflux-supervisor-vt100-regression.log，0失败）。原生全套尚未用新daemon验证，仍不得宣布回归通过。

## 2026-09-08：修复后完整验收恢复通过

重新构建含vendor/vt100修复的daemon，在19985全新fixture运行原生完整回归：201项，194通过、7钥匙串项跳过、0失败，170.493秒，TEST SUCCEEDED、exit0（/tmp/coflux-vt100-fixed-full.log）。原先失败的启动、P2P和离线关闭均通过，daemon未出现panic。诊断消息追踪已从测试中移除，保留超时状态诊断；本次回归带追踪，性能采样不作为正式基准。单行Rust用例进一步验证历史内容abcd、wrap标记，以及无历史时的正常换行，/tmp/coflux-single-row-history.log通过。

独立容器coflux-vt100-blackbox-20260908基于已验证镜像，复制本次Cargo配置/lock、vendor和sessiond源码后重新编译，未挂载宿主目录或端口。黑盒265项中264通过、1跳过、0失败，298.201秒，exit0（/tmp/coflux-vt100-blackbox.log）。容器已stop并自动删除；19983、19984、19985三套诊断fixture均SIGTERM正常退出并清理。旧19873手动验收环境及其用户准备文件未删除。
# 2026-09-08：无可见面积时保留终端网格

直接向当前 Ghostty 视图施加零宽、零高和零尺寸布局，复现 114×34 网格缩为 1×1；修复前回归有4处断言失败，日志 `/tmp/coflux-empty-layout-before.log`（exit65）。这证明尺寸处理的边界问题，不证明此前 supervisor 崩溃必由 SwiftUI 临时布局触发。

`updateSurfaceSize` 在宽或高为零时保留已有网格；有效布局恢复后继续同步，1像素高的有效单行终端仍支持。修复后 TerminalUploadTests 36项全部通过，6.539秒，TEST SUCCEEDED，exit0，日志 `/tmp/coflux-empty-layout-after.log`。测试不依赖远端 fixture，不访问钥匙串。本轮没有重跑原生全套，之前201项结果仍对应此前版本。
# 2026-09-08：tmux 完整交互实操

使用包含零尺寸布局修复的 Performance 产物，内存凭据连接新隔离环境19986（`/tmp/coflux-tmux-fixture.json`、`/tmp/coflux-tmux-fixture.log`）。本机原无tmux，本轮通过Homebrew安装3.7c，日志`/tmp/coflux-tmux-install.log`；使用独立socket `coflux-native-19986`、`-f /dev/null`，不接触其他tmux会话。

CUA在原生窗口登录admin/admin并启动任务`9d01ce83-e709-4df3-b149-f647ca58bbeb`。启动tmux后截图确认备用屏幕和状态栏。Ctrl-B、%左右分屏；右侧输入并执行`echo RIGHT_中文_😀`，Ctrl-B、Left切回左侧执行`echo LEFT_ONLY`。只读tmux查询确认两pane各118×49、左侧active=1，capture-pane内容与截图一致。

Ctrl-B、z放大左侧并恢复；⌘T新建第二终端后点击首标签，截图确认两侧内容、分隔线与状态栏完整。Ctrl-B、d脱离后恢复外层shell历史；重新attach后两侧内容完整，tmux实际client为237×50。依次Ctrl-D退出左侧、右侧：先恢复单pane布局，最后显示`[exited]`并恢复原shell命令历史。最终独立socket查询显示no server running。

CUA paste仍报告剪贴板读取超时，但每次截图均确认粘贴已进入命令行，因此没有重复发送。中文与emoji属于粘贴验收，不当作系统输入法候选窗通过。此次没有验证tmux鼠标拖动、copy-mode或公网重连，也不据此宣称所有终端应用兼容。

客户端已正常⌘Q退出（exec28112 exit0）；fixture收到TERM后正常清理（exec59611 exit0），确认19986无监听，fixture节点与其supervisor/worker已退出。其他环境和生产daemon未更改。Homebrew安装的tmux保留供后续使用。
# 2026-09-08：Shift选择与鼠标报告边界

新增AppKit事件回归，逐一开启1000、1002、1003及1006模式。普通拖动向终端发送鼠标按下、不产生本地选区；Shift拖动完整选择`selection-中文😀`，不关闭远端鼠标模式。1000/1002不产生输入；1003仅允许带Shift的无按钮悬停报告（SGR 39），不允许按下/拖动/释放泄漏。

首次断言要求1003完全无字节，因此失败（`/tmp/coflux-shift-mouse-modes.log`，exit65）。检查Ghostty的cursorPosCallback后确认它有意保留按下前悬停；当前xterm也单独处理无按钮mousemove。修正断言以区分悬停与选择后，整组TerminalUploadTests 37项全部通过，6.778秒、TEST SUCCEEDED、exit0，`/tmp/coflux-shift-mouse-final.log`。本轮没有修改产品鼠标实现。

平台差异明确保留：当前Web的xterm在macOS上仅当macOptionClickForcesSelection开启时用Option强制选择，而项目未开启该选项。原生Shift选择为Ghostty能力，不将本项记录为Web与原生手势完全一致。真实tmux鼠标操作、系统输入法和Finder拖放仍待实操；本项只是原生事件和字节边界的自动验证。
# 2026-09-08：删除确认逐屏实操

最新Performance产物连接19988独立fixture（`/tmp/coflux-confirm-fixture.json`），通过CUA验证真实sheet。对照当前Web workbench.tsx，工作区删除、终端停止关闭、设备移除的标题/说明/按钮文案一致。原生400pt暗色确认框截图可读、文字完整换行；未做Web同屏像素差分，不据此宣称完全像素一致。

工作区`c341810c-5ae0-4dd6-a07f-f5f436e511c8`：初始焦点在关闭按钮，Return未触发删除，Escape取消后仍在侧栏。重开并点击删除，侧栏条目消失；只读检查确认临时worktree目录不存在，而仓库`coflux-test-repo-aDgj8F`中的`native-ui`分支仍在，与提示一致。

终端`3178070b-06fb-4162-833e-a9377d4b3758`：先启动真实shell，再点击关闭。确认框提示先停止shell、删除Tab且不保留历史。Return没有执行，Escape取消后标签保留；再次确认后标签移除、工作区显示无终端空态。设备移除框也完成Return不执行及点击取消验证，设备仍在线；未实际移除设备。

本轮未改产品代码。客户端⌘Q正常exit0，fixture节点60401收到TERM后完整清理、exit0，19988已无监听。没有触及生产daemon。项目移除弹窗、真实IME/Finder拖放及剩余性能/网络验收仍未完成。
# 2026-09-08：当前版本完整原生回归

19989全新隔离fixture运行当前Performance构建，204项：197通过、7钥匙串项明确跳过、0失败，167.330秒，TEST SUCCEEDED、exit0。日志`/tmp/coflux-current-acceptance-full.log`，fixture配置`/tmp/coflux-current-acceptance-fixture.json`。覆盖最近的零尺寸布局、连接忙态与鼠标报告边界增量；真实目录/Git/工作区生命周期、持续输出输入、重连、八路终端切换均通过。

当前测试产物资源/直接链接/许可文本/临时签名审计通过，`/tmp/coflux-current-acceptance-audit.json`。测试产物含XCTest支持框架，本项不是正式分发签名或公证验收。整组运行中的性能采样不用于替代此前独立对照；本次通过也不消除此前三轮基线中的准备超时历史。

本轮完整回归结果取代201项作为当前版本的回归索引，但系统IME、Finder跨窗拖放、剩余UI/网络与完整性能/分发验证仍未完成。
# 2026-09-08：系统输入源对照与待人工选词

CUA读取系统键盘设置：已有ABC、简体拼音及另一输入源；上一个输入法为Ctrl-Space，下一个为Ctrl-Option-Space，两者启用，未修改系统设置。TextInputMenuAgent的读取超时，改用系统设置确认快捷键。

新19990隔离fixture中，当前Performance的终端1（`e3f0ad62-93c1-458a-b38d-6f131135e5b5`）经Ctrl-Option-Space后按n、i，只显示ASCII ni。随后在系统TextEdit新建的空白文稿执行相同操作，也只得到ni及英文自动修正提示，没有拼音候选窗。这个对照不足以将问题归因于Coflux，亦不能证明系统输入法通过。TextEdit临时文稿已丢弃，终端输入已清空，未执行ni命令。

已请求用户用物理键盘在CofluxPerformance终端1选择“你好”，确认候选窗位置与提交结果；待答复，不能自动计作通过。为保留可操作环境，19990 fixture和App保持运行：配置`/tmp/coflux-ime-live-fixture.json`，日志`/tmp/coflux-ime-live-fixture.log`、`/tmp/coflux-ime-live-app.log`；exec句柄93743（fixture）、54933（App）。后续先验证进程存活，不依赖旧记录猜测。用户完成或无需保留后正常退出App并TERM对应fixture节点清理。
# 2026-09-08：图片方向变换避免创建额外原图

`UploadPreparation.image` 对EXIF方向2–8的图片，现从ImageIO元数据读取像素尺寸，直接生成应用方向变换的图像；不再先调用CreateImageAtIndex创建一份未旋转原图来获取尺寸。普通方向仍沿原路径解码，格式保留、压缩阶梯和预算不变。这里只确定减少一次图像对象创建路径；ImageIO可能延迟解码，尚未测量实际峰值内存或耗时收益，不声称省掉两次完整像素解码。

为保留19990输入法窗口，独立进程编译当前TerminalUpload.swift中两个准备枚举（截止UploadTerminalView之前），运行现有三个图片用例的内容；XCTest断言替换为失败即终止的precondition/throw，不启动NSApplication。TIFF可解码、EXIF旋转尺寸及超预算图片压缩预算检查全部通过，`/tmp/coflux-image-headless.swift`、`/tmp/coflux-image-headless-run.log`，IMAGE_CHECKS_FINISHED，exit0。初次编译缺XCTest模块，随后独立断言方式编译通过；这不是Xcode测试套件运行。

实际工程build-for-testing通过（`/tmp/coflux-image-single-transform-build.log`，TEST BUILD SUCCEEDED、exit0）。上次204项全套早于本次图片改动，本次尚未重跑全套或大图剪贴板实操。输入法人工验收窗口未关闭。

# 2026-09-08：tmux 鼠标与复制模式实操补验

在保留的19990隔离环境中新建终端2（e62974ff-0ff2-4969-9096-7c512f3235ee），使用独立socket coflux-native-mouse-19990、tmux -f /dev/null；通过CLI仅配置mouse on和初始左右分屏，交互由CUA驱动。点击左pane后tmux查询active由%1变%0；拖动终端分隔线后两pane从118/118列变141/95列。

粘贴printf命令显示COPY_中文_😀_END；从第二字符开始鼠标拖选，tmux show-buffer精确返回OPY_中文_😀_END，中文与emoji完整。滚轮上滑后界面出现历史指示，tmux查询%0为mode=1、name=copy-mode、scroll=4；按q后mode=0。证据保存在/tmp/coflux-tmux-mouse-evidence.json。这里只验证tmux缓冲区，不将其视为系统剪贴板读取验收。Ctrl-B与bracketleft自动输入未确认进入模式，不记为快捷键通过；CUA typeText对Unicode命令丢字符，改用paste后画面确认完整，未计作输入法测试。

操作中误拖侧栏分隔线，已通过CUA恢复原宽度。独立tmux服务器已停止，原shell恢复[server exited]；随后Ctrl-D结束临时shell，终端2显示已退出。已切回终端1供用户继续物理输入法验收，19990环境保留。未改产品代码、生产daemon或系统设置。

# 2026-09-08：项目移除确认框实操

在19990保留环境通过项目coflux上下文菜单打开移除框，CUA确认标题“移除项目「coflux」？”、正文“项目记录和它的子工作区会从 coflux 中移除，主仓库本身不会被改动。此操作无法撤销。”和确认按钮“移除项目”与当前apps/web/src/components/workbench/workbench.tsx的requestRemoveProject一致。截图显示正文完整换行，无截断；初始焦点位于关闭按钮。按Return后对话框保持，未执行移除；Escape后项目、main及native-ui工作区仍在。重新打开并点击取消，同样保留项目和工作区。

本次仅确认框、焦点及取消行为；未执行项目移除，不将其计为实际删除生命周期或Web同屏像素差分。19990及输入法验收终端保留。

# 2026-09-08：项目移除级联生命周期集成验收

增强NativeIntegrationTests.testDesktopDirectoryGitAndWorkspaceLifecycle：以前移除项目之前已删光子worktree，现留下native-background真实worktree，通过WorkbenchModel.remove（确认框使用的方法）执行。验证对话框关闭、项目及全部子工作区记录消失、子worktree目录删除；通过仍存在的fixture基础工作区执行Git检查，主仓库show-ref与HEAD前后完全一致，未跟踪marker文件保留。仅测试自己的UUID嵌套仓库，结束才清理测试仓库。

19994新隔离环境，Performance临时签名且关闭钥匙串路径。首轮构建后运行在0.509秒抛出CancellationError（TerminalOutputPump.waitForReceiveCapacity位置），未到新增移除断言，根因尚未确定。相同产物重跑通过3.884秒，随后三轮通过3.619/3.082/3.061秒，exit0。日志/tmp/coflux-project-removal-test.log、/tmp/coflux-project-removal-retry.log、/tmp/coflux-project-removal-three.log。后续通过不等于修复首次连接取消。未修改产品代码，也未重跑全套。

# 2026-09-08：生命周期偶发取消诊断

为testDesktopDirectoryGitAndWorkspaceLifecycle添加NATIVE_WORKSPACE_LIFECYCLE阶段和Task.isCancelled记录，失败时保留最近阶段；不吞异常、不重试测试内部操作。审查DeviceRouter的通道接收取消与pending请求路径未找到足以认定首轮根因的证据，未改产品逻辑。19995新隔离环境10轮通过，28.117秒，全部phase=完成/taskCancelled=false。日志/tmp/coflux-lifecycle-diagnostic-ten.log；fixture调试日志/tmp/coflux-lifecycle-diagnostic-fixture.log。之前0.509秒CancellationError仍保留为未解释偶发问题，不能宣称已修复。

# 2026-09-08：Finder 拖放重试未形成通过证据

使用19990终端2（e62974ff-0ff2-4969-9096-7c512f3235ee）及临时目录/var/folders/t8/9n03v5314030xfnq_vz_8k200000gn/T/coflux-finder-drag-88x53kp9，文件“中文 空格 😀.txt”53字节。Finder缩小后两次CUA跨窗口drag均未见终端路径或上传结果；工具缺少最终落点证据，不归因于客户端，也不计通过。

尝试Finder复制后粘贴只产生png上传路径，未证明文本文件上传；检查当前Web terminal-pane.tsx handlePaste及原生TerminalUpload.swift paste，两者均只专门拦截图像，不将文件复制当作拖放等价验收。未更改产品逻辑。终端2未执行输入已Ctrl-U清空，切回终端1保留输入法验收。新Finder目录和测试文件保留；旧19873拖放环境不应继续用于验收。此项仍需真实拖放证据，不再重复无落点信息的自动动作。

## 2026-09-08 最新提示构建的变更页实操

20015独立Release后端，App副本位于`/tmp/coflux-tooltip-ui/CofluxPerformance.app`，由215项全套通过的构建复制，仅将测试服务器plist键改为20015并临时重签。19873已有其他服务，未占用或停止；未访问钥匙串。

CUA正常登录后，通过临时仓库创建中文命名TypeScript文件（三行、中文emoji、长行RIGHT_EDGE）和二进制文件。实际截图显示2个文件、+3 −0、二进制标识和原生高亮。普通CUA横滚调用未移动；调用滚动区域公开的Scroll Right动作后滚动条为1，截图明确显示RIGHT_EDGE。折叠后正文与横向滚动区域移除、卡片高度收敛；重新展开后正文恢复且滚动条为0。两次折叠按钮操作返回AXError.failure，但随后新AX树和截图均确认实际动作成功，不能据工具错误推断产品失败。

这证明当前构建的上述呈现与辅助功能操作；不代表物理触控板横滚、真实悬停或Web像素差分完成。CUA没有鼠标悬停接口，本轮未将点击代作悬停验收。App副本已退出，20015 fixture根进程正常退出并清理；19990保留。

## 2026-09-08 侧栏操作入口源码逐项核对

依据当前Web `apps/web/src/components/workbench/sidebar.tsx`与原生`Sources/SidebarView.swift`，逐项核对而非从已有测试数量推断：

| 对象 | Web入口 | 原生入口 | 结果 |
| --- | --- | --- | --- |
| 项目 | ContextMenu：新建工作区、重命名、移除；行尾加号 | contextMenu同三项；行尾新建工作区按钮与分支popover | 功能入口一致 |
| 工作区 | ContextMenu：重命名，非主工作区才显示删除；行尾关闭 | contextMenu同条件；SidebarRowAction同样排除主工作区 | 功能及主工作区删除限制一致 |
| 设备 | ContextMenu：重命名、移除；行尾移除 | contextMenu同两项；SidebarRowAction移除 | 功能入口一致 |
| 路径/详情说明 | 项目repoPath及本地session徽标title；工作区/设备自定义Tooltip | 项目与徽标help；工作区/设备accessibilityHint加原生独立浮层 | 未发现同一控件重复绑定两类提示 |

本项仅证明当前源码入口与条件对应，未将它替代右键、键盘菜单导航或物理悬停验收。本轮无产品代码修改，无需重复已通过的原生测试。用户体验窗口保持运行，输入法/拖放反馈仍待回复。

## 2026-09-10 用户反馈后的Tooltip修正

用户截图明确推翻此前“提示已对齐”的结论：白色背景错误，提示偏离悬停行且跳动，动画不一致。根本审查遗漏是只读Astryx默认样式，未读`apps/web/src/main.tsx`的cofluxTheme覆盖。实际应为#1b1b1b背景、#fafafa前景、12pt通用正文、10pt圆角、横8纵4内边距，并保留shadow-high的浅色内描边。

原生修正工作区/设备/通用提示配色；默认按钮上方、终端OSC标题下方、侧栏右侧。跟随layerAnimations的165ms、cubic-bezier(0.24,1,0.4,1)、0.95缩放、方向位移8pt，尊重系统减少动态效果；只在首次展示入场，内容更新不重播。NSHostingView关闭自动尺寸推导，复用同一承载视图，内容刷新延后到布局完成后，定位使用完整行bounds，避免裁剪坐标影响中心位置。

新增真实SwiftUI行锚点回归：同内容与多行内容更新保持对准同一行，hostingView身份不变，更新不重播入场；另覆盖默认上方与顶部翻转。精简无网络源码回归5项通过；最终完整工程WorkspaceTooltipTests10项+DeviceTooltipTests2项全通过、0失败、exit0。工作区和通用提示原生渲染图已查看，确认深色。

初次完整构建因/tmp依赖目录被清理重新下载，单个Git传输极慢；中止该次构建后仅在构建进程使用HTTP/1.1重试成功，没有修改全局Git配置。完整工程日志`/tmp/coflux-tooltip-correction-retry.log`；普通App构建`/tmp/coflux-tooltip-corrected-app-build.log`；审计`/tmp/coflux-tooltip-corrected-audit.json`通过，只有两个Mach-O、无脚本资源/直接Web runtime链接、临时签名完整。

已通过CUA替换运行旧App，启动持久目录`.coflux-dev/macos-current/CofluxPerformance.app`并登录19990，两个终端会话恢复。此次不再要求用户先完成其他人工验收才修复Tooltip；未宣称物理悬停/动画实测已完成或整个原生目标完成。

### 2026-09-10：终端实际彩色画面验收

- 用户反馈 Claude 首页全黑白；真实 PTY 读回 `COLOR_ENV=1 TERM=xterm-256color`。隔离 daemon 继承自动化宿主 `NO_COLOR=1`，不是 Ghostty 缺少调色板。`scripts/dev-fixture.mjs` 已移除新 fixture 的该环境变量；现存 shell/Claude 进程仍保留原启动环境。
- `NativeIntegrationTests.testRealTerminalColorRendering` 使用新建任务，先选择目标工作区并严格校验任务 ID，再输入；清除 NO_COLOR 后经真实 PTY → Device → Ghostty Metal 渲染 ANSI 色块及 Claude 完整首页。
- 由有屏幕权限的开发宿主按测试输出的 `/tmp/coflux-native-color-validation/capture-request.json` 捕获指定窗口；窗口图像只在终端矩形内统计彩色像素，排除侧栏、标签页的颜色。ANSI 彩色采样点 5226，Claude 首页 2670；测试通过，10.334 秒。
- 本地证据保存在 `.coflux-dev/terminal-color-validation/`，包括两张实际窗口截图和完整测试日志。它证明本次颜色路径，不代表全终端性能验收完成。
- 首轮验收脚本未切换工作区且未严格校验目标任务，误向已有 Claude 输入了两条颜色诊断命令。该轮无效；脚本已修正并重跑通过，所有自建诊断任务已清理。

### 2026-09-10：当前隔离 daemon 环境修复完成

用户明确同意中断测试会话后，已重启 19990 对应的隔离 supervisor，并从其启动环境移除 NO_COLOR。临时 home 中 credentials.json 已丢失，已在该实例的独立测试数据库中轮换原设备凭证并恢复文件（0600），保持设备 ID `8816d305-7d52-422d-8a32-fb66fe8a4b7c` 及项目数据不变。新 supervisor PID 36890，记录在 `.coflux-dev/terminal-color-validation/daemon.pid`；它独立运行，原 fixture 父进程的旧 supervisor 句柄不再负责其清理。未改动生产 daemon。

复测已删除测试里的 unset 和 env 覆盖：新 shell 原样返回 `COLOR_ENV= TERM=xterm-256color`，直接运行 `claude` 后完整首页彩色。ANSI 5226、Claude 2651 个彩色采样点，测试 9.744 秒通过。最新日志为 `.coflux-dev/terminal-color-validation/coflux-native-clean-daemon-color-retry.log`，截图已更新。此前“当前 daemon 仍污染”的状态已被本次实际重启和复测消除。
