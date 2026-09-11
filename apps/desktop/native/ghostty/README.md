# Ghostty 原生层（plan 114，M1 未完成）

本目录只交付 M1 的原生宿主草稿、Node-API 绑定、构建入口和隐藏窗口冒烟。
尚未接入 Electron 或 relay，不能用于产品；没有修改默认 xterm 路径。
M2/M3/M4 尚未开始，特别是 replace 重建、resize fence、输入门禁、快捷键和打包签名接入尚未完成。

## 构建与 M1 冒烟

从仓库根目录运行：

```sh
node apps/desktop/native/ghostty/build.mjs
apps/desktop/native/ghostty/build/ghostty-smoke
```

构建入口只构建 Swift 动态库、ObjC++ Node-API addon 和冒烟可执行文件，不运行冒烟。
没有 Node-API 头文件时先运行 `npx --yes node-gyp@11 install --target=26.3.0`，
或令 `COFLUX_NODE_HEADERS` 指向含 `node_api.h` 的目录。
`COFLUX_GHOSTTY_SDK` 可以覆盖 SDK 路径。默认显式使用 Xcode 26.5 SDK，
避免本机 CommandLineTools 的 27.0 SDK 与所选链接器不匹配（`unknown architecture arm64e.x1`）。
产物分别位于 `.build/arm64-apple-macosx/release/libCofluxGhostty.dylib` 和 `build/`。
运行时还依赖 SwiftPM 生成的资源 bundle；当前路径仅供开发，未完成可移动打包。

锁定信息在 `upstream-lock.json` 和 `Package.resolved`。checksum 来自锁定 revision 的
`Package.swift`，上游 commit 来自同 revision 的 `Ghostty.ref`；SwiftPM 下载成功并接受该 checksum。

## 宿主边界

- `include/coflux_ghostty.h` 是窄 C ABI，入口要求 AppKit 主线程。
- addon 使用 Node-API 8，没有 Electron/V8 绑定；不需要升级 Electron 或 electron-builder。
- 稳定整数 id 对应宿主表；销毁先删除 addon 回调，再使 Swift 对象失效。
- write/replay 每次最多 1 MiB、只允许一块正在解析；返回 true 代表接收，事件 6 代表解析返回。
- 后台解析期间保留 surface；销毁后回调不进入 JS，后台任务结束才释放原生对象。
- 事件编号：1 ready、2 输入字节、3 cols/rows、4 OPEN_URL、5 错误、6 解析完成。
- NSView 通过 `.above` 叠到窗口句柄所指视图上；CSS→point 的 zoom 换算尚待 M2/M3 实现。

上游 Swift 封装的 raw surface 与显式释放方法不是公开 API。为实现 C 层 replay 和解析完成确认，
本 spike 使用 `-enable-testing` + `@testable import GhosttyTerminal` 访问锁定版本的内部接口。
这没有改上游源文件或二进制，但增加版本耦合；正式方案应改为维护者提供的公开 API 或受控补丁。
`--disable-sandbox` 仅关闭 SwiftPM 的嵌套构建沙箱，外层执行器的文件系统权限仍然有效。

## 本次 M1 阻塞证据（2026-09-11）

Swift 宿主 release/arm64 构建退出 0；Node-API addon 与原生冒烟程序构建均退出 0。
冒烟两次都在第一个 surface 创建时退出 1，没有完成任何一轮，也没有原生崩溃。
第二次仅加入生命周期与 Metal 诊断，输出为：

```text
IOSurfaceSharedEventAddEventListener failed: 10000003
surface rebuild scale=1.00 backend=in-memory fontSize=nil workingDirectory=nil context=window
surface rebuild failed
smoke diagnostics: app=true, metal=false, configurationIssue=none
原生错误：Ghostty surface 创建失败
```

`metal=false` 来自 `MTLCreateSystemDefaultDevice() != nil`，说明当前执行进程拿不到 Metal 设备。
这不是“缺 Zig/Metal 编译器”的证据：预编译 XCFramework 和 Swift 动态库已经构建成功。
不能据此判定 G2 原生崩溃不过，也不能声明 M1 通过。需要可访问 Metal/WindowServer 的运行环境
执行同一冒烟，并将输出交回；本会话未尝试绕过宿主权限限制。

八道门均未验证：G1/G6/G8 装置与 M2 队列测试尚未实现，G2 50 轮未执行到，
G3/G4/G5 无交互记录，G7 没有打包产物或干净机器记录。
Developer ID: unverified, needs CI cert。
