# Ghostty 叠层 spike（plan 114）

只面向 arm64 / macOS 26+。默认关闭：`COFLUX_GHOSTTY=1` 才会延迟加载 Node-API addon；
默认 xterm 路径不加载原生库。此分支不是产品发布，所有新增验收由编排者在会话外执行。

## 构建与命令

从仓库根目录执行，以下命令本轮未运行：

```sh
node apps/desktop/native/ghostty/build.mjs
apps/desktop/native/ghostty/build/ghostty-smoke
node apps/desktop/scripts/ghostty/g6.mjs
node apps/desktop/scripts/ghostty/stress.mjs 50
node --import tsx --test apps/desktop/src/main/ghostty-queue.test.ts
```

原生 build 只构建 Swift 动态库、ObjC++ Node-API addon 和冒烟可执行文件，不运行它们。
没有 Node-API 头文件时先执行 `npx --yes node-gyp@11 install --target=26.3.0`，
或设置 `COFLUX_NODE_HEADERS`。N-API 8 不依赖 Electron 的 V8 ABI，不升级 Electron/electron-builder。
`COFLUX_GHOSTTY_SDK` 可以覆盖默认 Xcode 26.5 SDK 路径，避免误用本机 CLT 的 27.0 SDK。

锁定信息在 `upstream-lock.json` 和 `Package.resolved`。二进制 checksum 来自锁定 revision 的
`Package.swift`，Ghostty commit 来自 `Ghostty.ref`。构建产物和缓存均被 `.gitignore` 排除。

## ABI 和资源适配

- C ABI 在 `include/coflux_ghostty.h`。所有 AppKit 操作和回调都在主线程；解析在后台，完成后事件 6 才释放额度。
- addon 不包含会话/网络业务，以稳定整数 id 持有对象；JS 销毁先移除回调，Swift 等正在解析的块结束再释放 surface。
- 事件：1 ready、2 输入（x=控制权 epoch）、3 cols/rows、4 OPEN_URL、5 错误、6 parsed、7 工作台命令、8 resize 栅栏、9 reset 完成、10 禁用操作提示。
- reset 重建 parser/session，清除 UTF-8/CSI 半截、模式、alt screen 和滚屏；随后 replay 调用专门的 C API 抑制 DA/DSR。
- resize 等 IO backend 的尺寸回调与当前网格吻合，再确认 frame、放行后续输出；隐藏窗口仍在解析期间 tick app mailbox。
- `dump()` 返回逐行 viewport 文本，不等于像素截图；`pump()` 仅给非 Electron 的脚本驱动 AppKit loop。

已接受的内部 API 耦合：`-enable-testing` + `@testable import GhosttyTerminal` 用于显式释放、replay 和 raw surface。
正式方案应要求上游公开接口或维护受控补丁。

新增资源适配：`patch-resources.mjs` 只修改锁定 checkout 的 `GhosttyRuntimeResources.swift`，
优先寻找 `Bundle.main.resourceURL/ghostty/GhosttyKit_GhosttyTerminal.bundle`；开发态仍回落 SwiftPM bundle。
补丁不改预编译 XCFramework。若源码入口不再符合预期，构建直接报错；包升级须重新审查此补丁。
`--disable-sandbox` 仅关闭 SwiftPM 嵌套构建沙箱，外层执行器权限仍生效。

## IPC、恢复与门禁

共享类型位于 `src/shared/ghostty.ts`。主进程、preload 和 renderer 不传递窗口指针。
create/destroy 用 invoke，输出/rect/state/dump/recover 用同一 send 通道；来源要求可信顶层 frame。

每个 surfaceId + generation 一条串行队列。渲染层每 4ms 或 256KiB 合批、按 64KiB 切块；
两端都对排队加正在解析的字节记账，上限 8MiB，每代至多 512 个未确认操作。
主进程最多 64 个存活 surface。原生解析返回才 ack，不把进入 IPC 当作成功解析。
超额/缺号/原生拒收只发一次完整恢复信号，不继续消费该代 delta。

恢复先注销 consumer：现有 store 在最后一个 consumer 注销时 suspendSession，清掉 outputSeq/hasLiveSnapshot。
重建 generation、ready、重注册 consumer 后，调用不带 force 的 startTask 获取完整快照。
后台/已被接管的 Tab 不主动抢占控制权。5 秒内再次恢复失败则停在显式错误状态，不无限重试。
单次快照大于额度时可能触发这一停止路径，需在正式方案确定快照最大尺寸或流式交付协议。

输入、鼠标报告、粘贴和自动协议应答需 active && owned；原生 gate 和渲染层各检查一次 epoch。
切 Tab/遮挡时立即撤销原生输入许可并取消 IME composition，旧回调不进入新 epoch。
关闭 Ghostty 默认 keybind，防止默认 paste_from_clipboard 绕开文件禁令；仅宿主处理文本粘贴。
OPEN_URL 始终被 delegate 接管，通过 renderer 的 window.open 走现有 http(s) 校验。

## 几何、遮挡和快捷键

- DOM rect 是 CSS px；主进程乘 webContents zoomFactor 得到 AppKit point。
- AppKit 原点翻转使用父视图 isFlipped/bounds；Metal pixel 由 NSWindow backingScaleFactor 决定。
- renderer dpr 用于触发同步及记录，不直接当 AppKit point 的倍数。
- ResizeObserver、scroll、visualViewport、DPR 和 DOM 布局变化同步 rect；零尺寸不送远端。
- 顶部横幅占布局，原生区域从独立布局标记的下沿开始；changes/非活动 Tab/打开的 dialog、popover 隐藏叠层。
- NSView 按物理 keyCode 消费 ⌘T/W/N/1–9/[ ]/，只回调一次工作台命令，不转发键字节；网页仍走原来的 keydown。
- 复制/粘贴菜单优先调用拥有 first responder 的原生视图，其余回落 webContents；原生仅粘贴文本，拒绝文件 URL/图片，拖入文件也给出提示。

## 单独打包和签名

先构建 native，再由编排者运行：

```sh
COFLUX_GHOSTTY_ADHOC=1 COFLUX_DESKTOP_DAEMON_DIR=<dir> pnpm -C apps/desktop run pack:ghostty
node apps/desktop/scripts/ghostty/sign-evidence.mjs apps/desktop/dist/mac-arm64/Coflux.app
COFLUX_GHOSTTY=1 apps/desktop/dist/mac-arm64/Coflux.app/Contents/MacOS/Coflux
```

`pack:ghostty` 用独立配置扩展现有 yml；默认 pack/dist/release 不包含 addon。
.node/dylib 都显式 asarUnpack，并列入 mac.binaries；dylib 使用 @loader_path，资源 bundle 在实际 Resources 路径。
不增加 disable-library-validation，不改 entitlements。ad-hoc 不能代替 Developer ID 与干净机器验收。
Developer ID: unverified, needs CI cert。

## 证据状态

编排者反馈 `ca87e59` 的原始 M1 冒烟在沙箱外 exit 0，`round=50 created/written/destroyed`，
250 条 tear down 生命周期日志、无崩溃。此前执行器的 `metal=false` 来自 seatbelt，不能判定 native 不可行。
本轮扩大了 ABI/栅栏/门禁/资源加载，新增代码未构建或验证，必须重新跑原生构建和验收装置。
八道门清单见 `checklist.md`；最终状态记录在 plan 114 的「Spike 结论」。
