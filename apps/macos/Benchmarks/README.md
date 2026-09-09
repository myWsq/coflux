# 终端同负载组件基准

当前结果保存于 results-2026-09-08.json。两端 8 个未挂载终端、142×34 网格、10000 行历史，每个 5000 行相同中文/emoji/ANSI 文本，总计 2280096 UTF-8 字节。实例构造不计入，输入构造计入；完成后等待一个心跳回合再停止心跳计时，全文断言在计时后执行。

原生沿用产品 TerminalOutputPump 和 Ghostty 配置。ghostty_surface_feed 同步执行 processOutput；队列排空为本组件处理完成，Metal 可见呈现不在计时内。Web 使用当前工作区 xterm 6.0.0 的公开 write 接口，固定 4KiB 块同步入队，最后一个 write 回调为解析完成。两者生产调度策略不同，不强行统一内部调度。均验证完成标记与流隔离。

从仓库根目录运行 Web 基准：

    apps/web/node_modules/.bin/vite --config apps/macos/Benchmarks/vite.config.mjs

打开 http://127.0.0.1:15276/，点击运行按钮。页面运行一次预热和五次采样并展示原始 JSON。此页是 Web 测量工具，不属于原生工程的 Sources 或打包资源。

原生在同一宿主进程重复六次，首轮作为预热：

    env -u COFLUX_KEYCHAIN_DEV -u COFLUX_KEYCHAIN_TESTS xcodebuild test \
      -project apps/macos/Coflux.xcodeproj -scheme Coflux \
      -configuration Performance -destination 'platform=macOS' \
      -derivedDataPath /tmp/coflux-macos-093-build -skipPackageUpdates \
      ENABLE_TESTABILITY=YES CODE_SIGN_IDENTITY=- ONLY_ACTIVE_ARCH=YES \
      -only-testing:CofluxTests/TerminalPerformanceTests/testConcurrentTerminalOutputKeepsMainActorResponsiveAndIndependent \
      -test-iterations 6 -test-repetition-relaunch-enabled NO

先结束一端采样再运行另一端。原生日志必须显示 cols=142、rows=34，否则先调整 Web 网格，不直接比较。主线程心跳均请求 2ms；系统计时器精度和浏览器调度仍可能不同。不将原生进程 footprint 与浏览器 JS 堆大小直接比较。

2026-09-08 五轮中位数：原生完成 30.67ms、最大心跳间隔 11.71ms；Web 完成 56.40ms、最大心跳间隔 48.30ms。该结果仅覆盖当前组件突发负载，不能证明可见工作台帧率、输入延迟、启动或真实网络表现，也不是整体目标验收完成。

## 可见终端模式

勾选“显示一个终端，其余后台”后运行 Web 基准；原生把上述命令的测试名替换为 testVisibleTerminalOutputKeepsMainActorResponsiveAndIndependent。原生使用真实 1000×600pt 窗口，挂载首个 Ghostty 视图，将另外七个设为不可见；Web 挂载首个 xterm 到 1000×600px 容器，使用 Menlo 12px、1.25 行高，另外七个不挂 DOM。两端固定 142×34 网格。

results-visible-2026-09-08.json 保存本轮数据。一次预热后五轮中位数：原生处理完成 24.80ms、最大心跳间隔 7.32ms；Web 处理完成 66.20ms、最大心跳间隔 59.40ms。原生日志 /tmp/coflux-visible-native-six.log，六轮输出独立性检查通过。

计时仍在输出处理完成时结束，可见渲染在其间参与调度，但没有等待 GPU 呈现完成。原生的后台 surface 明确设置不可见，Web 后台终端不挂 DOM；不将本轮与旧的全部未挂载结果直接相减来解释渲染成本。窗口构建和首次显示等待不计入，也没有运行完整工作台、实际网络或测量键盘到屏幕延迟。

## 原生真实输入链路基线

独立测试入口为 NativeIntegrationTests/testRealInputRoundtripThroughPTY，沿用 Performance 构建命令，并设置 COFLUX_NATIVE_TEST_URL=ws://127.0.0.1:19873/client。需要现有隔离 fixture，不设置额外测量开关。该入口执行实际 RootView、登录、新建独立 PTY、输入测量，随后继续终端切换、上传和重连回归并清理创建的任务。

PTY 内运行临时 Python 应答程序，关闭本地回显，每次只返回 ACK 加唯一探针；启动程序经过 base64 编码，避免 shell 命令回显中的准备标记造成假阳性。从 Ghostty 文本提交入口和回车事件开始计时，以实际终端缓冲区出现匹配确认结束。一次预热加三十次采样，轮询请求间隔 1ms，包含轮询/读取开销；结束时恢复 PTY 设置，不写临时程序文件。

2026-09-08 本机隔离 relay 路径：中位数 7.26ms，P95 12.14ms。原始数据在 results-input-native-2026-09-08.json；日志 /tmp/coflux-native-roundtrip.log，整项测试 6.520 秒通过。它不是物理键盘到屏幕的延迟，没有等待 GPU 呈现，不包含公网或高负载并发，也尚无同场景 Web 输入对照。后续需要扩展这些条件。

## 持续输出时的真实输入（2026-09-08）

新增 NativeIntegrationTests/testRealInputRoundtripDuringPTYOutput。沿用同一真实 RootView 和隔离 PTY，Python 每约 5ms 尝试输出 16 行 ANSI 中文/emoji/ASCII，每个输入探针间等待 20ms（不计入往返）。ACK 附带输出字节计数，逐次断言增加，最终观测 257792 字节。属于单个前台终端持续输出，不是多终端饱和压力测试。

采样仅通过 readText(viewport: true) 读取当前视口。最初反复读完整历史得出中位 38.88ms、P95 79.54ms，随历史累积的读取成本污染了测量，因此不采用。准备标记可能被输出滚出视口，准备阶段仍读取历史，且在计时外；首轮视口版本因此未进入采样的失败已修正。

修正后 1 次预热、30 次采样：持续输出中位 9.52ms、P95 20.59ms；同样视口读取的空闲对照中位 7.87ms、P95 12.08ms。两份原始结果分别为 results-input-native-loaded-2026-09-08.json 与 results-input-native-viewport-2026-09-08.json。负载用例及随后切换、上传、重连完整通过，9.240 秒，日志 /tmp/coflux-native-roundtrip-loaded-final.log，TEST SUCCEEDED、exit 0；空闲入口在 /tmp/coflux-native-roundtrip-viewport.log 单项通过，但该次整体运行包含上述准备阶段失败，不能说整次通过。

这仍是本机 relay 到终端缓冲区的测量，含 1ms 轮询开销；未等待 GPU 呈现，也没有同条件 Web、公网或多终端压力对照。没有修改产品逻辑。

## 完整工作台：8 个真实终端切换（2026-09-08）

新增 NativeIntegrationTests/testWorkbenchSwitchPerformanceWithEightLiveTerminals，使用 Performance 构建及 COFLUX_NATIVE_TEST_URL=ws://127.0.0.1:19873/client。相同进程重复三轮时添加 -test-iterations 3 -test-repetition-relaunch-enabled NO。每轮创建并最终清理8个独立PTY，历史基线使用真实RootView窗口1360×800pt（当前入口已改为下节1280×684pt），测量时只挂载这8个终端，工作区共40个标签（包括fixture既有任务）。每个终端先从PTY接收5000行历史，准备命令以base64封装，避免回显标记造成误判。

每阶段先5次预热，再60次循环切换；model.activate开始计时，目标NSView成为firstResponder且Coordinator.active为true时结束，以1ms间隔轮询。每次之后等待20ms。主线程心跳请求2ms；CPU与physical footprint均为原生测试进程。持续输出阶段8个Python程序各约每5ms写16行中文/emoji/ASCII，逐路验证输出计数前进、没有其他终端的标记，切换前后原NSView仍在视图树内。准备及清理不计入阶段时间，CPU阶段时间包含预热和切换间等待。

三轮统计的中位数：

| 阶段 | 切换中位数 | 切换P95 | CPU时间 | 阶段墙钟时间 | 最大主线程心跳间隔 |
| --- | --- | --- | --- | --- | --- |
| 空闲 | 18.65ms | 21.62ms | 1.867s | 2.572s | 20.82ms |
| 8路持续输出 | 18.62ms | 22.30ms | 2.785s | 2.512s | 20.61ms |

原始三轮数据、内存值、输出计数和宿主信息见 results-workbench-switch-2026-09-08.json，日志 /tmp/coflux-workbench-switch-before-three.log，3项重复均通过。MacBookPro18,3、10逻辑CPU、macOS27.0。先前首次试跑仅用于打通基准，不混入三轮统计。

试验性地把视图内重复派生列表计算收敛到每次更新一次后，三轮切换中位数19.18/19.33ms，CPU时间1.821/2.717s；没有证明性能收益，已撤回这两处产品改动。负结果保存在同一JSON的rejectedCachingExperiment字段，日志 /tmp/coflux-workbench-switch-after-three.log，三轮通过。没有据此声称当前实现变快。

限制：基准测的是调度到原生焦点就绪，不是物理点击到屏幕、帧稳定性或GPU呈现；负载生产速度受系统调度影响，并非饱和吞吐测试。CPU和内存不能与浏览器单个进程/JS堆直接比较。该历史轮次没有Web工作台对照；当前尺寸对照见下节，跨NAT或公网仍未测量。

## 工作台调用栈采样及滚动试验（2026-09-08）

基准在每个阶段计时外原子写入 .coflux-dev/macos/native-switch-profile-phase.json，包含runID、pid、loaded和sampling/finished状态。先在独立终端启动以下观察器，再运行单次工作台基准（不要同时做正式基线采样）：

    python3 apps/macos/scripts/profile-workbench-switch.py \
      --phase-file .coflux-dev/macos/native-switch-profile-phase.json \
      --app-executable /tmp/coflux-macos-093-build/Build/Products/Performance/CofluxPerformance.app/Contents/MacOS/CofluxPerformance \
      --output-dir /tmp/coflux-switch-profile

观察器仅接受启动后的阶段文件，核对实际进程可执行文件路径和同一runID，对idle/loaded各调用sample 1秒，间隔1ms。未等到两阶段会超时失败；不启动或安装其他服务，不访问钥匙串。采样轮包含观察器干扰，不能混入耗时基线。

首轮采样/tmp/coflux-switch-profile-{idle,loaded}.txt：主线程分别24、356个堆栈快照。空闲样本太少，不能用于精确分摊成本；持续输出中55个快照包含ScrollViewProxy.scrollTo调用链，指向标签切换后的滚动请求。递归栈计数不互斥，不能直接换算CPU时间百分比，终端处理样本较少也不能证明它没有成本。

据此试验只在标签未完整可见时scrollTo，两种版本的原有标签滚动验收和3轮基准均通过，但性能未显示一致收益：

| 方案 | 空闲切换中位数 | 8路输出切换中位数 | 空闲/输出CPU时间 |
| --- | --- | --- | --- |
| 原实现基线 | 18.65ms | 18.62ms | 1.867/2.785s |
| 可见标签集合参与状态更新 | 19.26ms | 19.33ms | 2.014/2.855s |
| 几何缓存不触发视图更新 | 17.50ms | 20.09ms | 1.771/2.919s |

两种产品改动均撤回，完整原始数据及P95、心跳间隔等在results-workbench-scroll-experiments-2026-09-08.json。不能将最后一种的空闲改善独立报告成整体提速；也没有足够统计证据把这些小差异精确归因。保留原行为，后续优先补完整工作台Web对照及尚未完成的系统交互验收，避免围绕这一个局部继续猜测。

## 当前完整工作台 Web／原生对照（2026-09-08）

原始数据见 results-paired-workbench-2026-09-08.json。两端依次各运行三轮，不并行采样。工作台1280×684、2倍像素、40标签、8个本轮真实PTY、每路5000行历史；持续输出阶段先让全部程序就绪，再统一发送go，避免先开始输出的终端拖慢其他程序准备。每阶段5次预热、60次采样，1ms轮询，采样之间等20ms，心跳请求2ms。

Web入口使用当前 apps/web 的真实 Workbench、React compiler、Tailwind 和 xterm，只在 Benchmarks 下构建；不进入原生包。先做独立类型检查与生产静态构建，再启动本机preview：

    node_modules/.bin/tsc -p apps/macos/Benchmarks/tsconfig.workbench.json
    apps/web/node_modules/.bin/vite build --config apps/macos/Benchmarks/workbench.vite.config.ts
    apps/web/node_modules/.bin/vite preview --config apps/macos/Benchmarks/workbench.vite.config.ts

打开 http://127.0.0.1:15278/workbench.html，使用浏览器默认1280×720、DPR2（36px控制栏不计入工作台）。点击“运行一次隔离基准”，8路准备后确认布局再点击“开始采样”。需要19873隔离fixture；只连接该fixture，测试任务使用独立switch-benchmark前缀，每轮等待“清理完成”后才开始下一轮或关闭页面。结果自动保存至 `.coflux-dev/web-workbench-results`。入口记住本入口未清理的前缀，重载后下一轮恢复清理。不要在测量期间重载、切换窗口或更改viewport。

| 阶段 | 原生中位数 / P95 | Web中位数 / P95 | 原生 / Web最大心跳间隔 |
| --- | --- | --- | --- |
| 空闲 | 18.50 / 21.20ms | 12.40 / 13.40ms | 21.93 / 18.10ms |
| 8路持续输出 | 17.71 / 20.37ms | 12.75 / 14.00ms | 20.70 / 17.90ms |

表中每项是三轮对应统计量的中位数。当前场景Web焦点就绪更快，不能声称原生整体性能已优于Web。原生测model.activate至firstResponder且Coordinator.active；Web测真实标签button.click至目标textarea取得焦点且面板可见。均未等待GPU呈现，不是物理输入到屏幕延迟。

保留产品实际行为：原生网格145×37、Web143×37；原生挂载8个终端视图、Web挂载40个xterm实例；原生选择后将标签自动滚入视口，当前Web没有这个行为。因此这不是同内部工作量的纯框架/渲染核心比较，也不能用它单独解释性能差异。CPU和内存不作跨浏览器比较。

原生三轮日志/tmp/coflux-workbench-paired-native-three.log全部通过，Web三轮负载增长、流隔离、视图保活和任务清理均完成。此前开发HMR重载、Tailwind扫描遗漏和DPR1造成的结果均未纳入。1360×800历史基线保留，不能与当前轮次直接混算。

## Instruments Metal 工作台采样（2026-09-08）

新增显式测试开关COFLUX_SWITCH_METAL_TRACE=1，已写入XcodeGen测试方案环境。只在该开关开启时，8路工作台基准先发布preparing阶段并等待15秒供Instruments附加；普通基准不增加等待。这15秒不计入切换阶段。先启动观察器，再用此前Performance测试命令运行testWorkbenchSwitchPerformanceWithEightLiveTerminals，额外设置该环境变量：

    python3 apps/macos/scripts/trace-workbench-switch.py \
      --phase-file .coflux-dev/macos/native-switch-profile-phase.json \
      --app-executable /tmp/coflux-macos-093-build/Build/Products/Performance/CofluxPerformance.app/Contents/MacOS/CofluxPerformance \
      --output-dir /tmp/coflux-metal-capture

观察器只接受启动后更新的preparing文件，核对实际pid可执行路径，调用xctrace Metal System Trace附加25秒，记录阶段观测时间及退出码。不要并行运行其他工作台基准。等待record.json和record.log确认保存完成，再导出toc和数据表。用最终轨迹起止时间核实两个sampling阶段完整包含于记录内，不能只看xctrace退出码。此次核心采集通过/tmp/coflux-record-metal.py实际执行，仓库版本将路径改为命令行参数并通过--help检查。

本轮轨迹/tmp/coflux-workbench-metal-1788817586.trace，目标PID21340，记录26.245秒，两个阶段均完整覆盖；原生测试37.037秒通过，/tmp/coflux-workbench-metal-test-final.log。原始轨迹保留本机；精简结果与阶段观测在results-metal-workbench-2026-09-08.json。首次测试因方案未传入开关而没有采集，不能混入。

Metal的GPU表包含其他进程记录，统计时必须解析XML id/ref并仅筛选目标PID。目标1832条Active事件，通道为Vertex/Fragment。各阶段合并重叠执行区间，避免把同时工作的通道累加成重复时间：空闲阶段402事件、GPU执行区间并集144.33ms（阶段约2.757秒）；8路输出1222事件、并集447.01ms（阶段约2.723秒）。CPU到GPU事件延迟中位/P95分别0.97/2.49ms和0.42/1.16ms。这些是GPU事件统计，不是帧统计或整个设备利用率。

局限：阶段边界以约50ms轮询观察，有误差；Instruments会扰动进程，本轮不能纳入前述无采样基准。displayed-surfaces和present-request导出表没有行，不能用GPU事件数量推导FPS、屏幕呈现或物理输入延迟；potential-hangs没有记录也不能单独证明流畅。仍需有效呈现数据及Web对应测量。

## App Launch诊断录制（2026-09-08，未计为有效启动基准）

通过xctrace App Launch启动Performance可执行文件，设置COFLUX_MACOS_TEST=1及隔离COFLUX_SERVER_URL，录制8秒。轨迹/tmp/coflux-native-launch-20260908.trace可导出，life-cycle-period包含进程创建、系统初始化、AppKit初始化、场景创建和首帧渲染阶段；首帧阶段结束位于1123.90ms。阶段可重叠，不能简单累加duration。

录制命令exit54，轨迹目标33837标记SIGKILL，尚未证实原因；未发现对应CofluxPerformance崩溃报告。这是诊断材料，不纳入正式启动基线，也不能证明正常启动可靠性或优于Web。结果见results-launch-diagnostic-2026-09-08.json。它只覆盖初始登录界面，不含认证或工作台数据就绪。

本轮启动同时留下的33836已按启动时间与可执行路径核对后定向终止；既有等待手动验收的57987保持运行。未访问钥匙串。下一步需明确非零退出和SIGKILL原因，取得稳定可重复的有效启动记录，再做Web对应场景对照。
# 2026-09-08：已连接标签的重复忙态修复

重新检查切换路径发现：DeviceRouter已经跳过持有当前通道控制权的重复attach，但CofluxClient仍在每次startTask时设置attachingTaskIDs并创建500ms定时器。修复为仅在尚无控制权、首次启动或force时进入连接忙态，保留路由层原有接入/尺寸语义。

19987新隔离环境修复前3轮基准中，第一轮在负载程序准备阶段超时，后两轮通过；`/tmp/coflux-switch-indicator-before.log` exit65。原始两轮结果提取至`/tmp/coflux-switch-indicator-baseline.json`。当前为10标签，不能与此前40标签基准直接比较；日志还有DisplayLink创建失败并回退的记录。本轮没有形成可靠的性能前后对照，不能报告整体提速。

独立真实会话回归准确复现三次重激活均错误转圈（`/tmp/coflux-indicator-regression-before-valid.log`，3处断言失败，exit65）。最初用例遗漏consumer注册和running后attach，导致准备超时，记录`/tmp/coflux-indicator-regression-before.log`不作为产品失败证据。修正准备步骤后才进行上述有效复现。

产品修复后，连接状态回归及完整真实输入/标签切换/上传/重连两项通过（5.066秒、exit0，`/tmp/coflux-indicator-regression-after.log`）。首次连接与force的忙态断言同时通过。共享Swift测试74项加3项XCTest通过（`/tmp/coflux-indicator-swift.log`，exit0）。这是明确的状态与重复刷新修复，不是新的整体性能基准。
# 2026-09-08：固定完整工作台的标签负载

原生和Web基准此前仅创建8个采样终端，总标签数依赖fixture残留，导致新环境10标签与旧环境40标签不能直接比较。两端入口现先将背景标签补齐到32，再创建8个采样PTY，并检查总数40；已有标签超过32时要求干净fixture，不删除已有任务。所有补齐任务使用本轮唯一prefix，纳入原有finally/catch清理。准备和清理仍不计入采样阶段。

验证：Web类型检查通过；Vite基准静态构建通过（`/tmp/coflux-fixed-tabs-web-build.log`）；原生build-for-testing通过（`/tmp/coflux-fixed-tabs-build.log`，TEST BUILD SUCCEEDED、exit0）。本次仅修正基准负载并编译验证，尚未运行新入口的两端测量和清理流程；不能据此宣称性能改善。19990原生窗口正保留供用户物理键盘IME验收，避免用测试窗口抢走焦点。

后续独立测量须核对报告workspaceTabCount=40、实际8个采样PTY及每阶段逐路输出前进。原生仍只保留访问过的8个视图，Web可挂载全部xterm，属于两端产品真实行为差异，不强行改成相同内部实例数。
# 2026-09-08：撤回未证明收益的图片对象优化

比较创建原始CGImage再应用EXIF方向与直接读取元数据后变换，两版各3轮交错独立进程（Swift -O），全部功能断言通过。测量包含三组图片样例生成、编解码和固定等待，并非单次压缩的隔离成本。

原版/试验版的中位峰值RSS为106741760/105218048 bytes，中位墙钟0.64/0.62秒；但RSS区间重叠（原版106184704–107069440，试验版103940096–107790336）。不足以证明稳定收益，且试验版增加尺寸元数据依赖，因此已撤回产品改动。原始数据`results-image-object-experiment-2026-09-08.json`，日志`/tmp/coflux-image-measure-*-*.log`；不可据此宣称App省内存或变快。
# 2026-09-08：固定40标签的新一轮两端对照

当前入口已在同一个19991新隔离fixture实跑：原生3轮后Web3轮，全部采样成功并清理本轮任务。两端均40标签、8个采样PTY、每路5000行历史，工作台1280×684、DPR2；Web报告确认documentVisible=visible。原生测试日志`/tmp/coflux-fixed40-native-three.log`，3项通过、63.920秒、exit0。Web每轮页面明确报告清理完成；三份报告合并于`results-paired-fixed40-2026-09-08.json`。

| 阶段 | 原生中位 / P95 | Web中位 / P95 |
| --- | --- | --- |
| 空闲切换 | 17.56 / 20.34ms | 12.30 / 14.00ms |
| 8路持续输出切换 | 17.10 / 19.70ms | 12.80 / 14.60ms |

每个值为对应三轮统计量的中位数，场景中Web仍更快。仅测焦点就绪，不是GPU呈现或整体App性能。原生145×37、Web143×37；原生挂载8个终端、Web40个，原生自动滚动活动标签等既有行为仍有差异。不能据此把差距完全归因于Ghostty或SwiftUI，也不能用历史未固定标签轮次计算提速比例。

Web代理现支持`COFLUX_BENCHMARK_SERVER_PORT=19991`，始终连接127.0.0.1且验证端口范围；不设置时保留19873默认。启动方式：`COFLUX_BENCHMARK_SERVER_PORT=19991 apps/web/node_modules/.bin/vite preview --config apps/macos/Benchmarks/workbench.vite.config.ts`。页面说明已去掉写死的旧服务端口和8个清理任务计数。Web类型检查及静态构建通过。
# 2026-09-08：固定40标签调用栈采样

19992独立fixture、同一runID `switch-benchmark-C49D3EC7-C5D9-4F58-855C-EB735F87F35E`，空闲/持续输出各sample 1秒，目标为本轮测试PID32140。观察器检查可执行文件路径及阶段文件时间；两阶段成功，`/tmp/coflux-fixed40-profile/{idle,loaded}.{txt,json}`、`/tmp/coflux-fixed40-profiler.log`。基准本身通过，`/tmp/coflux-fixed40-profile-test.log`；受采样器干扰的耗时不纳入正式对照。

空闲/输出主线程有158/340个样本。可见SwiftUI AttributeGraph更新、NSHostingView布局和TerminalWorkspaceView.header调用链；scrollTo在各自单条链上有8/21个样本。输出泵在输出阶段的单条链上仅1个样本。调用链嵌套且采样短，不能相加为互斥CPU百分比，也不能据此排除终端成本。

方向：检查标签切换导致的整个header更新范围与SwiftUI调度；不重复此前已撤回的scrollTo缓存猜测。后续实现必须保留标签标题、端口、活动状态、已读标记与悬停更新，并用固定40标签基准和交互回归验证。当前只取得定位证据，尚未证明新的产品提速。

# 2026-09-08：避免标签激活时通知未变化集合

WorkbenchModel.activate及activateCurrent现在只在成员/值实际变化时写入visitedTasks、showingChanges、selectedPendingTerminals及activeTasks；每次显式activate仍递增activationRequests，保留焦点/接管语义。新增Observation回归在原实现准确失败、修改后通过，证明已访问标签切换不再通知未变化集合。17项状态/导航/自动滚动/真实连接回归通过（/tmp/coflux-membership-regression.log）。

性能数据results-membership-observation-2026-09-08.json：19997基线前两轮通过，第三轮在所有负载程序准备阶段失败，exit65；19998新环境修复后三轮通过62.598秒。基线两轮/修复后三轮对应中位数：空闲median17.097/17.443ms，p9519.279/19.749ms，CPU1.634/1.669s；输出median17.896/16.726ms，p9520.547/20.072ms，CPU2.568/2.484s。该对照不完整且非交错，有升有降，不宣称整体提速；保留理由是独立观察通知回归证明减少无效通知，并保留激活行为。

本次全套/tmp/coflux-membership-full.log exit65：可见终端输出用例进程崩溃，freed pointer was not the last allocation。minidump经LLDB读取，顶层为libswift_Concurrency任务内存释放及XCTest路径；不能认定Ghostty根因。相同产物单独三轮该用例通过0.509/0.497/0.498秒，日志/tmp/coflux-membership-visible-retry.log。当前完整验收仍未通过，不用分项通过替代全套结论。

后续完整复核：同一产物整个TerminalPerformanceTests 8项通过1.869秒；19999新fixture全套205项（198通过、7钥匙串跳过、0失败）172.519秒、exit0，/tmp/coflux-current-full-retry.log。前次崩溃未复现，未宣称根因修复。工具链Xcode26.6/Swift6.3.3；swiftlang/swift#75501仅为相似错误参考，不能认定同因。

# 2026-09-08：App Launch 录制退出行为与三轮首帧测量

使用当前Performance产物的临时签名副本（仅bundle ID/name改为dev.coflux.desktop.launchprobe/CofluxLaunchProbe，代码未改），避免与19990用户输入法窗口混淆。xctrace App Launch --time-limit 8s录制三轮，COFLUX_MACOS_TEST=1、COFLUX_SERVER_URL=ws://127.0.0.1:1/client，停在登录页。三份轨迹均完整导出life-cycle-period，Initial Frame Rendering结束1498.14/751.79/759.36ms，中位759.36ms；以start+duration计，不把重叠阶段累加。原始精确值见results-launch-instrumented-2026-09-08.json。

三轮record均exit54、target SIGKILL，summary却为Time limit reached且日志明确保存成功。增加系统对照：同模板--time-limit 2s --launch /bin/sleep 30也exit54、target SIGKILL、Time limit reached，轨迹正常导出。因此不能仅凭54/SIGKILL判定应用启动崩溃；此前记录中的这一疑点有了本机对照解释。公开相似报告https://github.com/cmyr/cargo-instruments/issues/145只作背景，本机sleep对照为判断依据。

轨迹/tmp/coflux-launch-probe-{1,2,3}.trace、对应-toc.xml/-stages.xml；对照/tmp/coflux-launch-sleep-control.trace。这是受Instruments扰动的Performance副本登录页首帧，系统缓存未清，首次注册/启动成本可能不同；不是正式Release冷启动、登录后工作台或终端可交互时间，没有Web启动对照。录制后所有probe副本进程均定向退出，原19990环境保留。

## 真实工作台输入的 Web／原生对照（2026-09-08）

`results-input-paired-2026-09-08.json` 保存完整六轮原生与六轮 Web 原始数据。使用20006新隔离fixture，两个客户端均走本机relay；先完成Web再运行原生，不并发采样。工作台统一1280×684，实际网格原生145×37、Web143×37，探针及每条持续输出文本在两端均单行。原生输入用例的新尺寸只作用于测量入口，普通集成入口仍1360×800。

Web沿用前文生产构建及preview命令，preview额外设置 `COFLUX_BENCHMARK_SERVER_PORT=20006`；页面新增“空闲输入”“持续输出时输入”选择，每种独立运行三轮。挂载真实Workbench，通过公开xterm.input分别提交文本和回车，沿产品onData链路进入真实PTY；准备阶段先等待唯一shell应答，再启动与原生一致的Python raw-mode应答程序。每轮一次预热、30次有效采样、请求1ms视口轮询；持续输出每约5ms尝试写16行，各探针前等20ms并断言负载字节增加。准备、清理不计时；终点为视口文本可读，不含GPU呈现。首次准备失败没有进入采样，补齐shell应答后六轮通过并清理。

原生使用相同fixture的两个入口 `testRealInputRoundtripThroughPTY` 和 `testRealInputRoundtripDuringPTYOutput`，`-test-iterations 3 -test-repetition-relaunch-enabled NO`；六次均通过，exit0、TEST EXECUTE SUCCEEDED（`/tmp/coflux-input-native-paired-three.log`）。采样之后原有切换、上传、重连检查保留。构建日志 `/tmp/coflux-input-paired-build.log`；Web类型检查和生产构建通过。

| 场景 | 原生中位数 / P95 | Web中位数 / P95 |
| --- | --- | --- |
| 空闲输入 | 4.96 / 7.24ms | 5.25 / 6.30ms |
| 持续输出时输入 | 6.21 / 24.44ms | 5.20 / 6.00ms |

表中每一项是三轮对应统计量的中位数，不是合并样本的P95。原生持续输出三轮P95为9.70/45.88/24.44ms，波动明显；尚未定位原因，下一步应追查持续输出时的延迟尖峰。两端计时器和文本读取开销不同、未交错、网格相差两列，不能把空闲0.29ms差值视为确定收益，也不能声称原生整体更快。不是物理键盘、GPU呈现、跨公网或多终端饱和输入验收。

## 输入尾延迟分段诊断（2026-09-08）

原始分段数据及失败入口在 `results-input-diagnostics-2026-09-08.json`。临时插桩只作用于测试入口，记录输入提交、Ghostty回调、视口读取、请求1ms睡眠的实际恢复间隔、输出泵累计处理及采样时积压。不是性能基线；已从测试源码和scheme移除，保留 `input-diagnostics.patch` 作为该次实验的历史源码记录；后续传输追踪已改变测试入口，当前不能直接git apply，重用时需按上下文合并并重新生成工程。日常传输定位使用下节已接入的COFLUX_INPUT_TRACE入口。

第一组三次中两次完成采样，另一轮视口未读到ACK而失败，日志`/tmp/coflux-input-diagnostic-three.log`、exit65，并伴随XCTest清理InvalidTransition错误。最慢已完成探针72.77ms：输入提交0.20ms、视口累计读取4.76ms、输出泵累计0.18ms、采样时积压0；不支持将该慢探针直接归因为输出泵CPU耗时。

第二组加Ghostty回调计时与一次历史核对：超过100ms仍未在视口见ACK才检查历史，若找到则明确失败，不作为成功计时。三轮均完成采样，未触发历史漏读诊断，但一轮后续“关闭标签释放原生视图和Coordinator”检查超时，并伴随清理InvalidTransition，整组仍exit65（`/tmp/coflux-input-diagnostic-history.log`）。39.05ms探针的最后输入回调在0.38ms，输出泵累计0.14ms、视口累计读取1.97ms；提示应进一步追踪客户端发送、真实PTY和返回数据分段，而不是先改输出切片预算。主线程恢复、网络/PTY调度和视口漏读仍未完全区分；两次不同失败均未被标为产品根因已修复。

撤回插桩并重新构建后，相同20007环境正常持续输出输入集成三轮全部通过、exit0、TEST SUCCEEDED（`/tmp/coflux-input-diagnostic-restored.log`），包含后续切换、上传、重连及视图释放；没有据此把诊断中的两个失败标为根因修复。20007隔离环境已清理，19990人工输入法环境保留。

## 输入帧发送与确认回传诊断（2026-09-08）

`results-input-transport-trace-2026-09-08.json` 保存20008隔离fixture的两组三轮数据，均完整通过、exit0。第一组全走Ghostty输入（`/tmp/coflux-input-transport-trace.log`）；第二组在同一PTY内逐探针交替Ghostty输入与直接client.sendInput文本/回车，每种每轮15次有效样本（`/tmp/coflux-input-trace-alternating.log`）。所有探针均观测到真实ptyInput字节和ptyOutput内唯一ACK，观察器处理跨帧标记边界；没有改变产品协议、发送调度或路由。

测试专用 `InputTransportTrace.swift` 通过锁保护时间记录，不额外跳MainActor。发送开始/完成分别围绕SocketTransport.send；接收时间是SocketTransport.receive交回观察器时，**不是内核收包时间**。发送完成也不等于PTY已经收到。观察器解码protobuf并扫描受限尾部，会扰动运行，不能作为正常基线。当前 `COFLUX_INPUT_TRACE=1` 开启交替诊断；不设置时完全沿正常输入路径。诊断结果写入独立native-input-transport-diagnostic.json，含diagnosticOnly标记，不覆盖正常输入结果。原始完整采样输出仍在测试日志中。

全Ghostty组三个较慢探针示例：19.64ms的输入发送调用1.90ms完成、ACK在18.92ms交回；17.24ms的发送11.21ms完成、ACK在15.88ms交回。接收到终端视口可读通常只余约0.2–2ms，但不能由此排除接收调用前的主线程/URLSession调度。

交替组每轮Ghostty／直接客户端的输入往返中位数分别6.81/5.65ms、7.95/7.88ms、7.91/7.63ms；发送开始中位数1.52/1.49ms、1.58/1.39ms、2.17/2.23ms，两条入口都出现慢探针。未显示绕过Ghostty的稳定改善，不据此修改输入桥接。下一步应进一步区分客户端发送调度、URLSession接收与relay/PTY往返；当前仍未确认尾延迟根因。

最终诊断入口单轮（含输入字节与ACK观察断言）通过；关闭COFLUX_INPUT_TRACE后空闲/持续输出两项正常集成通过，11.442秒、0失败、exit0、TEST EXECUTE SUCCEEDED（`/tmp/coflux-input-trace-disabled.log`），日志无传输诊断输出。20008隔离环境已清理，19990人工验收环境保留。

## 输入帧数与写入确认对照（2026-09-08）

诊断入口新增 `COFLUX_INPUT_TRACE=frames`：同一PTY持续输出下轮换Ghostty输入、直接客户端文本/回车两帧、直接客户端文本加回车一帧；一次预热后每种15次，共45次有效探针，每组三轮。正常不开启追踪时仍30次有效Ghostty输入。观察器额外检查实际输入帧数及字节总数；三种方式输出一致。

两组三轮均通过、exit0，原始记录 `results-input-frames-2026-09-08.json`。第一组日志`/tmp/coflux-input-three-frames.log`：单帧方式仍出现49.82ms和81.85ms探针，后者发送调用4.67ms完成、程序ACK79.61ms交回，不能将尾延迟归因为两小帧拆分。三轮中位数也没有稳定提升，不改产品输入合并策略。

第二组沿用同一隔离20009环境，观察协议ptyInputAck累计游标（日志`/tmp/coflux-input-applied-ack.log`）。已核对supervisor的spawn_input_writer：write_pty_input成功、complete_input提交之后才发此ACK。观察器仅接受匹配session、覆盖本探针最后inputSeq且完整输入字节已发送的确认；138个探针均记录到该确认。145.48ms探针中发送2.64ms完成、程序ACK144.07ms、输入应用ACK144.44ms；166.39ms探针中发送5.42ms完成、应用ACK165.28ms、程序ACK165.99ms。

两个确认都晚交回客户端，排查应转向隔离relay收发及客户端接收，而不是只优化终端显示。这里的确认时间是客户端观察器收到的时间，不是daemon写入时刻，**尚不能区分服务端执行/排队与客户端接收等待**。不声称根因修复，不把诊断采样混入正常性能基线。

关闭追踪后，正常空闲与持续输出两项输入集成均通过、exit0、TEST EXECUTE SUCCEEDED（`/tmp/coflux-input-frames-disabled.log`）。20009隔离环境已清理，19990人工验收窗口环境保留。

## 隔离 relay 帧时刻关联（2026-09-08）

20010环境使用单独构建的 `/tmp/coflux-relay-frame-timing`，只增加opaque帧52位指纹、接收及转发完成wall clock记录，不解码DeviceEnvelope。补丁保存在 `relay-frame-timing.patch`；诊断副本构建后立即恢复 `crates/relay/src/main.rs` 并重新构建默认relay，正式源码无diff、恢复构建无警告（`/tmp/coflux-relay-restored-build.log`）。fixture通过COFLUX_RELAY_BIN选择副本，未改生产或19990环境。

原生三轮输入诊断通过、exit0（`/tmp/coflux-relay-timing-native.log`）。客户端观察器记录同一帧的指纹及起点wall clock；`scripts/correlate-relay-timing.py`按指纹、探针时间窗、唯一候选关联输入/应用ACK/程序ACK三帧。共享日志一行被其他进程stderr插入打断；工具记录其行号且不使用损坏行。138个探针全部唯一匹配、缺失0，该损坏行未影响这些探针。完整关联及原始帧时刻在 `results-relay-frame-timing-2026-09-08.json`。

最慢探针120.85ms（客户端单帧）：客户端发送调用3.02ms完成；relay收到至转发输入约0.020ms；转发输入到从daemon收到应用ACK约106.86ms；应用ACK从relay转发到客户端观察器约0.98ms。该次最大尖峰主要在共享daemon往返段，**不是relay内部转发或Ghostty显示耗时**。其他探针仍含客户端发送/接收调度成本，不能把这一次归因推广为全部输入延迟。

138个探针的daemon应用确认往返中位0.49ms、最大106.86ms；relay输入转发中位0.015ms、最大0.051ms；relay到客户端应用ACK中位0.93ms、最大5.65ms。上述为插桩诊断，不能混入无插桩性能对照。同机wall clock关联存在小量时钟采样误差；daemon往返还包含relay/worker socket及PTY执行排队，尚未定位daemon内部具体根因。暂不据此修改原生输入合帧、Ghostty桥接或输出预算。

复现关联：

    python3 apps/macos/scripts/correlate-relay-timing.py \
      --native-log /tmp/coflux-relay-timing-native.log \
      --relay-log /tmp/coflux-relay-timing-fixture.log \
      --output /tmp/coflux-relay-correlated.json

## 快照持锁与优化后端复核（2026-09-08）

20011诊断副本只在supervisor的device_snapshot记录开始、取得会话锁、结束时刻。补丁`supervisor-snapshot-timing.patch`保留，默认源码与Debug二进制已恢复重建。三轮原生诊断通过，138探针完整关联（`/tmp/coflux-snapshot-timing-native.log`）；原始记录在`results-snapshot-lock-timing-2026-09-08.json`。worker每2秒请求派生checkpoint，当前supervisor在会话锁内生成完整ANSI快照。145.00ms daemon往返区间与一次143.54ms快照持锁重叠143.15ms；83.23ms往返与一次96.59ms持锁重叠81.56ms。这里定位到了Debug环境下的主要长尖峰来源，尚未改变共享状态机。

随后构建无插桩Release supervisor/worker/relay（`/tmp/coflux-native-release-daemon-build.log`，optimized、无警告、exit0）。20012同一隔离环境两端依次各六轮输入测量全部通过，结果及二进制SHA256在`results-input-release-backend-2026-09-08.json`；原生日志`/tmp/coflux-release-input-native.log`。一次预热、30次有效样本、空闲/持续输出各三轮。

| 场景 | 原生中位数 / P95 | Web中位数 / P95 |
| --- | --- | --- |
| 空闲输入 | 4.37 / 5.36ms | 5.45 / 6.10ms |
| 持续输出时输入 | 5.03 / 10.77ms | 5.25 / 6.40ms |

每格为三轮对应统计量的中位数。原生持续输出三轮最大样本8.62/13.17/13.92ms，未再出现百毫秒级尖峰；有限样本不能证明所有尖峰消失。Web固定视口1280×720时DPR1、143×38，原生DPR2、145×37，不能按细小差值判断平台优劣，也不作为GPU呈现对照。初始Web三轮视口只有594px宽，已排除并保存原因；测量入口现校验1280×720，类型检查与生产构建通过。先前Debug后端结果保留为诊断，不直接代表交付版本性能；没有把构建条件变化称为产品代码提速。

后续性能环境统一使用以下入口，常规功能测试仍可使用dev-fixture：

    cargo build --release -p coflux-supervisor -p coflux-worker -p coflux-relay
    COFLUX_NATIVE_TEST_PORT=20012 COFLUX_NATIVE_FIXTURE_FILE=/tmp/coflux-perf-fixture.json \
      node --import tsx apps/macos/scripts/performance-fixture.mjs

入口在动态加载harness前固定三端可执行路径，缺少Release产物即失败，并在fixture JSON记录backendProfile。20013实际启动验证通过，进程路径确认三端均来自target/release。没有安装服务或替换真实daemon。20011–20013和浏览器预览均已清理，临时浏览器视口已恢复，19990人工输入法环境保留。
