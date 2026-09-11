# 编排者验收清单

所有操作由编排者在沙箱外执行。记录 OS/Xcode、commit、构建时间、窗口 point 尺寸、DPR、zoomFactor、
daemon 版本、连接方式（relay/direct）、证据文件路径。测试命令只操作明确的试验终端，不使用日常会话。

## G1：实时 / 重新 attach

1. 构建并以 `COFLUX_GHOSTTY=1` 启动，打开试验终端，在该终端执行
   `node <repo>/apps/desktop/scripts/ghostty/fixture.mjs grapheme`。fixture 停留在输出画面，Ctrl-C 才退出。
2. 逐项检查家庭 👨‍👩‍👧、旗帜 🇯🇵、肤色 👋🏽、e+U+0301、行尾「界Z」，保存实时截图。
3. 在桌面 DevTools 执行 `scripts/ghostty/browser-probe.js` 的内容；
   执行 `copy((await cofluxSpike.dump()).text)`，把剪贴板原文保存为 live.txt，不做 NFC/NFD 归一化。
4. `cofluxSpike.resume()` 触发注销 consumer→重新 attach；不改窗口大小，等画面稳定，再导出 resumed.txt 和截图。
   这条路径清除 client outputSeq，确实向 daemon 要完整快照，不是重放本地内存。
5. 执行 `node apps/desktop/scripts/ghostty/compare-g1.mjs live.txt resumed.txt`，保留逐项表及 exit code。
   另外实际断网再联网执行同样对照，确认 relay 重连路径一致。
6. 任一 grapheme/换行失真：G1 不过，正式 plan 必须扩到 daemon 快照兼容；本分支不改 daemon。

## G2：稳定性

1. `node apps/desktop/scripts/ghostty/stress.mjs 50 > /tmp/ghostty-g2.log 2>&1`。
   每轮 12 块连续输出后，在第 13 块尚未确认时销毁，下一轮创建新 surface。
2. 保留 exit code、50 轮输出和峰值 RSS。按脚本 PID/时间检查 `~/Library/Logs/DiagnosticReports/` 是否生成 node/ghostty crash。
3. 真实桌面补做 50 轮创建/输出/切 Tab/关闭，包含切换活动工作区；保留 `~/Library/Logs/Coflux-dev/main.log` 或实际主进程日志和 crash 记录。
4. 排队回调不调用旧 listener 由压力脚本和 TS 队列测试覆盖。原生反复崩溃且一轮定位不能归因：G2 不过并停止，不添加 JS 重试。

## G3：中文 IME

- 用系统拼音输入「中文输入，测试？！」，检查候选框跟随光标、组合下划线、提交结果与远端字节记录。
- 输入拼音但不提交，用鼠标切到另一个 Tab，再回原 Tab；原 Tab 组合应取消，新 Tab 和远端均无残留提交。
- 同样测试 ⌘1/⌘2 切换、切到 changes、打开模态框、失去控制权；恢复焦点后正常输入。
- 将每条记录为 操作 / 预期 / 实际 / 截图 / 远端字节文件，不凭肉眼“看着差不多”判断。

## G4：快捷键与复制粘贴

先运行 `node apps/desktop/scripts/ghostty/g4.mjs`，覆盖真实 addon 的 keyEquivalent/keyDown 双路径去重和 keyUp 不泄漏；下列实际菜单/IME 操作仍需人工。

- 在远端用 raw stdin 记录器记录输入（可把 fixture 的 stdin data 写到试验临时文件，不修改协议实现）。
- 原生终端 first responder 时分别按 ⌘T、⌘W、⌘N、⌘1–9、⌘[、⌘]、⌘/：工作台各动作一次，远端没有对应键字节。
- 同一组键在网页输入框/侧栏中验证原有行为；长按重复属于系统 key repeat，单次 keyDown 不得触发两次。
- 用鼠标菜单「编辑→复制/粘贴」及 ⌘C/V，验证选区复制与 bracketed paste。
- Finder 复制文件、系统截图后粘贴、拖入文件：显示不支持提示，远端没有本机路径或上传结果。
- 在组合中使用快捷键重复 G3 的无残留要求。记录输入字节文件和每项实际动作计数。

## G5：几何

每项前后保存屏幕截图，关注四条边、候选框位置、鼠标选区命中；记录 CSS rect、zoom、DPR、AppKit point、Metal pixel。

- 进入/退出全屏各 5 次。
- 1× 与 2× 显示器之间往返拖动，同 DPI 不同显示器也各测。
- 拖动侧栏宽度；出现/关闭 detached 与 exited 横幅，终端不得盖住横幅。
- 切 changes、打开每种 modal/popover，叠层消失且 DOM 可点击；关闭后恢复。
- 隐藏/恢复窗口、最小化/恢复、睡眠/唤醒；隐藏期间持续输出，再显示仍正确。
- 页面缩放 80% / 100% / 125%，按 README 的 CSS→point→pixel 规则对照，不把 DPR 再乘一次。

## G6：恢复和 resize

运行 `node apps/desktop/scripts/ghostty/g6.mjs`，保存 JSON/exit code；并运行主进程 ghostty-queue.test.ts。
脚本覆盖逐字节 UTF-8、拆分 CSI、replacement 清旧 parser/alt screen、resize 首块宽字符换行和 replay 无 DA/DSR。
真实 relay 终端执行 `fixture.mjs boundaries`：resize 后立即回显、断网重连、切 Tab 后复原。不能用仅 native 的结果替代真实 relay 记录。

## G7：交付

1. 按 README 的 pack:ghostty 命令生成 ad-hoc 包，运行 sign-evidence.mjs，把 stdout/stderr 保存成证据。
2. 检查主程序、.node、dylib 的签名 flags 和依赖路径，entitlements 无 disable-library-validation。
3. 把 app 移到不含仓库/.build 的路径，清除开发环境变量，以 COFLUX_GHOSTTY=1 启动并打开终端，证明资源没有回退编译机绝对路径。
4. 有 CI Developer ID 证书时去掉 COFLUX_GHOSTTY_ADHOC，生成 hardened runtime 签名并公证的包；重复签名证据。
5. 无 Node/Swift/Xcode/仓库的干净 arm64 macOS 26+ 机器上启动、开终端、输入、退出/重启。保留系统版本和启动截图。
6. ad-hoc 通过不能把 G7 标为通过。Developer ID: unverified, needs CI cert。

## G8：性能

1. xterm 用 `COFLUX_TERMINAL_METRICS=1`，Ghostty 加 `COFLUX_GHOSTTY=1`，其它环境相同；各重启实例清空累计峰值。
2. 同一 daemon/relay、相同窗口/字体与网格，运行 `fixture.mjs performance`（约 64KiB/s）。预热 10 秒。
3. 执行 browser-probe.js，运行 `copy(JSON.stringify(await cofluxSpike.measure({seconds:60,label:"visible"})))`，分别保存 xterm.json/ghostty.json。
4. 运行 `node apps/desktop/scripts/ghostty/compare-perf.mjs xterm.json ghostty.json`，保留两列表。
   sendInput→PONG 解析完成是可复现的延迟代理，不是键盘→屏幕呈现；main loop 与 renderer rAF 分列。
5. 每种引擎开 10 个运行相同输出器的 Tab，切 changes 隐藏全部终端。
   再采 `{seconds:60,label:"hidden-10",probes:false}`，得到多隐藏 Tab CPU 对照。另测隐藏整个窗口，主线程取样会受 renderer timer 节流影响，需 Instruments。
6. Instruments Time Profiler / Metal System Trace 补测实际输入到呈现、GPU frame 和 Metal 内存。
   原生报告 MTLDevice.currentAllocatedSize，是设备总额；xterm Chromium GPU 内存不能用这个值类推，留空待 Instruments。
7. 至少采 3 轮并记录负载、样本数、P95 和峰值；缺 PONG 或进程样本的脚本退出非零，不能拿缺失样本作低延迟证据。
