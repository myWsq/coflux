# Ghostty 原生终端核心

本客户端使用 Ghostty 的完整 macOS 嵌入式表面（Metal/CoreText），不使用只有 VT 状态机的 libghostty-vt，也不通过 JavaScript 或本地 shell 转发远程 PTY。

固定上游与 Zig 版本见 `upstream.json`。在仓库根目录执行：

```sh
COFLUX_ZIG_BIN=/path/to/zig-0.16.0/zig sh apps/macos/Ghostty/build.sh
xcodegen generate --spec apps/macos/project.yml
```

构建结果位于 `.coflux-dev/ghostty/GhosttyKit.xcframework`，不提交机器架构相关的二进制。当前脚本构建宿主架构；正式通用二进制发布前还需构建并验收全部目标架构。构建使用固定提交和补丁内容寻址，不调用开发者证书或钥匙串。

`apply-remote-io.py` 添加 external I/O 后端与 `ghostty_surface_feed`：

- 外部字节直接交给 Ghostty 自己的解析、状态与渲染管线。
- I/O 线程的写回和 resize 回调由 Swift 立即拷贝数据、异步投递主线程；不得同步重入。
- Swift 主线程串行 feed、重建和释放表面；关闭先使回调上下文失效，再等待原生线程退出，防止旧回调影响新会话。
- 服务器替换快照时重建表面，清除半截解析序列、模式、选区与历史；输出泵保留顺序和背压。
- 仅 external 表面的链接命中沿用 Web：普通点击、鼠标报告时不抢事件、宽字符后半格查询所属字符。

`terminal.conf` 随 App 打包，不读取用户 Ghostty 配置。工作台负责网络、控制权、标签生命周期和文件上传。

`Tests/RemoteIOSmoke.swift` 验证 C 接口收发、尺寸与零本地 PTY；`Tests/SurfaceLifecycleSmoke.swift` 验证生产 AppKit 封装的快照替换、输入法提交和括号粘贴。应用测试继续覆盖交互、真实会话与输出性能。像素测试读取已呈现 IOSurface，不以解析文本替代渲染验收。

许可原文见 `THIRD-PARTY-LICENSES.txt`，版本和内容哈希见 `licenses.json`。`collect-licenses.py` 从固定源码、Zig 工具链及本次已解析依赖采集许可（包含仅构建期依赖），`scripts/sync-notices.py` 将其纳入 App 第三方说明。


尺寸与输出顺序：Ghostty 默认把 resize 合并到 I/O 线程定时器；外部输出在尺寸变化后的首块进入前，会通过 I/O fence 先落实该次 resize，避免按旧列数解析快照。fence 不持渲染互斥锁等待，I/O 回调不得同步等待主线程。普通连续输出不逐块等待 fence。

滚动状态通过持锁查询真实终端获取，不依赖窗口是否正在绘制；原生覆盖式滚动条和无窗口测试共用这份状态。滚动命令执行后再读取状态，保持视口和滑块一致。

实际窗口颜色验收（仅本机隔离环境，安装并登录 Claude CLI 后手动启用）：先运行 `python3 apps/macos/scripts/capture-terminal-validation.py`，再以 `COFLUX_NATIVE_TEST_URL=ws://127.0.0.1:<测试端口>/client` 和 `TEST_RUNNER_COFLUX_NATIVE_COLOR_VISUAL=1` 执行 `xcodebuild test -only-testing:CofluxTests/NativeIntegrationTests/testRealTerminalColorRendering`。测试使用独立任务，要求新 shell 没有 NO_COLOR，直接运行 Claude 并检查终端区域的彩色像素；捕获脚本需要已有屏幕录制权限，未启用该开关时此用例跳过。
