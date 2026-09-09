> 当前终端已切换为 Ghostty 原生嵌入核心；首次构建前请执行 [Ghostty 构建步骤](Ghostty/README.md)。以下按时间累积的 SwiftTerm 记录保留为历史基线，Ghostty 核心接入已通过完整原生回归，整体 Web 对齐仍按下方清单推进。

# Coflux macOS

2026-09-05 从当前 Web 重新实现的原生客户端，使用 SwiftUI、AppKit、原生终端控件。
**开发中，尚未达到 Web 的完整功能和 UI 对齐验收。** 总体清单见
[093](../../plans/099-macos-web-parity.md)。不消费历史原生化尝试的工程或测试。

## 当前状态（2026-09-08）

完整要求的当前状态与剩余缺口见 [ACCEPTANCE.md](ACCEPTANCE.md)。

下方按日期保留的记录包含早期 SwiftTerm、少量高亮语言及旧测试数量，不能作为当前能力清单。
当前终端使用 Ghostty 嵌入核心；高亮覆盖与来源见 [HIGHLIGHT-COVERAGE.md](HIGHLIGHT-COVERAGE.md)，
实际界面差异、修复与验证边界见 [VISUAL-PARITY.md](VISUAL-PARITY.md)，
同条件组件性能和真实输入测量见 [Benchmarks/README.md](Benchmarks/README.md)。

当前构建、完整回归及产物审计的结果以 [ACCEPTANCE.md](ACCEPTANCE.md) 为准。
下方按日期累积的测试数量和截图记录保留历史证据，不代表当前版本已完成全部验收。
系统中文候选选词、跨窗口文件拖放、跨 NAT、完整逐屏比较及正式签名分发仍有未完成项。

## 本地构建

需要 Xcode 26.6、XcodeGen、Zig 0.16.0、已安装的 pnpm 依赖。当前最低 macOS 14。

```sh
sh apps/macos/Ghostty/build.sh
xcodegen generate --spec apps/macos/project.yml
xcodebuild build -project apps/macos/Coflux.xcodeproj -scheme Coflux \
  -configuration Debug -destination 'platform=macOS' \
  -derivedDataPath /tmp/coflux-macos-093-build CODE_SIGN_IDENTITY=-
```

使用 Xcode 打开 `Coflux.xcodeproj`，Scheme 中设置 `COFLUX_SERVER_URL` 可连接自定义服务器。
Debug 默认服务器 `ws://127.0.0.1:19873/client`；Release 默认为 `wss://api.coflux.dev/client`。
可用 `COFLUX_SERVER_URL` 显式覆盖；调试使用以下隔离测试栈。
Debug/Performance 固定使用内存登录凭据，不访问 Keychain，也不接受开启钥匙串的环境开关；Release 的 token 在 Keychain 中按完整服务器地址隔离。
开发版支持使用临时内存身份的本机直连，以及原生 P2P/relay；不复用浏览器/iOS 的登录会话。
Debug/Performance 上报 dev；Release 必须显式设置 COFLUX_BUILD_ID，由构建阶段校验并写入 Info.plist。
正式服务器准入登记与签名分发仍待验收，当前测试产物不用于正式发布。

## Release 版本标识

每个准备发布的原生构建应有独立、稳定的 COFLUX_BUILD_ID，例如 macos-0.1.0-提交标识。
它是协议兼容版本标识，与展示版本 MARKETING_VERSION、打包序号 CURRENT_PROJECT_VERSION 分开。
只能使用 1–128 个 ASCII 字母、数字、点、下划线或连字符；Release 拒绝 dev、unreleased、空值和未展开变量。

本机只验证构建时可用临时签名，以下命令不调用开发者证书，也不要用该产物代替正式分发包：

```sh
xcodebuild build -project apps/macos/Coflux.xcodeproj -scheme Coflux \
  -configuration Release -destination 'platform=macOS' \
  -derivedDataPath /tmp/coflux-macos-093-build -skipPackageUpdates \
  COFLUX_BUILD_ID=macos-0.1.0-validation CODE_SIGN_IDENTITY=- ONLY_ACTIVE_ARCH=YES
```

应用认证读取 Info.plist 的 CofluxBuildID 并通过 clientVersion 发送。服务器沿用现有允许版本集合：
COFLUX_BUILD_ID 或 COFLUX_BUILD_ID_FILE 所列文件的内容。原生构建须单独登记已验证兼容的版本，
不能借用 Web 的版本号或使用 dev 绕过正式检查。部署时可以从待发布 App 的 Info.plist 导出
native-build-id.txt 并将其加入既有文件列表；这一步涉及生产部署，本轮不执行。
正式签名、公证、目标架构与安装运行仍须独立完成；Release 运行时会使用持久凭据，因此当前只构建，不启动它。

## 真实设备联调与 Web 对照

先构建 Rust 进程，确认 compose 的本地 Postgres 可用。以下脚本创建临时 DB、HOME、仓库与设备，
不安装系统服务、不使用生产设备。

```sh
cargo build -p coflux-supervisor -p coflux-worker -p coflux-relay
node --import tsx apps/macos/scripts/dev-fixture.mjs
```

默认控制面端口 19873，测试账号 `admin/admin`。脚本 Ctrl-C 后清理所有临时资源。
另一个终端运行 Web：

```sh
COFLUX_BACKEND=http://127.0.0.1:19873 pnpm -C apps/web dev --port 15273 --strictPort
```

原生进程以 `COFLUX_SERVER_URL=ws://127.0.0.1:19873/client` 运行，或执行真实集成测试：

```sh
env -u COFLUX_KEYCHAIN_DEV -u COFLUX_KEYCHAIN_TESTS \
  COFLUX_NATIVE_TEST_URL=ws://127.0.0.1:19873/client \
  COFLUX_NATIVE_FIXTURE_FILE=/tmp/coflux-native-093-fixture.json \
  xcodebuild test -project apps/macos/Coflux.xcodeproj -scheme Coflux \
  -configuration Performance -destination 'platform=macOS' \
  -derivedDataPath /tmp/coflux-macos-093-build -skipPackageUpdates \
  ENABLE_TESTABILITY=YES CODE_SIGN_IDENTITY=- ONLY_ACTIVE_ARCH=YES
swift test --package-path packages/swift-client
```

没有传入测试 URL 时，集成用例明确 skip，不能据此宣称真实连接已验证。
Agent hook 全流程还需传入同一 dev-fixture 生成的 JSON 文件，以获取隔离网关端口；不使用本机默认网关。
测试宿主使用空 token store，不读取正式 Keychain。
登录/工作台内容截图生成在 `.coflux-dev/macos/`（1360×800 逻辑点，Retina 输出）。
截图针对内容区域；不代替实际窗口、焦点、输入法、辅助功能和性能验收。

## 当前已验证与缺口

2026-09-05：macOS 33 项全套测试通过，包括真实控制面与 Rust 设备上的登录失败/成功、
目录浏览、Git 执行、项目导入、worktree 新建/分支切换/重命名/删除、
终端收发、两个原生终端对象保活、重新连接后继续输出。
新增真实多文件上传与远端字节核对、后台终端路径暂存、OSC 标题、断线上传拒绝；
另覆盖 bracketed paste 开关、目录忽略/超限拒绝和 TIFF 转码。
快捷键按 Web standalone 的物理键位匹配，并补齐 ⌘N 新建工作区；真实 AppKit 事件测试
用物理 T 键携带不同字符创建第二个终端，验证不是只按字符触发。
双客户端真实验证接管/点击标签拿回控制权/恢复输入，以及点击已退出标签创建新会话。
变更页首次打开后按工作区保活，隐藏期间不发起刷新，返回时重新拉取并保留折叠状态；
该界面的逐屏视觉与滚动/折叠保留仍待 UI 验收。
Diff 解析使用临时 Git 仓库验证中文/换行/tab/引号路径、删除、纯重命名、二进制文件及类似文件头的正文；
同时覆盖默认八进制转义和 core.quotepath=false。
共享 Swift 测试与 iOS Simulator 构建回归通过。构建为本机 ad-hoc 签名，不是正式分发签名。

当前缺口至少包括：

- 导入向导的分段路径/键盘导航、分支弹出菜单、确认弹窗仍需逐屏对齐。
- 乐观创建、状态详情、Agent 图标、orphan session、窗口焦点和快捷键完整语义。
- IME/普通文本粘贴/系统拖放/大图片压缩、控制权接管和高负载恢复完整验收。
- 更多语言的原生高亮、长 diff 的虚拟化与性能对照；重命名/特殊路径已有真实 Git 回归，完整视觉仍待验收。
- 连接能力完整对齐 Web：已接入 direct/relay，原生 P2P、撤权和并发边界验收待补。
- 原生版本准入、正式签名分发、完整 UI 比对、启动/CPU/内存/帧延迟实测。

## 图标

`node apps/macos/scripts/sync-icons.mjs` 从当前 Web 锁定的 lucide-react 导出 SVG Asset Catalog。
App 中按 template vector 渲染；许可见 `LUCIDE-LICENSE`。不把 JS runtime 打包进 App。

## 原生实现审查与高亮

见 [NATIVE-AUDIT.md](NATIVE-AUDIT.md)。已清理重建验证 App 无 JS/HTML/WASM 资源、
无 JavaScriptCore/WebKit 直接链接。高亮使用 Tree-sitter C + SwiftTreeSitter，
当前接入 JS/TS/JSX/TSX，中文/emoji/跨行注释与原生截图已验证；其他语言暂显示纯文本，仍需补齐。
语言名中的 JavaScript 指被解析的源码语法，不是 App 内的 JavaScript 引擎。
查询和许可可用 `python3 apps/macos/scripts/sync-native-queries.py` 从锁定版本更新。

分支选择已补齐原生输入框方向键/回车/Esc、跳过占用分支、当前分支点击关闭、
查询去空白与新建项置顶、加载失败重试。选择规则及原生 field editor 回车创建真实 worktree 均已通过；组合输入法仍需 UI 验收。

导入向导已接入远端分段路径、编辑草稿与已确认路径隔离、方向键/Tab/退格/Esc/⌘回车入口。
路径规则测试通过，完整导入键盘流程及长列表滚动仍待 UI 验收。

实际 App 操作已验证：回车选设备、确认目录路径、⌘回车导入后项目出现在侧栏、
已导入目录禁用提交、越界路径报错、Esc 分步回退，以及编辑路径/确认后过滤框的焦点交接。
验收仅使用隔离服务器和 `.coflux-dev/coflux-native-ui-import-6rmyta7h` 测试仓库。


## 终端分批输出与背压（2026-09-05）

- SwiftTerm 每次最多处理 4 KiB，约 4 ms 后让出主线程；快照替换取消旧队列，关闭终端释放积压。
- 所有终端合计积压达到 4 MiB 时，原生设备 WebSocket 暂停下一次读取，消费后恢复；
  中心 `/client` 控制面和发送不受该门控影响。移除了超限后同步排空的兜底。
- 4 MiB 是接收门槛，不是进程内存硬上限：每条设备连接可能已有一帧在途，
  Foundation 自身缓冲及终端 scrollback 也不计入该数字。设备 RPC 接收可能随终端积压短暂等待。
- 同次 Debug 测量：345,016 bytes / 5000 行，单次 feed 约 138 ms；
  分成 29 批后最长一批约 5.7 ms，总耗时约 155 ms。
  持续 8,480,000 bytes 测试最长一批约 6.9 ms、积压峰值 4,720,848 bytes，总耗时约 6.04 s。
  这是减少连续主线程占用的证据，不是实时帧率保证，也不证明比 Web 快。
- 21 项全套通过，新增跨帧 UTF-8/emoji/ANSI 与同步终端结果比较、非零 Data 索引、
  超限等待/取消/快照恢复、持续输出排空检查。
- 真实集成曾出现「退出后点击重启」超时，后续重复测试再次复现；处理与证据见下节。
- 本次测试产物复查未发现 JS/HTML/WASM 资源或 JavaScriptCore/WebKit 直接链接。


## 退出后重启的时序修正（2026-09-05）

- 修正一条可导致重启超时的竞态：设备退出通知先到达，UI 已显示 EXITED，
  中心仍保留旧 RUNNING 事实，此时直接 taskStart 会被中心拒绝。
- 共享 Swift 核心保留中心的原始运行会话；macOS 的重启等待中心确认退出后再发起，
  最多等待 10 秒。取消、关闭终端、连接断开或任务删除后不再发送；
  如果另一客户端已启动新会话，则按最新事实连接它。
- 绑定会话仅在 RUNNING 且前台/本机正在启动时自动 attach，避免后台抢控制权；
  回到前台会补 attach，同一轮绑定不重复发送。重启前取消尚未渲染的旧输出。
- 可控测试覆盖设备先退出、中心迟到/旧 RUNNING 回放、最终确认后只发一次启动、
  取消后确认也不发送。共享 Swift 44 项 Swift Testing（其中该项含两种参数）与 3 项 XCTest 通过。
- macOS 全套 21 项通过；最终连接条件调整后，真实登录/终端切换/上传/重连/
  双客户端控制权交接/退出重启用例连续 10 次通过。iOS Simulator 构建回归通过。
- 原始偶发日志中的服务器错误已被启动超时提示覆盖，未把所有可能的超时都归结于同一原因；
  已保留失败时任务、错误和激活计数的诊断输出，便于后续定位。


## 工作区状态详情与本地会话提示（2026-09-05）

- 对齐当前 Web 的 approval > question > active > done 聚合；旧 waiting 映射为本轮完成。
  设备离线隐藏活动状态，进度取 RUNNING 会话的第一条非空短评，独立于活动优先级。
- 侧栏工作区详情包含 Agent 名称、状态、完整留言/进度、路径、设备在线状态和正确的 diff 基准。
  使用 macOS 原生 help 悬停提示与辅助功能值；长消息保留换行。采用原生提示的排版差异。
- 共享核心接入设备 catalog 的存活记录与退出墓碑；设备行按 taskID + sessionID 对照中心任务，
  显示未登记存活会话的「本地 N」和会话 ID 详情。与 Web 一致只提示，不新增终止/删除操作。
- 回归覆盖状态优先级、离线/进度独立、waiting、留言、diff 基准、跨设备隔离、
  空 catalog 不推断退出、墓碑保留元数据及旧 session 退出不误改新 session。
- macOS 23 项、共享 Swift 45 项 Swift Testing + 3 项 XCTest 通过，iOS Simulator 构建回归通过。
- 实际重启 App 并登录隔离服务后，CUA 确认工作区原生 Help 已包含路径和设备信息。
  有 Agent 留言/进度与非零 orphan 的实际悬停视觉仍待验证；Agent glyph 和完成已读状态尚未补齐。


## Agent 图标与完成已读（2026-09-05）

- 终端标签接入 Agent presence：Claude 使用当前 Web 的 Clawd 插画，其他 Agent 使用 Lucide Bot，
  控制权被接管时优先显示 Unplug。approval/question 警示色、done 完成色与 Web 对齐。
- `python3 apps/macos/scripts/sync-clawd.py` 将 Web 的 gym/flag/confetti SVG 展开为 62 帧静态矢量资源。
  原始插画来源沿用 Web `clawd-glyph.tsx` 的 ayotomcs.me/claude-mascot 说明；品牌橙保持 #D97757。
  资源经过 Asset Catalog 编译，Swift Task 按 Web 的帧顺序/延时播放，无 SVG 动画解释器、JS 或 WebView。
- 只有当前工作区正在显示的终端完成状态才记为已读；切到变更页不算已读，
  下一轮 active/approval/question 清除已读，消失的 session 清理记录。已读 Claude 显示静止站姿。
- 系统减少动态效果、非活动场景显示静帧；姿态切换或视图移除取消旧播放任务。
- macOS 26 项全套通过；随后补充实际原生窗口像素比较，4 项 AgentGlyphTests 通过，
  证明活动场景图像发生帧变化、非活动场景保持静止。62 个资源均可加载，渲染图已人工检查。
  测试图 `/tmp/coflux-native-agent-glyphs.png`。系统减少动态效果的真实设置切换仍待实操验证。
- 尚未用真实 Agent hook 连贯操作验证标签已读/重置流程，不能以局部渲染测试替代完整 UI 验收。


## 工作区创建中的即时反馈（2026-09-05）

- 创建提交成功后侧栏立即显示旋转占位、展开项目并选中占位，主区提示正在准备 git worktree。
  本地占位不进入共享 store、终端绑定或网络工作区参数，也不持久化假 ID。
- 按项目、设备、目标分支和提交前的工作区 ID 集合识别成功广播；
  避免把同项目另一分支的新工作区认作本次结果。同项目同分支重复提交复用占位。
- 占位仍被选中时自动切到真实工作区；用户已切走时保留其选择。
  这是对当前 Web 成功后无条件切回行为的原生体验改进。
- 错误、项目删除、登出和 15 秒超时清理占位/计时器；无有效选择时沿用工作台选择恢复规则。
  协议没有请求关联 ID，错误事件仍按当前 Web 的方式清理未完成创建，不能精确归属并发错误。
- macOS 28 项全套通过；之后扩展真实设备生命周期用例并通过：
  回车提交即时占位、成功转正、非法分支失败清理、偏好不落假 ID、重复提交、后台成功不抢选择。
  测试创建的额外 worktree 已在同一隔离用例中删除。真实 15 秒无响应和占位逐屏视觉仍待验收。


## 原生 loopback 握手（2026-09-05）

- `LocalGatewayConnector` 使用 CryptoKit P-256 ECDSA-SHA256，SEC1 非压缩公钥和 64-byte P1363 签名。
  domain + NUL + 每字段 u32 BE 长度前缀，连接代际使用完整 u64 BE，与当前 Web/device.proto 相同。
- 固定拨号 127.0.0.1 的中心描述符端口，校验协议、设备、Origin、固定网关公钥、随机数和签名；
  认证前外层 channelID 必须为空，认证后返回实际 channelID/scopes。握手读取有 3 秒超时，取消会主动关闭连接。
- 3 项定向测试通过：错误 Origin/设备/公钥/随机数/签名拒绝、取消释放等待，
  以及真实隔离中心配对 → Rust gateway 验签 → direct session catalog。
  未带 lease 不获 RPC 权限，伪造 lease 返回 LEASE_INVALID，真实中心签发 lease 获 RPC/lifecycle 权限。
- 测试只创建内存身份和隔离服务的临时 grant，结束时发送 unpair 并验证成功；没有访问用户持久配对。
- 握手和持久身份现已接入工作台路由，验证范围见下方路由验收；原生 P2P 仍未实现。


## 直连持久身份与配对存储（2026-09-05）

- `LocalIdentityStore` 把 P-256 身份与配对记录保存在 ThisDeviceOnly Keychain，
  service 用服务器完整 URL、已认证 accountID 和 Origin 的长度前缀编码哈希隔离。
  私钥不写文件或 UserDefaults；存储失败抛错，不改用临时身份。
- 首次 SecItemAdd 使用唯一 service/account，重复项回读已持久化的胜出者，不覆盖身份。
  配对记录绑定身份公钥，校验协议版本、端口和有效 P-256 网关公钥；可独立删除单台配对或全部配对，保留身份。
- 并发验证曾触发 macOS legacy Keychain 内部锁等待，采样确认后增加共享 `KeychainAccess`，
  登录 token 与直连凭据的 Security 调用统一串行化，跨进程仍由 Keychain 唯一键裁决。
- 8 路首次创建取得相同公钥；重新构造 store 恢复身份签名、不同服务器/账号/Origin 隔离、
  无效网关不覆盖配对、清除配对保留身份均通过。恢复的身份/配对与真实 Rust 网关完成直连认证和 lease 校验。
- 客户端公开中心认证返回的 accountID，暂时断线保留、登出/认证失败清除，
  为后续 provider 创建命名空间提供已认证依据。macOS 33 项全套、共享 Swift 45 项 + 3 项 XCTest、iOS 构建通过。
- 测试使用 UUID 隔离命名空间；中断测试遗留记录由应用内临时清理用例删除，随后确认无测试记录残留，临时用例已移除。
- 当前 App 已通过 NativeLocalDeviceProvider 使用该 store 和 connector；完整连接能力尚未对齐 Web。


## 原生工作台路由接入（2026-09-05）

- App 默认注入原生 provider，使用 Keychain 身份和中心 pair/lease；未注入的共享客户端维持 relay。
- direct 立即尝试，relay 延迟 250 ms 竞争；relay 激活后 2 秒尝试提升，失败每 30 秒重试。
- session/elevated 分 lane：中心断线保留已认证 direct session，关闭 relay 与 elevated；RPC/lifecycle 要求有效在线 lease。
- 真实隔离 Rust 联调通过：relay 输出 → direct 提升保留输出 → 中心断线继续输入 → 恢复后 Git RPC → direct 失联回退 relay 继续输入 → 再提升 direct → 关闭任务和登出。
- 连接丢失立即取消旧提升任务；断线横幅会注明当前工作区的本机终端仍可使用。
- 仍待验证和完善：lease 到期、服务端真实撤权与传输竞争代际的更多边界；WebRTC/P2P 尚未实现。上述路径通过不代表全部连接能力交付。

- 路由接入后回归：macOS 34 项、共享 Swift 45 项 + 3 项 XCTest 全过，iOS Simulator 构建成功。当前测试 App 的 20 个 Mach-O（含测试框架）未见 JavaScriptCore/WebKit 直接链接，未发现 JS/HTML/WASM 资源。


## 配对并发和设备移除（2026-09-05）

- NativeLocalDeviceProvider 按账号和设备共享首次配对；8 个等待者只发送一次请求。单个取消不影响其他等待者，全部取消或设备移除会撤销请求。
- 取消后迟到的成功响应不能重新持久化 grant；旧认证失败仅删除它实际使用的 grant，避免误删新配对。
- 中心 daemonRemoved、恢复快照中消失的设备均关闭全部 lane、测量/目录轮询和未完成请求，清除对应配对。认证失效仍关闭整个 router 并清账号配对。
- 测试捕获并修复迟到 ping 结果重新写回已移除设备状态的问题；过期路由不能重连，全部为空的连接信息会删除。
- 验证包括配对取消/迟到响应的真实 Keychain 测试，以及共享核心注入控制事件的移除/快照/认证失效测试。服务端真实解绑、lease 自然到期和更多传输竞争仍需独立验收。

- 本轮最终回归：macOS 37 项、共享 Swift 47 项（其中移除测试含 3 个参数用例）及 3 项 XCTest 均通过；iOS Simulator 构建成功。


## 授权恢复和真实撤权验收（2026-09-05）

- 共享路由新增两种授权恢复用例：注入时钟推进至 lease 的 2 秒安全余量内，以及设备返回 scope_denied。均确认旧连接关闭、新连接 generation 增大、两个未完成 Git 请求成功完成；重投保留原 requestID/operationID。
- 真实隔离 Rust 网关用例新增 localUnpair：已建立的 session/elevated 连接均主动关闭，旧 grant 无法重连。最后一个 Origin 配对被撤销时，中心同步移除 Origin allowlist，网关可在 HTTP upgrade 阶段拒绝；有其他同 Origin 配对时可在认证阶段返回 grantUnknown。
- 共享 Swift 全套 48 项（授权恢复含 2 个参数用例）与 3 项 XCTest 通过；macOS 网关定向 3 项通过。本轮仅增加验收测试，未更改 App 运行时代码。
- 仍未证明真实 lease 自然到期的端到端时序，未实现 P2P；HTTP upgrade 拒绝后的旧配对缓存恢复也需后续评估。不能据此勾选完整连接能力对齐。


## 启动地址校验（2026-09-05）

- COFLUX_SERVER_URL 仅在未设置时使用构建默认地址；显式提供空值、相对路径、非 WebSocket 协议、用户凭据、fragment 或无效端口均停止初始化。
- 错误配置显示原生“服务器地址无效”页，不构造 CofluxClient、不读取 token、不回退连接其他环境，也不显示原始地址中的潜在敏感信息。修正环境配置后重新启动即可。
- 2 项地址测试覆盖默认值、非法配置、自定义服务器路径、IPv4/IPv6。CUA 实际启动非法地址确认错误页和退出按钮；重新以隔离服务地址启动，确认原有工作台、终端和本机直连标识恢复。

- 启动入口修改后 macOS 全套 39 项测试通过。


## 原生高亮语言扩展（2026-09-05）

- 在现有 JS/TS/JSX/TSX 基础上，接入官方 Tree-sitter Rust 0.23.2、Python 0.23.6、Go 0.23.4、JSON 0.24.8、Bash 0.23.3、C 0.23.4；均使用 ABI 14，与当前原生解析器兼容。
- 支持 rs、py/pyi/pyw、go、json/jsonc、sh/bash、c/h，以及 .bashrc/.bash_profile/.profile。JSONC 使用 JSON 语法容错，尚未承诺覆盖所有 JSONC 扩展。
- 包、查询规则与许可证同步锁定；App 无需下载语言代码、不执行被高亮文件。

- 高亮语义与 Unicode 范围测试通过；CUA 在隔离导入仓库实际检查六种语言变更页的颜色和滚动，样例文件已清理。App 20 个 Mach-O（含测试框架）及资源扫描未发现 JavaScriptCore/WebKit 直接链接或 JS/HTML/WASM 资源。

- 语言扩展后 macOS 全套 40 项测试通过。


## diff 两版语法隔离（2026-09-05）

- 修复把删除行与新增行拼成一份源代码解析的问题：旧版包含删除/上下文，新版包含新增/上下文，分别查询后映射回 diff 行 ID；删除行使用重命名前的路径选择语言。
- 不连续 hunk 独立解析，避免缺失上下文时前一段未闭合字符串污染后续段；仍只拥有 diff 片段，不能声称等同于完整文件的语法上下文。
- 行范围投影和重叠 token 排序移入高亮 actor；主线程只创建属性文本，每 64 行让出执行并检查取消。完整文件发布前仍保留普通文本，可继续查看变更。
- 多行 Python 字符串的旧/新版本、后续 return 关键字和分离 hunk 测试通过。

- Debug 合成 6000 行 Rust diff：后台解析/范围映射约 329 ms，期间主线程 2 ms 心跳执行 111 次，全部行关键字映射通过。这不包含 SwiftUI 布局/滚动，也不是相对 Web 的性能结论。macOS 全套 42 项测试通过。


## 开发凭据隔离与端口入口（2026-09-06）

- 用户反馈重签名开发 App 弹钥匙串授权。Debug 默认使用不落盘的登录会话，不构造持久身份 provider，因此常规 UI 联调走 relay；只有明确设置 COFLUX_KEYCHAIN_DEV=1 才开启开发凭据/直连持久化。Release 仍使用 Keychain 和原生 provider。
- 钥匙串相关集成用例默认跳过，仅 COFLUX_KEYCHAIN_TESTS=1 显式执行；后续不得把跳过计为通过。此次未访问、删除或修改旧钥匙串记录。
- 对齐当前 Web：每个终端标签独立提供端口菜单，后台标签无需激活即可打开其预览；右侧直接列出活动终端的端口链接。端口以不带千分位的十进制显示。
- CUA 临时会话登录和端口操作未出现钥匙串提示；真实隔离终端启动 18089 服务，本地 HTTP 返回 200，切到第二标签后仍能从第一标签菜单打开系统浏览器。
- 浏览器收到的是测试服务器生成的 HTTPS localhost 预览 URL，隔离服务未配置 TLS，页面加载失败；未绕过安全校验，端到端预览尚未验收。测试服务、额外终端和浏览器页均已清理。

- 本轮默认回归：42 项中 35 项通过、7 项钥匙串用例显式跳过、零失败。


## 输入法提交与普通粘贴（2026-09-06）

- SwiftTerm 1.15 的 insertText 仅处理 NSString，AppKit 可提供 NSAttributedString；UploadTerminalView 将其转换为纯文本再交回基类，保留组合态清理和终端键盘协议。
- AppKit 输入回调测试：带属性候选不提前发送，提交“你好😀”只发一次 UTF-8、清除 marked text，后续普通文本可继续输入。
- CUA 实际系统粘贴 printf 命令并回车，在隔离真实 PTY 看到了“原生粘贴😀”输出。工具报告剪贴板等待超时，但截图确认已成功粘贴，未重复发送。
- 该证据不替代具体中文输入法的候选窗口/选词/撤销与复杂快捷键完整验收；常规验证继续不访问钥匙串。

- 本轮回归：36 项通过、7 项钥匙串用例跳过、零失败。


## 侧栏宽度恢复（2026-09-06）

- 对照 Web sidebar.tsx，项目折叠仅在本次运行保留；侧栏宽度持久化，双击分隔线恢复 260。原生补齐双击重置及其持久化，保持 200–480 的既有范围。
- 构建通过；CUA 实际拖宽侧栏、退出并重新登录，确认宽度恢复，再双击分隔线确认恢复默认。开发版使用临时会话，未访问钥匙串。


## 添加设备与 P2P 分帧准备（2026-09-06）

- 添加设备面板对齐当前 Web 的安装命令 `npm i -g cofluxd && cofluxd up`、复制入口、说明和完成按钮。构建及实际布局检查通过，CUA 回车与 Esc 关闭均通过；尚未点击验证剪贴板内容，未执行安装命令。
- 新增共享 Swift `P2PFraming` / `P2PFrameAssembler`：按当前 Web 与 Rust worker 的 u32 大端长度前缀、16 KiB 消息、30 MiB 帧上限编码和重组。接收按到达字节累积，非法长度使当前重组器永久失效，必须关闭通道。
- 6 项新测试覆盖手写线格式、所有两段切分位置、逐字节输入、非零 Data 索引、300 KiB 帧、尾部半帧、非法长度和完整 30 MiB 帧。共享 Swift 全套 54 项 Swift Testing 与 3 项 XCTest 通过；未访问钥匙串。
- 此分帧层尚未接入运行时。原生 WebRTC 库、SDP 信令、DataChannel 背压、路由竞争/回退及真实 P2P 联调仍未完成，不能视为 P2P 功能已实现。


## 原生 WebRTC 协商验证（2026-09-06）

- macOS 工程接入 stasel/WebRTC 152.0.0，SPM 锁定提交与二进制 checksum；上游和分发包许可证随 App 资源保留。正式分发前仍需完成整个二进制依赖的 notices 审核。
- 新增 NativeRTCPeer：纯数据 reliable/ordered channel、vanilla ICE 收集后一次交换 SDP；关闭幂等，协商错误/取消关闭 peer。未创建音视频轨道，未访问钥匙串。
- 4 项原生 XCTest 通过：两个真实 WebRTC peer 在本机无 STUN/TURN 条件下建立连接，300 KiB 分片数据和中文 emoji 回包完全一致，远端关闭可观察；另验证非法 SDP、已关闭对象、取消协商。SDP 检查包含 application/candidate，不含 audio/video m-line。
- 这仅证明原生库与分帧可协作。尚未接入生产运行路径：TransportConnection 的发送背压/接收队列、中心 offer/channel 授权、设备级 peer 复用、direct/P2P/relay 竞争回退和真实 Rust worker 联调仍需完成。
- 加入 WebRTC 后 macOS 全套回归：47 项中 40 项通过、7 项钥匙串测试跳过、零失败。构建成功；WebRTC framework 未直接链接 JavaScriptCore/WebKit。


## 原生 DataChannel 传输适配（2026-09-06）

- 新增 NativeRTCConnection，符合共享 TransportConnection：专用后台串行队列进行分片、重组和 continuation 管理；并发 send 的完整帧串行发送，不交叉分片。
- 发送按 1 MiB SCTP 缓冲水位暂停，每轮最多 256 KiB 后让出队列；发送队列限制字节和帧数。接收在回调入队前记账，限制积压字节和未消费帧数，超限关闭通道。该上限只覆盖适配层缓存，不代表 WebRTC/系统或 App 总内存上限。
- 取消发送可能已留下半帧，因此关闭整条流并结束所有 send/receive 等待；非法前缀、非二进制消息、发送失败也关闭，避免失步后继续使用。
- 5 项真实原生 DataChannel 测试通过：30 MiB 帧及后续中文 emoji/反向回包、8 路并发完整帧、非法前缀拒绝、取消待发送帧同时结束接收、4097 条未消费小帧触发上限关闭。
- 仍未接入中心授权与设备路由；不能据此认定产品的 P2P 功能已对齐。下一步接 offer/answer/channel 控制消息、peer 复用与 direct/P2P/relay 竞争回退。
- 最新 macOS 全套：52 项中 45 项通过、7 项钥匙串测试跳过、零失败。


## P2P 协商与授权 provider（2026-09-06）

- 新增共享 P2PDeviceTransportProvider 接口及 macOS NativeP2PDeviceProvider。按 account/daemon/clientInstance 复用 peer，首次 channel 创建后才生成 offer；每条 channel 独立携带 generation 请求授权。
- 严格匹配 answer.connectionID、channelResult.channelID 和成功状态，授权后才返回 TransportConnection。中心控制请求的超时/取消由注入的 authorize 实现负责；连接和 DataChannel 打开另有 10 秒等待上限。
- 每条通道关闭释放自己的引用，最后一条关闭才清理 peer；closeAll/remove 使旧 peer 失效，迟到授权不能复活。NativeRTCPeer 新增可用状态检查。
- 4 项测试使用真实原生对端和可控中心响应：双通道一次协商/两次授权且独立关闭；错误 channelID 拒绝；设备移除后的迟到授权拒绝、重试创建新 peer；取消一条待授权通道后另一条仍可发送。共享 Swift 全套 54 项 Swift Testing 与 3 项 XCTest 通过。
- 尚未把 provider 注入 App 或 DeviceRouter。当前测试不代表真实中心/worker 信令联调；后续需接控制消息关联、中心断线清理、竞争提升/回退与端到端数据面验收。未访问钥匙串。


## P2P 路由接线与真实 Rust 联调（2026-09-06）

- CofluxClient 接收 P2P provider 并传递 authOk 的 ICE servers；DeviceRouter 关联 offer/answer/channel 授权响应，中心断线、账号重置和设备移除清理 provider 与待决请求。
- 接入 direct/P2P/relay 建连竞争、中继提升与失败回退；P2P 失败后暂退避 30 秒。侧栏补当前 Web 的 Radio 图标和 P2P 直连提示。App 默认启用原生 P2P；Debug 仍不访问 Keychain、不启用持久化 loopback 身份。
- 3 项新增共享路由测试验证授权后 P2P 激活、中心断线关闭、失败回退 relay、relay 提升 P2P、P2P 再次断开退回 relay、移除期间的协商撤销。
- 真实隔离中心 + Rust worker 联调通过：原生 P2P PTY 输入输出、Git RPC；关闭 WebRTC peer 后，同一终端回退 relay 并继续输入，保留此前输出。测试终端已关闭清理。
- macOS 全套 57 项中 50 项通过、7 项钥匙串跳过、零失败；共享 Swift 57 项 Swift Testing + 3 项 XCTest 通过。当前 App 扫描 14 个 Mach-O，无 WebKit/JavaScriptCore 直接链接，也无 JS/HTML/WASM 资源。
- 尚未完成完整网络 parity：静默 P2P 通道探活、Web 的指数退避与稳定窗口、不可达 STUN 的候选降级、跨网络 NAT 打洞和更多三路竞争场景仍需处理；不能把本机联调当作跨网络验收。
- iOS Simulator 构建通过；未修改 iOS/mobile 功能。


## 静默链路探活与 P2P 退避（2026-09-06）

- session lane 激活即探活，之后每 15 秒一次；5 秒无 pong 立即补发，连续两次无响应摘掉连接并恢复。探活不再依赖侧栏测量，也不登记 pendingRequests，避免把空闲 lane 钉住。
- pong 必须匹配 requestID、通道 generation 和当前 active；新连接不继承旧连接的超时或 miss。旧 worker 返回 empty_payload/unsupported_payload 时停止该设备的心跳，避免无限误判和重连。
- P2P 失败退避改为 5/10/20/40/80/160/300 秒封顶；当前 P2P 的有效 pong 清零。提升循环按剩余退避时间继续尝试。当前 Web 使用 pong 恢复，并没有此前文档笼统提及的额外稳定窗口。
- 新增四项注入短计时的行为测试：无侧栏测量的静默 P2P 回退 relay、错误 pong 不清超时/正确 pong 清除、旧 worker 安静降级、在途心跳不妨碍空闲释放。
- 共享 Swift 61 项 Swift Testing 与 3 项 XCTest 通过；macOS 全套 50 项通过、7 项钥匙串跳过、零失败，包括真实 P2P PTY/Git/回退联调。未访问钥匙串。
- 本次核对发现当前 Web 还有中心控制连接短断时保留远端 session 数据通道 15 秒的宽限；原生仍立即关闭 relay/P2P，需继续对齐。不可达 STUN 的候选降级、真实网络静默丢包与跨 NAT 打洞也仍需验收。
- iOS Simulator 的 App 与测试目标 build-for-testing 通过。


## 中心短断的会话宽限（2026-09-06）

- 新增 setControlDisconnected，普通网络断开最多保留 15 秒既有 relay/P2P session 通道。只允许断线时已经激活的通道继续输入/输出；新连接和 elevated RPC/lifecycle 立即失效。重复断线/connecting 不延长窗口。
- 重新认证成功撤销定时关闭，复用原通道；宽限到期关闭远端通道及 P2P peer。本机已认证 direct session 仍按既有离线语义保留。
- setControlOnline(false) 始终是明确撤权，即使已在宽限中也立即收敛；登录换凭据、登出、authError/outdated 不获得宽限。显式 suspend 保持原先立即关闭远端通道的行为。
- 五项共享测试覆盖宽限内输入与 RPC 拒绝、重连后同通道继续、重复断线不延长、宽限中明确撤权、elevated 立即关闭。共享 Swift 66 项 Swift Testing 与 3 项 XCTest 通过。
- 真实隔离中心/Rust worker 联调新增只断客户端中心 WS：阻止重新拨中心期间，原生 P2P 终端收到 `grace:survived` 命令输出；恢复中心后仍可用，随后 P2P 断开回退 relay 也通过。工作台横幅区分暂时断中心但终端可用的状态。
- iOS Simulator App 与测试目标 build-for-testing 通过。未访问钥匙串。
- macOS 全套回归：50 项通过、7 项钥匙串测试跳过、零失败。


## STUN 无响应时保留已有候选（2026-09-06）

- NativeRTCPeer 对齐当前 Web：ICE 收集最多等待 3 秒，截止后使用现有 local SDP 继续协商，不把 STUN 超时直接判为建连失败。取消、关闭和 SDP 错误仍按失败清理。
- 新增真实测试：绑定本机随机 UDP 端口并保持不回复，确认实际收到 STUN 数据报；约 3 秒后返回含 host candidate 的 SDP，两端原生 WebRTC 继续建连并完整传输中文/emoji 帧。测试不依赖公网 STUN。
- macOS 全套 58 项中 51 项通过、7 项钥匙串跳过、零失败。此轮未修改共享核心或 iOS。
- 本机 host candidate 的成功不能替代跨 NAT 打洞验收。后续重心回到完整 UI/交互状态对照与相同负载的性能测量，同时保留未验收网络边界。


## 变更空态与未跟踪文件批量读取（2026-09-06）

- CUA 对照同一隔离工作区的 Web/native 变更空态；原生空态刷新改为无底色文本按钮，加载时显示进度且禁用重复点击。两次截图窗口尺寸尚未统一，不作为完整像素对齐证据。
- 未跟踪文件改为每批最多 8 个并发 Git 请求，与当前 Web 一致；按原路径次序合并。保留 NUL 路径分隔及 argv 传参，文件名含换行/空格不被破坏。单个文件在列表读取后消失，不遮住其他变更。
- 3 项新增测试通过：19 条含 Unicode/换行路径的请求峰值为 8、逆序返回仍按路径顺序合并；单文件失败跳过；取消后不启动后续批次。此次未重复全套 macOS 回归。
- 最新 App 重启后 CUA 检查空态按钮；真实隔离仓库创建 19 个样例文件，UI 显示 19 文件/+38，滚动至 file-18，中文/emoji 高亮正常；样例目录已完整清理，UI 自动恢复空态，刷新可用。快速本机请求未捕获到加载中的截图。
- 未做同负载 Web/native 延迟和帧率对比，不能宣称已经更快。Web 对照页已保留，继续进行完整 UI 状态矩阵和性能验收。


## 变更页刷新与折叠状态验收（2026-09-06）

- 对照当前 Web 的 changes-refresh.ts：增删行数不是正文版本，重新激活标签与手动刷新都必须重新拉取内容。
- 最新原生 App 的真实 CUA 验收：两行 Python 样例从 REFRESH_PHASE_A 改为 B，始终保持 +2/−0；先折叠、切到终端、修改文件、再回变更页，折叠状态保留，展开显示 B。
- 保持变更页激活，将标记改为 C，统计仍不变；点击刷新后正文显示 C。清理本轮样例目录后，变更页自动恢复空态。
- 此轮行为已符合，无需修改刷新实现。证据仅覆盖该未跟踪文本文件的刷新、折叠与空态，不代表完整逐屏 UI 或性能验收。
- 随后 macOS 全套回归成功：61 项中 54 项通过、7 项钥匙串用例跳过、零失败，包含新增批量读取测试及真实 P2P/PTY/Git/回退联调。日志：`/tmp/coflux-macos-093-refresh-full.log`。


## 侧栏行尾移除入口（2026-09-06）

- 对照当前 Web sidebar.tsx 补齐非主工作区行尾 X 与设备行尾 Trash2；使用相同 Lucide 矢量资源，复用既有移除确认对话框。主工作区不创建删除入口。
- 工作区悬停时遮淡末尾文字，设备行保留按钮空间；图标随悬停/键盘聚焦显示，按钮本身保留可访问名称与点击区域。
- 最新 Debug 构建成功。CUA 分别点击两个新入口，确认目标为“原生客户端”工作区与“本机开发设备”，取消后两者仍在列表中；未执行实际删除。主工作区 AX 树中没有删除按钮。
- 自动化没有捕获悬停显隐截图，键盘 Tab 聚焦也尚未完成专项验收；不能据此宣称这两项视觉/键盘行为已验证。此次仅构建及真实入口/取消验收，未重复全套测试；此前 54 通过/7 跳过是本次侧栏修改前的结果。


## 分支选择改为按钮锚定菜单（2026-09-06）

- 当前 Web 使用 320px 宽的分支下拉菜单；原生此前使用模态 sheet，现改为 SwiftUI 原生 popover，分别锚定项目加号和工作台分支按钮。按钮、右键入口和快捷键仍共用同一受控目标；旧菜单关闭回调仅清除自己的目标。
- 去除模态标题栏，搜索固定在顶部，列表按条目数自适应高度并在 240pt 封顶；已占用分支禁用、当前分支可选、搜索/方向键/回车/取消逻辑沿用。
- 最新 App CUA：加号打开后 AX 为 popover，截图确认位于按钮下方且未遮罩整窗；搜索自动聚焦，输入 native-popover-check 出现新建选项，Escape 关闭；⌘N 重新打开同一项目菜单且查询重置。切分支菜单显示当前 native-ui 与被占用的 main，回车关闭当前分支菜单且不改变分支。
- 初次截图发现短列表行高估算不足导致滚动条，随后固定行高 28pt/间距 2pt，容器按每项 30pt 计算。该最终微调需要重新观察，尚未据此声称完整视觉对齐。此轮未创建新工作区或修改现有分支。
- 最终产物再次 CUA 观察：两项分支完整可见，AX 不再出现滚动条，截图确认短列表多余滚动条已消失。macOS 全套 61 项中 54 通过、7 钥匙串跳过、零失败；日志 `/tmp/coflux-macos-093-popover-full.log`，覆盖本轮菜单与上一轮侧栏改动后的构建。


## 终端关闭确认文案与快捷键（2026-09-06）

- 对照当前 Web workbench.tsx 的 requestCloseTask，原生确认标题补入 catalog 终端名称（空名称回退“终端”），说明明确 shell 停止、Tab 永久删除及历史输出不保留；按钮改为“停止并关闭”。关闭机制未改动。
- Debug 构建成功；最新产物 CUA 点击标签关闭按钮，显示“关闭终端「终端 1」？”与完整说明，Escape 取消后同一终端仍在。随后 ⌘W 打开相同确认，点击取消后窗口与终端均保留。
- 本轮没有执行实际终止/删除，也没有增加测试或重复全套回归；仅验证该文案变更的构建与两个 UI 入口。后台不同名称标签、空名称回退尚未追加真实 UI 样例。


## 终端标签关闭显隐与长标题提示（2026-09-06）

- 对照当前 Web workspace-terminal.tsx，关闭图标改为标签悬停或关闭按钮键盘聚焦时显示；保留按钮命中区域和可访问名称，增加稳定 tab.close ID。非活动标签悬停使用 60% accent 背景。
- 标签标题增加系统全文提示，避免放在横向 ScrollView 内的自绘浮层被裁剪；这是原生文本溢出提示的实现差异，没有引入 JS。OSC 非空覆盖与空标题回退规则保持原样。
- 最新 Debug 构建成功；CUA 截图确认未悬停时关闭图标隐藏，AX 关闭按钮仍存在。点击该按钮进入正确终端确认，取消后原会话保留。
- 悬停显示、键盘聚焦显隐以及长 OSC 标题提示弹出仍需真实专项验收；此次未重复全套测试，不把构建通过当作这些交互已通过。


## 图片重编码保留方向（2026-09-06）

- 核对 Web createImageBitmap 与原生 ImageIO 的解码差异：原生重编码此前只取 CGImage 像素，丢弃 EXIF 方向后会上传横躺的竖拍图片。现在对方向 2–8 使用 ImageIO 原尺寸旋转/镜像，再进入 PNG 转换或 JPEG 压缩；预算内支持格式仍原样传输，保留原始元数据。
- 新增两个行为测试：方向 6 的 120×80 TIFF 转 PNG 后为 80×120；1800×1200 确定性噪声 JPEG 大于 3.5MB，压缩后在预算内且为 1200×1800。测试显式核对输入元数据，避免无方向标记的样例产生伪结论。
- 首次大图用例暴露测试字典类型推断将方向值写成 Double，ImageIO 未保留该方向；改为明确的 [CFString: Any] 后，输入方向断言与输出断言均通过。
- TerminalUploadTests 共 6 项通过，日志 `/tmp/coflux-macos-093-orientation.log`；包含既有 IME 提交、bracketed paste、文件上限和 TIFF 转换。本轮没有使用用户图片/剪贴板，也未验证真实拖放或远端查看图片；方向 2–5/7–8 的镜像像素仍未单独覆盖。


## 图片上传与后台标签的真实设备联调（2026-09-06）

- 扩展已有隔离中心/Rust worker 集成用例，通过 UploadTerminalView 图片回调启动带方向 6 的 TIFF 转换与上传；立即切到另一终端，确认结果路径留在原 coordinator，另一终端没有收到路径。
- 通过真实设备 exec/base64 回读 PNG 字节，用 ImageIO 验证落盘图片为 80×120；返回原终端后，待插入路径清空且该路径出现在原终端。测试移除其图片文件并用 Ctrl-U 清空输入行，不执行图片路径。
- 首次连续字符串断言在长路径视觉折行处失败，诊断确认 pending 已清空、控制权有效、路径已回显；仅调整测试以忽略该 UUID 路径的视觉换行，没有修改上传机制。
- 最终定向真实集成通过（3.667 秒），同时继续覆盖既有终端切换、上传、OSC、重连、接管和重启；日志 `/tmp/coflux-macos-093-image-integration.log`。没有读写用户剪贴板，不等同于真实系统拖放/粘贴事件已验收，也未重复完整 macOS 测试集。


## 上传准备的后台取消（2026-09-06）

- 上传准备改为持有显式 detached task 句柄，并用 withTaskCancellationHandler 将上传任务的取消转发到后台任务。此前关闭终端仅阻止发送，仍可能继续压缩整张图片。
- 文件读取前后、图片解码/方向变换之后、每轮缩放和每次 JPEG 编码前后加入协作取消检查；后台返回后再检查调用方取消，防止迟到结果继续上传。
- 单次 ImageIO 解码/编码或 FileHandle 读取仍不可被此逻辑中断，必须等待该系统调用返回；不宣称取消已发送的远端 RPC。
- 新增确定性测试先让后台准备进入工作状态，再取消调用方并释放工作门控；显式验证后台 Task.isCancelled 为 true 且调用方收到 CancellationError，避免仅丢弃返回值的实现蒙混通过。测试不触碰真实剪贴板或钥匙串。
- 最新 macOS 全套回归成功：64 项中 57 通过、7 钥匙串用例跳过、零失败，含后台取消、大图方向/预算和真实图片上传/切换链路。日志 `/tmp/coflux-macos-093-upload-cancel-full.log`。


## 设备 HOME 终端创建忙态（2026-09-06）

- 对照当前 Web：设备入口以 HOME 目录终端为主。原生补齐同设备创建防重入、按钮忙态/禁用、HOME 解析错误与离线说明；不再在设备空态同时显示“选择一个工作区”。
- 忙态覆盖 HOME 查询到目录工作区出现；最多等待 15 秒并提供可重试错误。等待使用异步 sleep，不阻塞主线程。中心错误目前与 Web 一样按全局 lastError 收敛，协议尚无该创建操作的请求 ID；账号变化后不再发送查询后的创建请求。
- Debug 构建成功；真实隔离中心/Rust worker 新增并发创建测试，两次同时调用仅新增一个任务，忙态清除且无错误，本次新增任务清理成功。日志 `/tmp/coflux-macos-093-device-create-test.log`。
- 当前 CUA 隔离设备已有 HOME 工作区，点击设备直接进入既有终端；未删除它来强造空态。因此首次空态的忙态截图、超时和离线后的重试仍需验收；本轮未重复全套 macOS 回归。


## 预览验收环境的协议配置（2026-09-06）

- 核对发现 harness 未设置 COFLUX_DEV，server 的预览 scheme 因而默认为 HTTPS，而隔离监听器实际为 HTTP。与现有 proxy.test.mjs 同样，dev-fixture 显式设置 COFLUX_PROXY_SCHEME=http、p.localhost 与当前隔离端口。
- 预览门禁认证页改指向同一隔离 Web，默认 http://127.0.0.1:15273，可用 COFLUX_NATIVE_WEB_URL 覆盖；fixture 元数据记录 webURL。门禁、一次性授权 code 与账号校验均保留，没有改生产配置或绕过浏览器安全提示。
- node --check 通过。当前既有 fixture 进程没有重启，新配置要在下一次启动时生效；尚未据此宣称原生点击预览到浏览器页面加载已通过。后续需在保留/清理现有 UI 样例后重启隔离环境继续验收。


## 独立预览环境与浏览器门禁联调（2026-09-06）

- 原 19873 服务仍健康，但管理 fixture 的父进程已退出；保留旧对照环境，另起 19874 中心和 15274 Web。fixture 支持 COFLUX_NATIVE_FIXTURE_FILE，避免覆盖旧环境元数据。
- 新增可选 COFLUX_NATIVE_PREVIEW_FIXTURE=1：在真实任务 PTY 内启动 18091 HTTP 样例，等 portsUpdated 确认后才宣布就绪；退出 fixture 沿用 harness 清理。脚本需要 node --import tsx 启动（直接 node 会因协议 TS 的 .js 导入解析失败）。
- CUA 登录 15274 后主工作区显示 :18091，真实链接为 http://device-18091-p.localhost:19874。浏览器直接打开这个已观察到的地址，先显示访问端口预览认证页，随后自动使用已登录状态完成门禁，最终显示“原生端口预览已连通”及 PREVIEW_NATIVE_093。没有绕过证书提示、门禁或注入 cookie。
- Web 链接点击未在受控浏览器 tab 列表新增页面，因此用已观察地址导航验证；不能把此结果记为原生 App 点击链路已通过。下一步需让原生 App 接入 19874，验证端口菜单/按钮。
- 新环境元数据 /tmp/coflux-native-093-preview-fixture.json；本轮 fixture exec session 47943、Vite session 8514。浏览器 id=1，tab 2 为 Web，tab 3 为预览页面，均标记后续继续。旧 19873 及 15273 没有停止。


## 原生按钮到系统浏览器的预览验收（2026-09-06）

- Debug 支持构建设置 COFLUX_DEBUG_SERVER_URL，经生成的 Coflux-Info.plist 传入；默认仍为 19873，环境 COFLUX_SERVER_URL 优先，Release 不读取调试键。本轮以 19874 构建并检查最终 Info.plist，未修改正式服务器地址。
- CUA 登录原生 App 后，主工作区显示真实 18091 端口；点击“打开端口 18091”启动系统 Safari，进入 15274/proxy-auth。输入隔离 admin/admin 后，Safari 显示 device-18091-p.localhost:19874 的“原生端口预览已连通”与 PREVIEW_NATIVE_093。
- Safari 保存密码提示选择“以后”，没有保存测试密码；只关闭本次创建的预览标签，未操作原有标签。链路未绕过门禁、证书警告，也未注入 cookie。
- 本证据覆盖原生活动终端右侧端口按钮→系统浏览器→隔离认证→真实 PTY HTTP 服务；后台标签端口菜单、端口消失后的行为和生产 HTTPS/HMR 仍需补验。当前运行 App 指向 19874，常规不带覆盖的下次构建恢复 19873。
- 构建日志 /tmp/coflux-macos-093-preview-build.log；新增显式 plist 后尚未做完整测试集回归。


## 后台终端端口菜单的浏览器验收（2026-09-06）

- 当前 19874 原生客户端新建“终端 2”（d0372db8-b306-4799-ba54-83e236d98440）并保持激活，从后台“终端 1”的转发端口菜单选择 :18091。
- Safari 新标签成功显示真实服务“原生端口预览已连通”及 PREVIEW_NATIVE_093，复用此前认证，无需重新输入凭据。关闭本次 Safari 标签后，原生截图确认仍高亮终端 2，右侧没有终端 1 的活动端口入口；没有因打开后台端口而激活终端 1。
- 第二标签保留在独立预览 fixture 中供后续切换/端口消失验收，不触碰旧 19873 环境。生产 HTTPS/HMR、端口进程停止后入口撤销仍待验证。
- 最新 macOS 全套回归成功：65 项中 58 通过、7 钥匙串测试跳过、零失败，包含设备创建防重入、上传与真实网络联调；显式 Info.plist 和调试服务器构建配置也已纳入此次构建。日志 `/tmp/coflux-macos-093-preview-full.log`。


## 预览端口停止与恢复（2026-09-06）

- CUA 在 19874 隔离原生终端 1 按 Ctrl-C 停止本次 preview-server.cjs；直连 18091 连接失败后，AX 确认标签端口菜单和右侧“打开端口 18091”同时自动移除。
- 在同一 PTY 重新运行 node preview-server.cjs，HTTP 返回测试页面，原生两个端口入口自动恢复。点击恢复后的右侧入口，Safari 成功显示 PREVIEW_NATIVE_093，证明重新发现后的链接可用。
- 此轮无需修改产品逻辑，未重复测试集。仅覆盖服务进程停止/重启；daemon 断线、生产 HTTPS/HMR 与更多网络边界仍未完成。
- 尝试关闭本轮 Safari 预览标签时工具报告浏览器状态被改变，未确认标签是否关闭；没有继续操作其他标签。隔离预览服务已恢复运行。


## 无终端空态与接管警示呈现（2026-09-06）

- 对照 Web workspace-terminal.tsx 补齐无终端工作区/设备的标题、shell 启动说明和 ⌘T 提示；终端图标改为实际 20pt，置于 40pt 描边圆角框（此前 font 不会改变固定尺寸图标）。
- 被其他客户端接管时补 Unplug 图标、warning 前景/10% 背景/20% 底边，恢复按钮靠右，与当前 Web 警示横幅语义及布局一致；接管和重启机制未改。
- 最新 Debug 构建通过；CUA 打开 19874 的 native-ui 空工作区，AX 与截图确认新标题、说明、图标框和创建按钮完整显示。没有创建或删除终端。
- 警示横幅此次仅编译检查，尚未追加真实双客户端接管后的视觉截图；未重复全套回归。上轮 58 通过/7 跳过为本次呈现调整前结果。


## 接管警示与双端真实输入验收（2026-09-06）

- 使用 19874 同一终端，CUA 从 Web 点击“重新接管”，原生立即显示 warning 横幅、Unplug 图标和靠右的恢复按钮，截图确认完整呈现。
- 原生失去控制权时按 Ctrl-C，HTTP 样例继续返回 PREVIEW_NATIVE_093；原生点“重新接管”后横幅消失，Web 出现输入锁定横幅。原生再次 Ctrl-C 后 18091 连接失败，验证恢复了真实 PTY 输入权限，而非仅隐藏提示。
- 随后原生重新运行 node preview-server.cjs，HTTP 再次成功，测试服务已恢复。本次没有改动代码或重复单元测试；证据针对本机 Web/direct 与原生客户端的控制权交接，不替代跨 NAT/丢包验收。


## 已删除实体的界面状态回收（2026-09-06）

- reconcile 按当前任务/工作区/会话目录清理 terminalTitles、activeTasks、showingChanges、上传/拖放集合，以及已移除项目的折叠状态与设备错误。此前仅 visited 集合和激活请求会收敛，长期创建/删除可能留下旧标题等记录。
- 仍存在的后台任务/会话按 ID 保留，不因切换标签清理。回收只在已有目录快照后执行，不把首次登录未加载视为删除。
- 真实终端生命周期测试扩展：关闭第二任务后注入旧会话/工作区状态，reconcile 后旧记录消失，仍存活会话标题保留；完整登录/切换/上传/重连/接管/重启用例通过（3.632 秒）。日志 `/tmp/coflux-macos-093-state-pruning.log`。
- 本轮未进行长时间内存曲线测量或完整测试集回归；只能证明这些状态记录收敛，不能据此宣称进程无内存泄漏或已快于 Web。


## 退出登录清理与旧请求隔离（2026-09-06）

- 退出时补齐清理终端标题、上传/拖放、分支等待、项目折叠、设备创建忙态/错误、关闭确认和弹窗；保留侧栏宽度等窗口偏好。
- 设备 HOME 创建请求捕获登录代次，退出后的旧响应、异常和 defer 均不能写回新一轮登录的界面状态；同账号重登也隔离。
- WorkbenchStateTests 当前 8 项全通过，日志 `/tmp/coflux-macos-093-logout-race.log`。新增用例将设备请求停在等待 relay 授权阶段，退出并重新投递同账号认证/快照，验证旧请求退出不会清除新忙态或覆盖新错误；另验证账号展示清空、320pt 侧栏偏好保留。
- 竞态用例通过注入控制面事件运行，不建立外部连接、不使用钥匙串；不替代真实登录 UI、完整回归或迟到成功响应的独立验收。


## 端口菜单图标对齐（2026-09-06）

- CUA 发现原生 Menu 把 router 资源按固有尺寸呈现，忽略 SwiftUI label 的 12pt frame，并额外显示下拉箭头；Web 使用 12px Router、20px 按钮且 hasChevron=false。
- 菜单保持 AppKit 原生实现，改用独立复制且固有尺寸为 12pt 的模板 NSImage，按钮设为 20pt 并隐藏菜单箭头；图像可访问描述为“转发端口”，不修改共享资源对象。
- Debug 构建通过（日志 `/tmp/coflux-macos-093-port-icon.log`，有 SwiftTerm bundle 增量构建节点警告）。重启 App 后 CUA 截图确认图标不再放大、无多余箭头；AX 显示“转发端口”。切到终端 2，打开终端 1 菜单得到 :18091，Escape 关闭后终端 2 仍高亮。
- 本轮验收覆盖图标呈现、菜单打开/取消及后台标签选择保持；没有重复浏览器跳转验收或全套测试。完整逐屏对照仍未完成。


## 差异长行与行布局（2026-09-06）

- 对照当前 Web changes-view.tsx，移除额外双列行号，分块标题单独左对齐，增删标记恢复独立 12pt 槽位及语义色。
- 修复原生 Text 自动折行以及仅设 fixedSize 后行首被裁切的问题。解析后在后台按原生等宽字体一次测量内容宽度，为惰性行容器提供明确横向宽度，代码保持单行且无需 JS。
- Debug 构建成功，日志 `/tmp/coflux-macos-093-diff-lines.log`。CUA 验证 preview-server.cjs 从 require 行首显示；横向滚动条到末端后可见 listen(18091,"127.0.0.1") 结尾，语法颜色保留。
- 当前横向滚动仍作用于整列文件卡片，Web 是各文件内容独立横向滚动；长文件性能、多文件宽度、刷新按钮样式与完整回归仍待验收，本轮不宣称差异页完全对齐。


## 各文件独立横向滚动（2026-09-06）

- 差异页外层只纵向滚动，各文件代码内容独立横向滚动；标题、折叠按钮、增删统计保持在卡片固定宽度内。长文件名中间截断并提供全文提示。
- 每行采用明确高度，嵌套横向滚动区按内容高度呈现，避免短文件占满视口；仍保留 LazyVStack，长文件实际性能尚需测量。
- Debug 构建通过，日志 `/tmp/coflux-macos-093-diff-scroll.log`。CUA 在隔离仓库加入第二个长行文件：第一文件滚动位置到 1 时第二文件仍为 0，截图确认第一文件显示末尾、第二文件显示行首，两个标题及统计保持可见。
- 第二文件折叠后点击刷新，折叠状态及第一文件滚动位置保持。验收临时文件已删除，不影响原预览服务。未重复完整回归，也未据此宣称大 diff 性能达到目标。


## 差异页调整后的完整回归与产物复核（2026-09-06）

- 完整 macOS XCTest 67 项：60 通过、7 项钥匙串用例显式跳过、0 失败。覆盖最新退出清理/代次竞态、图片上传、原生高亮、原生 P2P 与隔离真实终端生命周期等现有用例；日志 `/tmp/coflux-macos-093-diff-full.log`。
- 对当前 Debug 测试宿主重新扫描：按真实路径去重后 14 个 Mach-O（含 XCTest 框架），无 WebKit/JavaScriptCore 直接链接，无 JS/MJS/CJS/HTML/HTM/WASM 资源。报告 `/tmp/coflux-macos-093-artifact-audit.json`。未扫描系统间接依赖，不是正式 Release 产物验收。
- 这是现有测试集的完整回归，不等于所有 UI/功能均已覆盖；长差异真实滚动性能、跨 NAT、逐屏对照及正式分发仍未完成。


## 5000 行差异卡顿定位与可见行渲染（2026-09-06）

- 真实隔离仓库新增 5000 行含中文/emoji 的 Rust 文件，旧版嵌套 LazyVStack 导致 CUA 界面读取超时；采样见主线程 SwiftUI/AppKit 布局，进程曾为 100% CPU / RSS 574176 KiB，后续 RSS 856944 KiB。采样 `/tmp/coflux-macos-093-large-diff.sample.txt`。
- 改为累积行高 + 二分查找可见范围，保留整份文件高度与每文件横向滚动，只创建视口上下 100pt 预取范围内的行视图。几何坐标随外层纵向滚动更新，不按整份横向容器高度实例化所有行。
- 新 DiffRowLayout 测试遍历 5000 行（含每 100 行一个不同高度的 hunk），验证 700pt 视口最多 47 行、无覆盖缺口、末尾/空文件边界。UnifiedDiffTests 3 项全通过，日志 `/tmp/coflux-macos-093-diff-window-tests.log`。
- 同一实际文件 CUA 打开与翻页成功，初始 AX 仅附近约 40 行，翻页更新到 0028–0076 附近，截图内容连续；修复后静止快照 CPU 1.4%、RSS 174368 KiB。两次为 Debug 观察快照，不是严谨性能基准，也未与 Web 同负载对比；底部真实滚动、高亮完成时延、帧率及完整回归仍待验证。
- 本次临时大文件已删除，预览样例仍保留。上一轮完整 60 通过/7 跳过是这次可见行渲染修改之前的结果。


## 长差异末尾与删除收敛（2026-09-06）

- CUA 将 5000 行文件滚动到最底端，确认 4963–4999 附近行连续呈现，中文、emoji、语法颜色正常；下一份 preview-server.cjs 正确衔接且可独立横向滚动。
- 发现旧外层 LazyVStack 在底部删除大文件后保留高度缓存，界面仅剩工具栏和空白。行已有显式视口范围控制，因此外层文件容器改用 VStack 确定总高度，保留行级按需渲染。
- Debug 构建通过，日志 `/tmp/coflux-macos-093-diff-shrink.log`。重启后重复“加载 5000 行 → 滚到底 → 删除测试文件 → 刷新”，短文件立即恢复到顶部，不再空白；测试文件已清理。
- 本轮未重复完整测试集；大量文件数量的布局成本、连续滚动帧率、与 Web 的同条件比较仍待验证。


## 差异页刷新与错误恢复呈现（2026-09-06）

- 刷新改为同源 Lucide refresh-cw 14pt 图标、24pt 按钮与“刷新变更”提示；新增 circle-alert 错误图标、居中灰色错误文本，重试带忙态并在加载时禁用。SVG 仅构建时同步，App 不引入脚本运行时。
- Git 失败信息去除空白，优先 error 再 stderr，均空时提供带退出码的兜底，避免空错误让界面误留加载态。
- Debug 构建通过，日志 `/tmp/coflux-macos-093-diff-controls.log`。CUA 截图确认图标正常；隔离测试仓库 core.bare 临时设 true，真实 Git 返回 must be run in a work tree，错误图标/文本/重试按钮完整呈现，点击重试仍显示错误。
- 已恢复并读回 core.bare=false；目录统计更新自动触发刷新并恢复 preview-server.cjs 内容。自动恢复先于手动重试点击，故不把该路径记作手动重试成功。未测试忙态停留的视觉时长，也未重复完整回归。


## 差异准备阶段的协作取消（2026-09-06）

- 差异解析/宽度测量原先直接 await detached.value，页面任务取消不会取消后台任务本身。抽出已有上传路径的 BackgroundPreparation，统一保留任务句柄并通过 cancellation handler 传递取消；上传调用方一同迁移，行为保持。
- UnifiedDiff 提供可抛出的取消检查入口，解析开始和逐行检查；宽度测量逐文件/逐行检查。普通同步解析入口仍不要求调用方处理异常。
- UnifiedDiffTests + TerminalUploadTests 11 项全通过，日志 `/tmp/coflux-macos-093-background-cancel.log`。包括后台任务确实观察到父任务取消、5000 行解析第 32 个检查点抛出后不再遍历、上传/图片/IME 既有用例。
- 单次字符串切分及字体测量等系统调用仍需返回到检查点后才能停止；本轮未重新测量 UI 切换耗时或完整回归，不能宣称任何规模都可瞬时取消。


## 系统剪贴板多行文本验收（2026-09-06）

- 在 19874 隔离环境的终端 2 空提示符，通过 CUA 原生 paste（系统剪贴板路径）粘贴包含中文、emoji、两行文本及末尾换行的 printf 命令。
- paste 工具报告等待应用读取剪贴板确认超时，但截图已显示完整粘贴及 zsh 的 bracketed-paste 选中状态，因此没有重复发送。回车前磁盘测试文件不存在，证明末尾换行没有提前执行命令。
- 按 Return 后提示符恢复；独立读取输出文件，32 个 UTF-8 字节与预期完全一致，含“第一行中文😀”、英文第二行及换行。测试文件已删除。
- 这是实际系统文本粘贴路径验收，不替代系统图片粘贴/文件拖放或真实 IME 候选选词。工具确认超时不算工具调用成功，应用粘贴行为以截图和字节校验为证据；本轮未改业务代码、未重复测试集。


## 拖放权限变化时的遮罩清理（2026-09-06）

- 核对 Web：普通文件使用拖放上传，粘贴主要处理图片；未添加额外文件粘贴语义。Finder 测试文件窗口已准备后关闭并清理，完整跨窗口系统拖放仍未完成。
- 修复原生拖入后丢失控制权/开始上传，draggingUpdated 拒绝但遮罩未撤销的问题。进入、更新与最终准备均按当前权限和文件 pasteboard 重新决定接受状态，拒绝时同步清除拖放提示。
- TerminalUploadTests 8 项通过，日志 `/tmp/coflux-macos-093-drag-revoke.log`。新增独立命名 NSPasteboard 用例：文件接受 → 权限撤销拒绝 → 恢复接受 → 文本替换拒绝，提示状态依次 true/false/true/false；不修改用户通用剪贴板。
- 该用例覆盖实际接受判定共享路径，不模拟完整 NSDraggingSession 或证明系统跨窗口上传成功；尚需该项真实验收。


## 当前完整回归与登录草稿修复（2026-09-06）

- 最新完整 macOS XCTest 70 项：63 通过、7 项钥匙串测试跳过、0 失败，日志 `/tmp/coflux-macos-093-latest-full.log`。覆盖此前差异可见行/取消、上传、拖放权限变化等代码；以下登录展示修改发生在该回归之后。
- 功能审查发现原生认证中替换 LoginView 会销毁账号局部状态，失败后要求重填；Web 账号草稿保留在外层。将原生账号草稿移至 RootView 并绑定，失败返回时账号保留、密码仍清空，焦点在密码框。
- Debug 构建通过，日志 `/tmp/coflux-macos-093-login-draft.log`。CUA 使用隔离 admin 配错误密码，真实拒绝后 AX/截图确认账号仍为 admin、密码为空且获得焦点；只输入正确密码并回车即成功进入工作台。
- 原生源码未搜索到 TODO/FIXME/未实现占位入口，但这不证明功能完整；逐屏对照、系统图片粘贴/拖放、真实 IME、跨网络与正式签名分发等缺口仍未完成。


## 系统预览图片复制与终端粘贴（2026-09-06）

- 创建 32×24 RGBA 渐变 PNG 测试图，在系统 Preview 中打开、全选、复制；原生隔离终端 2 通过真实 Command-V 读取系统图像剪贴板、上传到 daemon，并插入设备返回的 paste-UUID.png 路径。
- 截图确认路径处于 bracketed paste 输入状态，未执行。ImageIO/CoreGraphics 按同一 sRGB RGBA 解码源图与上传文件，二者均 32×24、像素数据逐字节一致。检查脚本 `/tmp/coflux-image-check-093.swift`（输入测试图已清理，不可直接重复运行）。
- Ctrl-U 清空终端中的路径输入，关闭 Preview 测试窗口并删除本次源图和上传图。未访问或删除其他图片/上传产物。
- 本轮证明系统图片复制粘贴的真实链路，非仅调用 onImage 回调；超大图、输入法候选、Finder 跨窗口拖放仍有独立验收缺口。未改业务代码或重复完整测试。


## 第三方许可随应用打包（2026-09-06）

- 新增 scripts/sync-notices.py，根据当前 Package.resolved 核对 checkout 的完整 revision，收集每项依赖及其子目录原始 LICENSE/NOTICE 文本；另包含 WebRTC 二进制框架附带许可与 Lucide 原始许可。
- 当前生成 14 项锁定依赖（含构建工具）+ WebRTC 框架许可 + 图标许可，共 83764 字节，保存于 Sources/ThirdPartyNotices.txt 并加入 App Resources。Help 菜单提供“第三方许可”入口，使用系统文本查看器打开。
- Debug 构建、生成脚本 --check、App 内资源与源码逐字节比对通过；日志 `/tmp/coflux-macos-093-notices.log`。本轮未重复完整回归或实际点击菜单。
- 仍需核实 WebRTC 二进制内部第三方组件的完整分发说明及现行 Web 插画的来源/许可；当前资源收集不等于正式分发审查已完成。

重新生成：`python3 apps/macos/scripts/sync-notices.py --source-packages /tmp/coflux-macos-093-build/SourcePackages`；加 `--check` 验证依赖升级后说明未过期。


## Release 优化构建与可复现产物审查（2026-09-06）

- 首次本次 Release 优化构建通过，使用 CODE_SIGN_IDENTITY=- 临时签名，不调用开发者证书、不启动 Release 的持久凭据路径。最终日志 `/tmp/coflux-macos-093-release.log`。
- 修正 Release 编译暴露的两处源码警告：Optional.map 尾随闭包歧义、导入向导未使用的绑定。重建无上述源码警告，仍有 Xcode AppIntents 元数据跳过与 SwiftTerm 资源 bundle 增量节点警告。
- 新增 scripts/audit-bundle.py：按真实路径去重 Mach-O，检查脚本资源、WebKit/JavaScriptCore 直接链接、许可文本与源码一致、codesign 完整性。当前 Release 主程序同时包含 x86_64 与 arm64，2 个独立 Mach-O（主程序/WebRTC），各项通过。报告 `/tmp/coflux-macos-093-release-audit.json`。
- 命令：`python3 apps/macos/scripts/audit-bundle.py /tmp/coflux-macos-093-build/Build/Products/Release/Coflux.app`。检查不证明 Developer ID、公证、系统间接依赖或运行行为，不代替正式分发验收。
- WebRTC 152.0.0 官方仓库发布元数据指向上游提交 6f37672d358475cd17544121a12494da454d85fb（branch-heads/7977）；发布附件只有 xcframework 与 dSYM，构建脚本仅拷贝顶层 LICENSE。其内部组件许可仍未补齐。插画来源已从当前 Web 源码确认是 ayotomcs.me/claude-mascot，具体许可仍待核实。


### 2026-09-06：优化构建与生产 Web 对照环境

- Performance 构建成功；主程序编译命令确认 `-O -whole-module-optimization -DCOFLUX_PERFORMANCE`。独立 bundle ID 为 `dev.coflux.desktop.performance`，内置隔离服务器为 `ws://127.0.0.1:19874/client`。此配置强制关闭持久凭据，不受开发钥匙串环境开关影响。
- 产物审查通过：2 个按真实路径去重的 Mach-O，无脚本资源、无直接 WebKit/JavaScriptCore 链接，打包许可与源码一致，临时签名完整。报告 `/tmp/coflux-macos-093-performance-audit.json`；不证明正式分发或许可完整。
- Web 生产构建以 Vite preview 在 `127.0.0.1:15275` 运行，代理到隔离服务器 19874。health 实测成功；构建版本 `3c38647`。CUA 使用隔离 admin 账号登录成功，main/native-ui、两个终端和 18091 预览端口加载成功，证明当前服务器接受该生产构建版本。
- 原生 Performance 的 CUA getApp 两次超时，进程检查未出现 Performance 进程；现有 Debug 仍运行。CUA getState 和 Web 操作正常，不能将此解释为原生运行通过，也未通过其他方式绕过 UI 控制启动。
- Web 当前显示本机直连；Performance 禁用持久身份，不能直接拿二者网络交互延迟比较性能。后续比较须区分渲染负载与路由差异；当前尚无优化构建间的有效性能结论。


### 2026-09-06：修复性能版启动失败

- 后续通过 Finder 的真实打开操作及系统崩溃报告确认：之前 getApp 超时实际伴随应用启动退出，并非单纯 UI 工具故障。dyld 拒绝加载 WebRTC，原因是临时签名主程序与动态库无法满足 hardened runtime 的 Team ID 校验。
- 仅 Performance 配置设 `ENABLE_HARDENED_RUNTIME: NO`，配合本机 ad-hoc 签名；Release 仍保留 hardened runtime。未使用开发者证书，未申请钥匙串权限，也未绕过系统安全提示。
- 修复后的优化构建通过，日志 `/tmp/coflux-macos-093-performance-launch-fix.log`。CUA 实际启动成功，以隔离 admin 账号登录，main/native-ui、两终端及 18091 端口均加载；本次未出现钥匙串弹窗。
- 修复后重新执行 bundle audit 通过。此前静态 `codesign --verify` 通过仍不能证明 dyld 可加载，今后必须将真实启动验收单列；Release 的真实签名启动验证仍未完成。


### 2026-09-06：优化版五千行差异与统计格式对照

- 在隔离 repo 创建 5000 行中文/emoji TypeScript 文件，Web 生产构建和原生 Performance 均自动加载为总计 +5001。原生首屏仅暴露附近行；实际操作垂直滚动条到底，截图确认 value_4968 至 value_4999、高亮、中文/emoji 与下一文件衔接正常。测试文件已删除。
- 对照发现 SwiftUI 数字本地化将统计显示为 +5,001，而 Web 显示 +5001。侧栏、标签、差异总计及文件头的增删数改用 Text(verbatim:)，保持紧凑格式。
- 优化构建通过，日志 `/tmp/coflux-macos-093-stat-format.log`；退出重启并重新登录后 CUA 确认侧栏/标签/总计 +5001、文件头 +5000。无钥匙串提示。
- 大差异停留末尾时一次进程快照 CPU 0.1%、RSS 75424 KiB，仅作诊断记录，不是峰值、帧率或 Web 对比基准。窗口逻辑尺寸尚未统一，不能据截图宣称像素级一致。


### 2026-09-06：最新完整回归与许可入口实测

- 最新 Debug 全套 XCTest 执行 70 项：63 通过、7 项钥匙串用例明确跳过、0 失败，测试阶段 30.991 秒，xcodebuild 最终退出 0。显式移除 COFLUX_KEYCHAIN_DEV / COFLUX_KEYCHAIN_TESTS，真实联调目标为隔离服务器 19873。日志 `/tmp/coflux-macos-093-current-full.log`；结果 `/tmp/coflux-macos-093-build/Logs/Test/Test-Coflux-2026.09.06_02-48-35-+0800.xcresult`。
- 此次代码包括近期登录账号草稿、差异虚拟行/取消、统计格式、菜单及最新构建配置。测试不证明 Release 启动、跨 NAT、完整 UI 对照或真实系统拖放。
- CUA 在当前 Performance 中验证：删除五千行文件后恢复单文件 +1；Help → 第三方许可实际由文本编辑打开 bundle 的 `Contents/Resources/ThirdPartyNotices.txt`，包含预期许可文本，随后关闭该文档且未修改资源。该验证仅证明入口与资源可用，WebRTC 内部第三方许可及插画来源缺口仍在。


### 2026-09-06：空工作区主按钮对齐

- Web 生产页面临时设为 1360×830 视口，对照 native-ui 无终端工作区；验收后恢复浏览器默认视口。原生窗口截图仍由 CUA 缩放输出，未做逐像素误差测量。
- 发现原生新建终端按钮使用系统默认灰色外观。新增原生 WorkbenchPrimaryButtonStyle，用于工作区空态：按 Web DOM 实测采用 28 点高度、12 点水平内边距、10 点圆角、13 点按钮文字、#ebebeb 背景和 #171717 前景。保留原生 Button 交互、按压反馈和禁用透明度。
- 空态说明文字按 Web 实测 12px 字号、20px 行高方向调整字号/行间距；标题至正文 6 点、正文至按钮 20 点。原生快捷键保留 ⌘T，Web 的 ⌃⌘T 用于避免浏览器冲突。
- Performance 构建成功，日志 `/tmp/coflux-macos-093-empty-style-final.log`。CUA 退出重启、登录并截图确认浅色按钮和新间距实际生效，无钥匙串弹窗。此次未新增状态逻辑或重跑全套 XCTest；上一轮 70 项回归发生在此样式修改前。


### 2026-09-06：空状态创建、接管与关闭的真实闭环

- 当前 Performance 构建中，通过 native-ui 空状态的浅色主按钮创建临时终端 `bce5bf5e-f35c-4be7-826c-add62ae21d14`。因 Web 对照页也停在该工作区，创建后观察到原生输入锁定提示；点击“重新接管”后提示消失。
- 原生终端输入并执行 printf，截图确认输出 `NATIVE_EMPTY_FLOW_093` 并返回 shell 提示符，证明新建终端可实际输入/输出。
- ⌘W 打开关闭确认，首次选择“取消”后同一终端仍在；再次 ⌘W → “停止并关闭”，临时 tab 消失、原生恢复无终端空状态。随后读取 Web 页面，亦恢复同一工作区的无终端空状态，无需手动刷新。
- 仅创建/删除本轮隔离测试终端，未修改 main 的两个保留终端或真实用户环境。此轮未改产品代码、未重复自动回归；没有测量创建延迟或捕获短暂 loading 状态，不能据此宣称性能或所有忙态均通过。


### 2026-09-06：导入向导路径错误恢复

- CUA 在 Performance 中打开导入项目，设备搜索框自动聚焦，Return 进入设备目录并聚焦目录过滤框。
- 路径编辑输入不存在的临时目录后，原地显示“路径越界或不存在”；输入隔离临时 repo 同样被拒绝。不能将此错误单独解释为目录不存在；worker 的 list_dir 使用 safe_resolve 做根目录约束。未修改真实目录或提交导入。
- 改回原本设备 HOME `/Users/wsq` 后错误清除、路径恢复面包屑、目录列表恢复。Esc 返回设备选择且搜索框重新聚焦。
- 第二次 Esc 关闭操作因系统锁屏未执行，CUA 明确报告物理输入后暂停自动解锁，要求用户手动解锁。当前导入向导可能仍停在设备选择；恢复后先读取状态。新建工作区尚未执行本轮验收。


### 2026-09-06：分支列表失败不再伪装为空列表

- 代码审查发现，分支命令失败但 error/stderr 为空时，旧逻辑将 error 设为空字符串，导致列表被标记为 loaded 并允许新建分支。
- BranchChoices.loadedBranches 现在仅接受 ok=true 且 exitCode=0；失败优先采用去空白的 error/stderr，没有诊断时显示含退出码的错误。CreateWorkspaceView 复用该解析入口，由既有 catch 显示错误并阻止生成可选条目。
- BranchChoicesTests 定向 4 项全过，新增覆盖失败且无文字、空白 error 回退 stderr、ok=true 但非零退出码，以及真正成功的空列表/中文分支。日志 `/tmp/coflux-macos-093-branch-error.log`，xcodebuild test 退出 0。
- UI 锁屏期间完成代码与测试，未操作钥匙串。运行中的 Performance 仍是此前空状态样式构建，尚未包含本次分支解析修复；真实弹窗错误/重试待解锁后的新构建验收。日志含测试代码与 Xcode 元数据警告，不能称为零警告构建。


### 2026-09-06：分支切换隔离退出登录代次

- switchBranch 原先的后台任务未检查登录代次，旧操作在退出后可能清除同账号重登时的新忙态，或显示旧错误。现在捕获 loginGeneration，执行请求前、请求返回后、错误处理及 20 秒延迟清理均检查代次。
- 返回可忽略的 Task 句柄用于等待实际任务结束。新增确定性用例在旧任务已排队但尚未执行时退出、同账号重登、设置同 workspace/branch 新忙态，再等待旧任务结束，确认新忙态保留。
- WorkbenchStateTests 9 项全过，日志 `/tmp/coflux-macos-093-branch-generation.log`。该新用例覆盖排队任务跨登录边界，不等同于真实网络响应迟到或 20 秒自然计时到期的验收。未访问钥匙串。


### 2026-09-06：最新优化版分支菜单与非法创建验收

- CUA 恢复可操作后，Esc 关闭此前停留的导入向导成功。最新 Performance 构建通过，日志 `/tmp/coflux-macos-093-branch-performance.log`，已重启登录，包含分支列表错误兜底和切换登录代次修复。
- Web 与原生新建菜单均将 main/native-ui 标为“已被检出”且不可选。
- 按钮提交 `invalid..branch` 后实际显示 Git 非法分支错误，待创建占位移除并恢复已有工作区。清除提示后再次用 typeText 输入 `invalid..keyboard`、Return 提交，亦显示对应 Git 错误并恢复，证明真实文本输入后回车提交路径可用。
- 首次用 AX setValue 输入后 Return 只观察到菜单关闭，未捕获提交反馈；不能以该尝试声称成功，也未据此修改键盘实现。后续 typeText/Return 得到明确后端错误证据。
- 已关闭本轮错误提示。真实 git refs 仍只有 main/native-ui，无新增分支。测试使用隔离 repo，没有改真实用户项目。成功创建新工作区和分支列表失败后重试的实际 UI 尚需后续验收。


### 2026-09-06：真实创建与删除工作区

- Performance 的新建分支输入框显式点击聚焦后，typeText 输入 native-success-093 并 Return，成功创建工作区 `9566edc5-1920-45fd-a5e8-9c02ecbc09f8`，原生自动切换并显示无终端空状态。Web 列表同步新增，原先 native-ui 选择保持不变。
- 点击该测试工作区的删除按钮，确认窗口展示准确名称；“确认移除”后原生回到 main，Web 同步移除测试工作区。git worktree list 验证仅剩原来的两个 worktree；通过 git branch -d 删除本轮创建且无额外提交的测试分支。
- 新发现待定位：首次打开 popover 后 AX 报搜索框聚焦，但随后的 typeText 导致菜单关闭、文本进入当时的终端 1。未按回车，使用 Ctrl-U 清除测试输入；显式点击搜索框后后续输入/回车正常。不能把当前自动聚焦视为可靠，需区分 CUA 焦点激活与原生异步焦点竞争，尤其终端处于前台时。
- 保留 main 的两个原有终端及预览服务，未修改真实用户项目。此轮无源码修改或重复自动测试。


### 2026-09-06：自动聚焦问题的排除实验

- 用单个 pressKey(n) 替代 typeText，仍观察到 popover 关闭，排除仅由整段文本粘贴造成的可能。测试字符未执行，Ctrl-U 清理。
- 尝试 NativeSearchField 自动聚焦时先调用 window.makeKey，再 makeFirstResponder；Performance 构建成功并重启实测，相同操作仍导致菜单关闭。该修改未解决问题，已从源码撤回，不将其计为修复。
- 需要进一步区分 CUA 按键前重新激活主窗口与原生应用自身的焦点行为。当前没有足够证据判定根因。运行中的 Performance 尚为该排除实验产物，源码已恢复原实现；下次正式验收应重新构建。


### 2026-09-06：聚焦问题缩小到辅助功能打开路径

- 重新构建已撤回 makeKey 实验的 Performance，日志 `/tmp/coflux-macos-093-focus-restored.log`，并重启登录；当前运行产物重新与源码一致。
- 以截图中的实际坐标鼠标点击侧栏加号，再单独发送 n：菜单保持打开，搜索框得到 n。无需额外点击输入框。Esc 后通过 ⌘N 打开菜单，再发送 n，同样成功；最后 Esc 清除测试。
- 与此前 AX 元素动作 click(index) 打开后首键关闭菜单形成对照，表明现象受打开方式影响，不能继续把它泛化为正常鼠标/快捷键操作的焦点缺陷。CUA API 没有独立窗口选择入口，现有证据尚无法区分工具事件序列与 App 辅助功能动作本身。
- 正常鼠标和快捷键路径通过，辅助功能按钮打开路径仍待定位；未增加强制激活窗口的产品代码，也未创建测试分支。实验期间没有钥匙串提示。


### 2026-09-06：差异跨行选择缺口

- 在隔离 repo 创建三行中文 TypeScript 文件 copy-diff-093.ts，用当前 Performance 打开差异页。CUA 以实际坐标从第一行起点拖到第三行末尾，截图未出现连续选择；随后双击第一行 first，AX 明确报告选中文本 first，确认单词选择有效。
- 源码逐行独立 Text(...).textSelection(.enabled)，Web 则由同一 DOM 文档提供跨行选择且增删符号 select-none。现有可见行裁剪还会移除视口外 Text，因此不能把当前实现宣称为完整复制能力对齐。
- 下一步需以原生连续文本选择模型替换逐行选择，并验证跨行原文/中文/emoji、符号排除、滚动跨视口选择及 5000 行性能；不能通过仅添加整文件复制按钮替代拖选功能。当前尚未实施替换。
- 测试文件已清理，未写系统剪贴板或更改保留预览文件。


### 2026-09-06：连续原生差异文本实现与 TextKit 验证

- 新增 NativeDiffText / DiffTextDocument，以只读 NSTextView 替换每行独立 SwiftUI Text。单份文件维持完整 UTF-16 文档，保留高亮，增删符号独立绘制不进入复制文本。背景仍按 DiffRowLayout 的可见范围绘制；文本布局由 TextKit 管理。
- Performance 构建通过：`/tmp/coflux-macos-093-diff-selection.log`。原先构建句柄已消失，但日志明确 BUILD SUCCEEDED，未因句柄缺失重复构建。
- 新增 DiffTextDocumentTests 三项通过：中文/emoji 连续选区不含装饰；TextKit 普通行20/hunk22高度与背景匹配、宽容器长行不换行；5000行布局总高度100000且可取得跨4980行的连续文本。日志 `/tmp/coflux-macos-093-textkit-large.log`，测试总耗时0.199秒，5000行单例0.185秒；这些是 Debug 测试耗时，不是产品性能基准。
- 本轮工具列表未提供 CUA，因此未启动新 Performance 做鼠标拖选。真实剪贴板复制、跨视口拖选自动滚动、横向滚动、多文件选择、5000行实际CPU/内存/帧率仍待验收，不能沿用旧逐行实现的UI性能结论。当前属性文档在主线程构造，仍需实测是否需要分批或后台准备。

## 差异复制输出验证（2026-09-06）

- 文本视图通过统一工厂配置，界面和测试共用 `apply` 刷新路径；相同文本的高亮更新保留选区。
- 用独立命名 NSPasteboard，通过 NSTextView 声明的 writablePasteboardTypes 导出，再读取纯文本：跨行中文/emoji 原文一致，不混入增删装饰；刷新高亮后选区与复制输出仍一致。没有读取或覆盖 general 剪贴板。
- 直接调用单类型 `.string` 导出在本机返回 false；改用 NSTextView 支持的类型列表后通过，未为此自制复制实现。
- 定向 XCTest 3 项通过，xcodebuild 退出 0；日志 `/tmp/coflux-macos-093-copy-output.log`。显式移除两个钥匙串开关，使用临时签名。
- 仍未证明真实鼠标拖选、跨视口自动滚动、产品实际宽度下 Tab/长行完整显示，也未完成最新全套回归。

## 差异末尾空行修复（2026-09-06）

- 新增产品文本视图配置下的长行边界测试：40 个 Tab、重复中文/emoji 和末尾 END，在当前宽度测量结果下确认末字形可见、未越界、整行没有折行。
- 新增末尾空行测试，实际复现 TextKit 使用 14 点空行高度，而背景布局使用 20 点；文档保存末行属性并在刷新后设置 typingAttributes，恢复完整空行高度，保持原文与复制内容不变。
- 定向 XCTest 5 项通过，xcodebuild 退出 0。日志 `/tmp/coflux-macos-093-diff-boundaries.log`。
- Web 引入 Tailwind preflight，默认 tab-size 为 4；原生目前使用 AppKit 默认制表位，Tab 的视觉间距仍需对齐。上述测试只证明该样本宽度容纳完整内容，不证明制表位已一致。

## 原生 Tab 对齐（2026-09-06）

- DiffTextMetrics 为 Tab 设置相对代码起点的四空格制表位，使用 AppKit NSTextTab，保留原始 Tab 字符。ChangesView 横向宽度与文档使用同一字体/制表位计算。
- TextKit 实际字形坐标验证前导 Tab、行中 Tab、连续 Tab、恰好满四列后的 Tab；长 Tab/中文/emoji 行末字形完整可见。普通无 Tab 行在文档构造时跳过重复宽度测量。
- 6 项定向测试通过、xcodebuild 退出 0，日志 `/tmp/coflux-macos-093-tabs.log`。仍需真实窗口视觉/拖选验收；测试用例耗时不作为性能基准。

## 最新完整 macOS 回归（2026-09-06 12:01）

- 隔离服务器 19873 健康检查 HTTP 200 后运行完整 Debug XCTest：78 项中 71 通过、7 项钥匙串集成测试跳过、0 失败，xcodebuild 退出 0。日志 `/tmp/coflux-macos-093-full-september6.log`，结果 `/tmp/coflux-macos-093-build/Logs/Test/Test-Coflux-2026.09.06_12-00-41-+0800.xcresult`。
- 此结果包含连续差异文本、复制输出、Tab/空行修复，以及现有终端/网络/状态测试。跳过项不计为通过，也不代表全功能 UI、性能或分发已验收。
- 当前工具列表没有 CUA 桌面操作能力；真实窗口视觉、拖选和自动滚动仍未补验。未使用替代工具注入 UI 事件。
- 原生审查文档更新为当前 TextKit 实现；后续重点是大文件文档准备的主线程分批与取消，再做优化构建和实际交互验收。

## 连续文本分批准备与取消（2026-09-06 12:03）

- 初始普通文档和逐文件高亮刷新改用异步 prepare；每 64 行让出主线程并检查取消，准备完成后才替换当前文档，发布前再次检查取消。准备时保留旧内容。
- 同步/异步共用 Builder，避免颜色、Tab、换行与末行属性漂移；构造过程中只读未发布文本，视图不会看到半成品。
- 8 项定向 XCTest 通过，xcodebuild 退出 0。5000 行准备期间，另一主线程任务多次获得执行；属性文档与同步构造一致；取消准备不返回文档。日志 `/tmp/coflux-macos-093-diff-yield.log`。
- 这是协作调度和取消的组件证据，不是实际工作区切换 UI 验收或帧率保证。单个超长行、最终 attributed string copy/textStorage 替换和 TextKit layout 仍需性能测量；最新完整回归为修改前 78 项，本次改动后只跑定向 8 项。

## 最新优化产物复核（2026-09-06）

- 包含连续文本/Tab/末尾空行/分批准备的 Performance 构建完成，xcodebuild 退出 0，日志 `/tmp/coflux-macos-093-performance-current.log`。仍使用临时签名、强制内存凭据配置；未启动新产物或访问开发者私钥。
- 对新产物运行 audit-bundle.py 通过：2 个唯一 Mach-O（主程序及 WebRTC），无脚本资源，无 WebKit/JavaScriptCore 直接链接，许可文本字节一致，codesign 严格校验通过。报告 `/tmp/coflux-macos-093-current-audit.json`。
- sync-notices.py --check 通过：14 个锁定依赖及 WebRTC 顶层/Lucide 许可，共 83764 字节。这不证明 WebRTC 内部第三方许可齐全。
- 官方 stasel/WebRTC 152.0.0 发布元数据确认上游提交 `6f37672d358475cd17544121a12494da454d85fb`，分支 7977，资产只有 xcframework 与 dSYM；内部许可尚需继续核实。来源 https://github.com/stasel/WebRTC/releases/tag/152.0.0 。
- 新产物启动、真实拖选/性能与完整 UI 仍未验收；签名完整性不能替代正式签名、公证和分发验证。

## CRLF 差异解析修复（2026-09-06 12:08）

- 真实临时文件使用 CRLF，git diff --no-index 产生 LF 文件头与 CRLF 正文。旧实现按 Swift Character 的 LF 拆分，CRLF 是单个字素，导致三行新增正文合并为一行，行号与 additions 都错误。失败证据 `/tmp/coflux-macos-093-crlf-before.log`。
- 解析改为按 LF Unicode scalar 拆分，移除逻辑行末 CR，让 TextKit 不产生额外段落。保留中文/emoji、空行、正确新增行号；只规范差异文档的显示/复制换行，不改工作区源文件。差异复制采用 LF，不用于字节级保存 CRLF 文件。
- 同时验证选择 hunk header/文档末尾不会改变末尾空代码行的 20 点高度。
- UnifiedDiffTests 与 DiffTextDocumentTests 合计 14 项通过，xcodebuild 退出 0；日志 `/tmp/coflux-macos-093-crlf-after.log`。最新 Performance 构建在此修复之前，尚需更新。

## 当前跨层回归（2026-09-06 12:09）

- 共享 Swift package：66 项 Swift Testing（7 suites）及 3 项 XCTest 全通过，swift test 退出 0，日志 `/tmp/coflux-macos-093-shared-current.log`。
- 当前 macOS 完整 XCTest：82 项中 75 通过、7 项钥匙串集成测试跳过、0 失败，xcodebuild 退出 0，日志 `/tmp/coflux-macos-093-full-current.log`，结果 `/tmp/coflux-macos-093-build/Logs/Test/Test-Coflux-2026.09.06_12-09-04-+0800.xcresult`。
- 本次已包含分批准备、取消、CRLF 解析和选择末尾空行等最新用例。隔离服务 19873 健康检查通过；显式移除钥匙串开关，临时签名，不访问真实凭据。
- 不包含桌面真实拖选、全屏视觉对照、跨网络性能、正式分发及仓库提交门；总体目标仍进行中。

## WebRTC 内置第三方许可补充（2026-09-06）

- 核对锁定 stasel/WebRTC 的 scripts/build.sh：打包仅 cp 顶层 LICENSE；上游 tools_webrtc/libs/generate_licenses.py 需 GN 依赖图生成完整声明，当前预编译资产未提供该图。
- 从发布元数据指定提交 6f37672d358475cd17544121a12494da454d85fb 取得 portaudio、fft、g711、g722、ooura、spl_sqrt_floor 六份原始许可证，落在 licenses/webrtc/。manifest.json 保留精确来源 URL、SHA-256 和未解决项；没有执行下载的生成器代码。
- sync-notices.py 将六份许可纳入 App 声明，校验哈希及 WebRTC 锁定版本；生成和 --check 均通过，当前声明 92297 字节。
- 官方映射列出的 rtc_base/third_party/base64/LICENSE 在该提交返回 404，未擅自替换成其他版本文本。外部 DEPS 库、实际 mac_framework_objc 依赖集合与 Clawd 许可仍待核实，不能宣称许可已完整。
- 尚未重新构建 App 打包新声明，因此此前产物审查不覆盖本次资源更新。

## 优化产物更新与 Clawd 来源核实（2026-09-06）

- 新 Performance 构建已包含 CRLF 修复与 92297 字节许可说明；xcodebuild 退出 0，日志 `/tmp/coflux-macos-093-performance-licenses.log`。产物审查通过，报告 `/tmp/coflux-macos-093-licenses-audit.json`：2 个 Mach-O、无脚本/网页运行层直接链接、许可字节一致、临时签名有效。未启动此新产物。
- Clawd 的 Codrops 原文确认作者 Ayotomiwa Wale-Durojaye 及相同 demo 来源。原 demo 目前返回内容为 404 的页面；文章没有链接到可核对的素材许可证或源码仓库。
- 作者 Github 的 Ayotomcs 仓库虽标有 Apache-2.0，但完整树没有这些素材，不能套用此许可。未联系作者、未发送消息。
- licenses/clawd/provenance.json 保存文章 URL、作者、原 demo、当前三个 Web SVG 的 SHA-256 和许可未确认状态，便于后续核实；不把来源证明当作分发授权。

## 优化 TextKit 分阶段测量（2026-09-06 12:19）

- 修复 Performance XCTest 宿主路径仍指向 Coflux.app 的问题；固定 PRODUCT_MODULE_NAME=Coflux，避免性能产品名导致 @testable import Coflux 失效。正式产品名仍为 CofluxPerformance。
- 运行 Performance 定向测试时显式 ENABLE_TESTABILITY=YES、ONLY_ACTIVE_ARCH=YES、CODE_SIGN_IDENTITY=-，不永久启用可测试构建；使用现有测试环境的内存凭据。
- DiffTextDocumentTests 9 项通过，xcodebuild 退出 0，日志 `/tmp/coflux-macos-093-optimized-textkit.log`。测试宿主 CofluxPerformance 成功运行，但这不是正常登录窗口的交互验收。
- 单次本机优化样本：5000 行中文/emoji 代码，800 点宽度。异步文档准备 35.168 ms；文本视图创建加 apply/textStorage 替换 17.047 ms；ensureLayout 对整个文本容器强制布局 133.597 ms。
- 日志把第二段简称为“存储替换”，实际也包含视图初始化。结果只用于定位阶段，不是统计基准，也不等于首屏、滚动帧耗时或相对 Web 的性能优势。需要继续测量视口局部布局/绘制，检查是否意外要求整份布局。

## 非连续布局错位复现与修复（2026-09-06 12:21）

- 新增真实 TextKit 局部 boundingRect 查询：5000 行，先首屏，再 row4950、row2000。旧 allowsNonContiguousLayout=true 返回后部空字形范围，row4950 的估算 Y 为 30874 而非 99000；背景固定行高与估算正文位置不一致。失败日志 `/tmp/coflux-macos-093-viewport-layout.log`。
- 关闭非连续布局后，三个视口均包含预期行，字形坐标与背景吻合；10 项优化配置测试通过，xcodebuild 退出 0，日志 `/tmp/coflux-macos-093-viewport-exact.log`。
- 性能代价明确：5000 行 prepare 35.593 ms；视图初始化+apply 190.526 ms，之后完整布局查询约 0.021 ms。首屏查询时 firstUnlaidCharacterIndex 已到文档末尾 133889，说明工作发生在 apply 阶段；不能把后续视口查询的微秒数当作首屏性能提升。
- 本次优先恢复显示正确性，刷新阶段的连续主线程占用仍需优化。测试没有真实滚动/绘制/拖选，不替代完整 UI 验收。

## 仅失效可见区域，避免刷新时同步整份排版（2026-09-06）

- 临时拆分 apply 计时定位到全视图 `needsDisplay = true`：单次 5000 行样本，视图创建 0.949 ms、storage 写入 17.325 ms、末行属性 0.040 ms、设置全视图重绘 167.687 ms。诊断日志 `/tmp/coflux-macos-093-apply-stages2.log`，临时生产打印已移除。
- 改用 setNeedsDisplay(visibleRect)，保持连续布局以确保远处正文坐标正确。
- 回归用例加入 800×700 NSScrollView 裁剪，验证可见高度非零且不超过 700；apply 后 firstUnlaidCharacterIndex=890，小于全文 133889，首屏不再同步完成全文布局。该样本 apply 17.013 ms。
- 首部/row4950/row2000 都覆盖正确文本并对齐固定背景；10 项优化 XCTest 通过，xcodebuild 退出 0，日志 `/tmp/coflux-macos-093-visible-invalidation.log`。
- 首次直接请求 row4950 仍需 167.287 ms 连续布局；这是剩余的大跨度跳转成本，未解决。NSScrollView 组件测试不等于实际 SwiftUI 嵌套滚动/真实拖选验收；单次阶段数值不作为相对 Web 的基准。

## 原生空闲布局按激活状态开关（2026-09-06）

- TerminalWorkspaceView 通过 opacity 隐藏非当前变更页，视图仍挂载；这种隐藏不会替应用关闭 NSTextView 的自动后台布局。
- NativeDiffText 接收 ChangesView.active，按实际页面激活状态设置 NSLayoutManager.backgroundLayoutEnabled。创建时默认关闭，显示页启用，离开页面及 dismantle 时关闭；复用 TextKit 自带空闲布局，不新增预热 Task。
- 10 项优化文本测试通过，xcodebuild 退出 0，日志 `/tmp/coflux-macos-093-idle-layout.log`。组件测试默认关闭空闲布局，首屏 apply 样本 16.598 ms，连续已布局字符 890/133889。
- 激活页面的实际空闲预排版速度、CPU/能耗和跳转延迟尚未测量。冷状态立即远跳仍可能同步布局前置文本；本改动不宣称解决该成本。真实 SwiftUI 生命周期仍需 CUA 验收。

## 无变化刷新复用文档（2026-09-06）

- 刷新仍执行 Git 获取最新正文，按完整 DiffFile/行内容/增删类型/行号等比较，仅相等时复用 DiffTextDocument。没有用 additions/deletions 充当内容缓存版本。
- 未变化且已完成高亮的文档直接保留，避免先发布无高亮文本、再高亮的两次 storage 替换与布局；NativeDiffText 的 identity 判断保留现有选区。
- 文档显式记录 highlightingComplete；高亮中途取消时标志仍为 false，下次加载复用普通文本后继续高亮，未知语言的成功空结果可标记完成。
- 新用例覆盖复用已高亮实例、恢复未完成高亮、相同行数不同正文失效，以及相同正文但增删类型变化失效。11 项优化文本测试通过，xcodebuild 退出 0，日志 `/tmp/coflux-macos-093-refresh-reuse.log`。
- 实际窗口刷新闪烁/选区仍需视觉验收；本次未重新运行完整跨层回归或正式分发构建。

## 最新优化配置全套回归（2026-09-06 12:31）

- Performance 全套 XCTest：84 项中 77 通过、7 项钥匙串集成测试明确跳过、0 失败，xcodebuild 退出 0。日志 `/tmp/coflux-macos-093-performance-full.log`，结果 `/tmp/coflux-macos-093-build/Logs/Test/Test-Coflux-2026.09.06_12-30-37-+0800.xcresult`。
- 使用隔离服务 19873，ENABLE_TESTABILITY=YES、ONLY_ACTIVE_ARCH=YES、临时签名，移除钥匙串开关。覆盖本轮视口布局、无变化刷新复用及原有终端/网络/状态测试；测试宿主为 CofluxPerformance。
- 这是优化配置下的完整现有自动化套件，不证明 Web/native 逐屏一致、正常窗口交互、跨 NAT/丢包/真实 lease、IME/Finder 拖放或性能优势；当前 CUA 工具仍不可用。

## 无钥匙串的真实本机网关验收（2026-09-06）

- 核实 lease 属于本机直连 elevated 通道，P2P 通道的中心授权测试不能代替它。LocalGatewayTests 新增纯内存 P256 身份路径，原持久化测试保持 COFLUX_KEYCHAIN_TESTS 门控，不删减原存储/恢复断言。
- 新路径不构造 LocalIdentityStore，也不调用其读取/删除；直接使用软件 P256 临时密钥，与隔离中心和真实 Rust 网关完成配对/挑战签名。
- 实际覆盖 session catalog、无 lease 时没有 RPC scope、无效 lease 拒绝、有效 lease 提升、撤销 grant 主动关闭连接及禁止旧 grant 重连。临时 grant 通过已有 teardown 撤销。
- LocalGatewayTests 共 4 项：3 通过、1 钥匙串持久化测试跳过，xcodebuild 退出 0。新真实网关用例约 0.261 秒；日志 `/tmp/coflux-macos-093-memory-gateway.log`。
- 尚未覆盖 lease 自然到期及续租失败；下一步可在此纯内存路径继续验收，不需要访问用户钥匙串。

## 真实 lease 自然到期验收（2026-09-06）

- 新增纯内存身份测试，真实隔离服务发出的 lease 剩余 44978 ms，等待自然到期；没有改系统时间、缩短 TTL、替换 Rust worker 或触碰钥匙串。
- 到期后同一 elevated 连接上的目录 RPC 返回匹配 requestID 的 scope_denied；普通 session 连接仍能请求 catalog；使用旧 lease 的新握手返回 leaseInvalid。
- 向真实中心申请新 lease 并重建 elevated 连接后，目录 RPC 成功；后续 grant 撤销与旧 grant 拒绝也通过，临时配对按 teardown 清理。
- 定向 XCTest 1 项通过，耗时 45.815 秒，xcodebuild 退出 0；日志 `/tmp/coflux-macos-093-lease-expiry.log`。
- 验收对象为 Native LocalGatewayConnector 与真实中心/Rust 网关协议；不能据此声称 NativeLocalDeviceProvider/DeviceRouter 自动续租、自动回退或 UI 提示已完成端到端验收。

## 原生 provider 的可注入凭据存储（2026-09-06）

- 提取 LocalCredentialStore 能力接口，LocalIdentityStore 继续作为默认 Keychain 实现。NativeLocalDeviceProvider 可显式注入按账号取得存储的 factory；没有配置 factory 时行为保持原样，异常不会触发静默 fallback。
- 测试专用 MemoryLocalCredentialStore 只存在 Tests 目录，P256 私钥和 grant 都仅在内存。后续可用同一个真实 NativeLocalDeviceProvider 验收自动路由/续租，不必开启钥匙串开关或另写假的 provider 实现。
- 新增两项测试验证配对公钥来自注入身份、grant 复用与删除，以及存储错误原样传播且不继续配对。两项优化 XCTest 通过，xcodebuild 退出 0，日志 `/tmp/coflux-macos-093-injected-store.log`。
- 此轮是存储接缝验证，尚未证明客户端自动续租端到端行为；原钥匙串持久化测试仍保留并默认跳过。

## 客户端按需重新取得 lease（2026-09-06）

- 使用 CofluxClient + DeviceRouter + 真正 NativeLocalDeviceProvider，仅凭据存储替换为测试内存实现；实际连接隔离中心与 Rust 网关。观察包装器只记录通道 lease 截止时间，不替代授权/握手或路由逻辑。
- 第一轮持续 RPC 暴露测试假设错误：releaseIdle 会立即释放无待处理请求的 elevated lane，所以 81 次顺序 RPC 建立了 81 次 elevated 通道；不能把它解读为持久在线续租。该轮测试还错误地把 unpair 发给仅支持配对/lease/P2P 的授权回调。
- 修正为第一笔 RPC 获取真实约 45 秒 lease，等待其自然到期，再发第二笔 RPC。路由自动取得新的 lease，两个目录请求成功，session 路由仍为 direct。定向测试 45.767 秒通过、xcodebuild 退出 0，日志 `/tmp/coflux-macos-093-auto-lease-after.log`。
- 临时 grant 改用独立登录的测试控制连接撤销。只读检查隔离数据库 coflux.local_browser_grants 确认本轮及上一失败轮最新 grant 均为 revoked；没有直接修改数据库授权状态。上一失败轮退出登录也已触发服务端撤销。
- 该结果证明按需重新授权，不证明在途长 RPC 穿越 lease 到期、续租失败后的 UI 提示或跨 NAT 性能。测试不读写钥匙串。

## lease 暂时失败时的真实路由回退（2026-09-06）

- 测试包装器仅对 localLeaseRequest 注入失败结果；配对、NativeLocalDeviceProvider、网关签名握手、CofluxClient/DeviceRouter 及 relay 都使用真实实现和隔离服务。
- 授权失败时目录 RPC 成功；观察实际 relay TransportConnection.send 中的 fsList 帧，确认请求确实经中继发送，而非仅依据状态标签判断。
- 恢复授权后下一次目录 RPC 成功，已建立真实 native elevated 通道，relay fsList 计数没有增加。普通 session lane 的 direct 连接仍可用。
- 定向 XCTest 1 项通过（0.524 秒），xcodebuild 退出 0，日志 `/tmp/coflux-macos-093-lease-fallback.log`。临时 grant 通过独立测试控制连接撤销；全部凭据在内存。
- 注入的是单类授权失败结果，不代表中心真实故障、跨 NAT/丢包、所有错误码或 UI 提示已验收。


## 开发凭据隔离与原生直连（2026-09-06）

- Debug 与 Performance 的 App 入口固定使用内存登录会话及 MemoryLocalCredentialScope，不再支持 COFLUX_KEYCHAIN_DEV 环境开关。Release 仍使用持久化钥匙串凭据；钥匙串集成测试仍单独门控，本轮未启用。
- MemoryLocalCredentialStore 已从 Tests 移入 Sources，每个客户端独立持有 scope、按账号隔离软件 P256 身份和 grant。通过真实 NativeLocalDeviceProvider 使用内存存储，因此临时会话也支持原生 direct；取代早先“开发版无 provider、只走 relay”和“内存存储仅在 Tests”的阶段性说明。
- 移入 Sources 并接入 App 后，三项内存配对测试及一项真实 lease 失败回退测试通过（4 项、0 失败）。日志 `/tmp/coflux-macos-093-ephemeral-app.log`；该次构建使用临时签名，不使用开发者私钥。
- 随后移除 Debug 环境开关，只做源码语法检查；没有重新启动 App 或签名。四项测试结果不代表移除开关后的产物已重新验收，也不证明所有钥匙串弹窗来源均已查明。
- Sources 搜索未发现 WKWebView、JavaScriptCore、JSContext 或 evaluateJavaScript。TreeSitterJavaScript 是解析 JavaScript 源文件的原生语法库，并非 JS 运行时；仍须对最终构建产物及实际行为继续审查。


## 差异文件头对齐与无签名编译（2026-09-06）

- 对照 `apps/web/src/components/workbench/changes-view.tsx`：文件头补充 accent/40 整行悬停、图标弱化色及正文顶部分隔线；当前路径与重命名前路径作为同一行尾部截断文本，增删统计使用固定尺寸等宽数字。无正文的普通文件不再显示空横向滚动容器。
- App 的开发凭据隔离改用编译条件，移除常量条件产生的不可达分支警告；Debug/Performance 入口不构造钥匙串存储。Release 持久化路径保留。
- `xcodebuild build` Performance 成功，`CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO`，未启动 App、未执行签名。日志 `/tmp/coflux-macos-093-unsigned-header.log`；源码无编译警告，工具仍报告未依赖 AppIntents 而跳过其元数据提取。
- 这次验证是编译和源码对照，不是 XCTest 或真实窗口验收。原生 CUA 工具当前不可用；悬停、窄窗口、连续拖选和跨文件选择仍需实际验收，整体目标未完成。


## 新建终端的工作区隔离（2026-09-06）

- 对照 Web 的每工作区 pendingCreateRef，将原生全局 createBaseline/createTimeout 改为按 workspaceID 存储。当前工作区的新建按钮只读取自身状态；不同工作区可以各自等待，快照与工作区删除只收敛对应请求，退出登录统一清理。
- 补充 WorkbenchStateTests 用例：A/B 独立忙态、B 先完成不抢 A 的选择、不清 A 的等待、单工作区清理与全量清理。无签名 `build-for-testing` 成功，日志 `/tmp/coflux-macos-093-create-scope-compile.log`。只编译，未执行 XCTest 或启动 App；现有 TerminalUploadTests 两处编译警告仍在。
- 复查发现超时发全局 lastError 会让 RootView 清理其他请求。因此随后改为与 Web 相同的局部撤销等待态，保留重试入口，不发全局错误；该最后删除语句仅完成 Swift 语法检查，尚待下一次完整构建验证。
- 仍有差异：新建终端乐观 Tab、创建期间用户切到其他 Tab 后不抢选择等需要继续对齐。当前修改不代表终端交互完整验收。


## 原生乐观终端 Tab 与选择恢复（2026-09-06）

- 新建时保存真实任务集合与占位标题，立即选中占位 Tab 并从变更页切回终端区域；主区显示“正在创建终端…”。占位状态与真实 task ID 分开存储，不创建伪协议任务，不进入 NativeTerminal、PTY 或 attach 路径。
- 点击真实 Tab 清除占位选择但保留创建等待；点击占位可重新选中。快照新增任务只在占位仍被选中时自动转正，避免用户已切走后抢选择；超时/失败清占位时回落到第一个真实任务，跨工作区等待仍隔离。
- WorkbenchStateTests 11 项实际通过，包括本轮占位、焦点恢复与上轮工作区隔离。日志 `/tmp/coflux-macos-093-pending-tab-test.log`。运行使用 Performance 固定内存凭据、移除钥匙串开关、CODE_SIGN_IDENTITY=- 临时签名；没有使用开发者证书或私钥。
- 这批测试直接驱动模型和控制面快照，不是鼠标/键盘真实窗口验收，也不证明多客户端同时创建时的请求归属。现有协议无 taskCreate 请求关联，仍按与 Web 一致的新增未知任务识别。

- 最新完整 Performance XCTest 回归：93 项，86 通过、7 项钥匙串用例显式跳过、0 失败，耗时 116.823 秒；日志 `/tmp/coflux-macos-093-pending-full.log`。覆盖本轮状态变更、此前内存凭据接入、原生 diff 和真实隔离网关/relay/P2P 等用例。仍不是 UI 全面验收或仓库最终提交门。


## 被接管终端重新显示不争抢控制权（2026-09-06）

- 对照 Web workspace-terminal 的 active effect：detached 会话必须显式激活才能拿回。原生 Coordinator 先前把 becameActive 与 explicitlyActivated 合并，并对 detached 一律 force，导致仅返回面板便争抢控制权。
- 在真实双客户端集成用例中补充隐藏/重新显示 Coordinator 的情形。修复前两条断言失败：detached 标记被清除，竞争客户端丢失控制权；日志 `/tmp/coflux-macos-093-detached-before.log`。
- 修复为 becameActive 仅恢复非 detached 会话，force 只用于明确激活且 detached 的会话。相同用例随后通过（1 项、0 失败，3.171 秒），同时继续验证明确点击接管、输入恢复和已退出终端重启；日志 `/tmp/coflux-macos-093-detached-after.log`。
- 测试使用隔离 fixture、内存凭据和临时签名。隐藏/显示直接调用 Coordinator.update，不代表真实工作区切换手势已验收。上一完整 93 项回归早于该修复，本轮只重跑相关真实集成用例。


## 终端尺寸发送与控制权门控（2026-09-06）

- 对照 Web terminal-pane 的 active && owned 条件，原生 sizeChanged 在创建 80ms 防抖任务前、以及真正发送前都检查 hasSessionControl，避免失去控制权后仍排队处理 resize，或延迟期间失去控制权后继续调用发送。
- 真实双客户端用例确认 detached 可见终端不创建 resize 任务；明确拿回控制权后发送 93 列/29 行，再通过真实 shell 的 stty size 验证远端 PTY 返回 `native-size:29 93`，未只检查本地行列模型。
- 定向真实集成测试通过（1 项、0 失败，3.665 秒），日志 `/tmp/coflux-macos-093-resize-pty.log`。用例同时保留终端切换、重新连接、竞争接管、输入恢复及退出重启检查。临时签名与内存凭据，不启用钥匙串测试。
- 仍未单独注入“已排队 resize 的 80ms 窗口中控制权恰好丢失”的竞态，也不代替真实拖动窗口和多显示器尺寸验收。


## CSS / HTML 原生语法高亮（2026-09-06）

- 对照 Web diff-highlight 的语言映射，新增 CSS、HTML/HTM（扩展名不区分大小写）；上游 TreeSitterCSS 和 TreeSitterHTML 均锁定 0.23.2，运行时仅使用原生 C 解析器和 Swift 查询，未引入 JS/WebView。
- 新增测试核验 CSS 注释/属性/字符串/数字，以及 HTML 标签/属性/注释/字符串，覆盖中文与 emoji 的 UTF-16 范围。NativeDiffHighlighterTests 5 项通过，日志 `/tmp/coflux-macos-093-css-html-tests.log`。
- 高亮查询与锁定 checkout 的 queries/highlights.scm 逐字节一致。第三方许可更新为 16 项锁定依赖 + WebRTC 附加许可 + Lucide，共 94901 字节，sync-notices --check 通过。
- 测试产物审查通过：13 个 Mach-O（包含 XCTest 框架）、0 脚本资源、0 Web 运行时直接链接、许可一致、临时签名有效，报告 `/tmp/coflux-macos-093-css-html-audit.json`。不代表 Release、动态加载、正式签名或完整许可证问题均已解决。
- HTML 内嵌脚本/样式尚未接入语言注入；其他 Web 支持语言仍待补齐，不能将两种新增语言等同于高亮功能全对齐。


## HTML 内嵌语言的原生高亮（2026-09-06）

- 用原生 HTML 树的 script_element/style_element 和 raw_text 定位内嵌正文，交给已有 JavaScript/CSS/JSON Tree-sitter 解析器，再将 UTF-16 范围映射回整份 HTML。不会执行源代码，也不用正则提取标签。
- 支持默认/module 及常用 JavaScript MIME 类型、默认/text/css 样式，以及 application/json、application/ld+json、importmap、speculationrules 数据块。未支持的模板 MIME 类型保持纯文本；不把注释里的标签识别为嵌入代码。
- 6 项原生高亮测试通过（0 失败），日志 `/tmp/coflux-macos-093-html-embedded.log`。新增用例覆盖中文/emoji 前缀与内嵌字符串、JS/CSS/JSON 颜色、HTML 注释和未知模板类型。沿用固定内存凭据与临时签名。
- 这补齐了上一阶段的 HTML script/style 正文缺口；事件属性、style 属性、其他 MIME/模板方言和其他 Web 高亮语言仍未全部对齐。当前证据是解析/范围测试，不是逐屏视觉验收。


## C++ / Java 原生语法高亮（2026-09-06）

- 接入 TreeSitterCPP 0.23.4 和 TreeSitterJava 0.23.5 的 C 解析器，映射 cpp/cc/cxx/hpp/hh/hxx、java；.h 仍与 Web 一致按 C 处理。C++ 按上游 tree-sitter.json 要求叠加 C 基础查询和 C++ 扩展查询。
- 7 项高亮测试通过（0 失败），新增覆盖 C++ 扩展名、模板/基础关键字、原始字符串、Java 关键字及两种语言的数字、注释、中文/emoji 范围。日志 `/tmp/coflux-macos-093-cpp-java-tests.log`。
- 新增查询逐字节匹配锁定上游文件。许可同步为 18 项锁定依赖及既有 WebRTC/Lucide 附加许可，共 97494 字节，校验通过。
- 当前测试 App 的原生审查通过：无 JS/HTML/WASM 资源、无 WebKit/JavaScriptCore 直接链接、许可匹配、临时签名完整。报告 `/tmp/coflux-macos-093-cpp-java-audit.json`。这是测试产物，不证明正式分发或所有运行时行为。
- 仍缺 Web 其他高亮语言、逐屏对照及完整功能/性能验收，未将本轮定向测试当作整体完成。


## YAML / TOML 原生配置文件高亮（2026-09-06）

- 新增 yaml/yml（含大写扩展名）和 toml，使用 TreeSitterYAML 0.6.1、TreeSitterTOML 0.7.0。YAML 0.7.2 的 Swift Package 改用另一个 SwiftTreeSitter 仓库身份，本轮选择无需额外 Swift 依赖的 0.6.1，避免同时引入两份解析封装；不是宣称最新版不可用。
- 8 项高亮测试通过（0 失败），日志 `/tmp/coflux-macos-093-yaml-toml-tests.log`。新增检查注释、Unicode 字符串、YAML 多行块、布尔值和数字，并按最终覆盖顺序验证颜色，防止父级属性 capture 覆盖标量颜色。
- 上游查询与锁定 checkout 逐字节一致；许可同步为 20 项锁定依赖及既有附加许可，共 100177 字节，校验通过。测试 App 审查无脚本资源或 Web 运行时直接链接，许可及临时签名一致，报告 `/tmp/coflux-macos-093-yaml-toml-audit.json`。
- 仍未覆盖 Web 全部语言，真实多屏 UI 对照、完整功能及性能验收继续保持未完成状态。


## Swift 文件的原生语法高亮（2026-09-06）

- 新增 swift 扩展名（不区分大小写），使用 alex-pinkus/tree-sitter-swift 官方 0.7.3-with-generated-files 对应提交 31d17fe7e818a2048c808b5c6fdc2dc792f4f5b5。普通标签不含 src/parser.c，因此锁定带生成 C 文件的提交；LANGUAGE_VERSION 14 与当前运行库兼容，不在构建/运行时调用 JS 生成器。
- NativeDiffHighlighterTests 9 项通过（0 失败），日志 `/tmp/coflux-macos-093-swift-grammar-tests.log`。新增 Swift 异步函数代码样本，核验关键字、数字、注释、中文/emoji 的最终颜色与 UTF-16 边界。
- 高亮查询与锁定源码逐字节一致，许可为 21 项锁定依赖及既有附加许可，共 101504 字节，校验通过。测试产物审查无脚本资源及 Web 运行时直接链接，许可和临时签名有效；报告 `/tmp/coflux-macos-093-swift-grammar-audit.json`。
- 未证明完整 Swift 语法覆盖，仍有其他 Web 高亮语言及整体视觉/交互/性能验收缺口。


## Markdown 块、行内与围栏的原生高亮（2026-09-06）

- 接入 tree-sitter-markdown 0.3.2 的两套 C 解析器，md/markdown 扩展名不区分大小写。块语法定位标题、段落与围栏，inline 节点再交给行内解析器；Rust/JavaScript 等已支持语言围栏调用相应原生解析器并映射回 UTF-16 范围。
- 标题、链接、行内代码有对应颜色；未知围栏语言保留代码块样式，不误当 JS。Markdown 围栏自身暂不递归解析，粗体/斜体字体效果和全部方言仍未完整对齐。
- 10 项高亮测试通过（0 失败），日志 `/tmp/coflux-macos-093-markdown-tests.log`。新增检查标题、行内代码、URL、Rust 围栏、未知语言及 Unicode 前缀后的最终颜色。
- 许可同步为 22 项锁定依赖及既有附加许可，共 102814 字节，校验通过；测试产物审查无脚本资源或 Web 运行时直接链接，许可及临时签名一致。报告 `/tmp/coflux-macos-093-markdown-audit.json`。仍不代表正式分发或整体 UI/功能/性能完成。


## 原生解析时间片与取消（2026-09-06）

- 利用当前 Tree-sitter 原生 timeout/resume API，默认每次解析预算 20ms；超时保留解析栈、让出 actor 后用相同文本续算，片间检查 Task 取消。不因超时返回半份高亮或降级纯文本。
- 高亮及 HTML/Markdown 内嵌解析改为异步 actor 方法，长解析让出期间允许新请求进入；各请求拥有独立 Parser 与局部结果，语言/查询缓存仍在 actor 内串行访问。空输入直接返回空结果。
- 新增 1ms 测试时间片：6000 行真实 Rust 文本产生超时续算且末尾 return 完整着色；20 万行输入确认进入时间片后取消并收到 CancellationError，同一 highlighter 随后成功处理短请求。空文件不产生重试。
- 11 项高亮测试通过（0 失败），日志 `/tmp/coflux-macos-093-highlighter-slices-final.log`。不把解析器预算等同于端到端 20ms 取消保证：字符串编码、查询匹配与结果映射仍存在同步工作，真实窗口切换延迟与帧率尚待测量。


## 高亮查询和行映射的分批取消（2026-09-06）

- 替换一次性 highlights() 收集流程：每 128 个已通过谓词的 QueryMatch 让出 actor 并检查取消；仍使用 QueryCapture.sorted() 保持库的优先级，颜色转换每 512 个 capture 让出。Diff 行映射每 128 行让出，hunk 收集每 256 行检查取消。
- 新测试使用 5 万行真实 Rust 文本，确认进入查询收集后取消，收到 CancellationError 而非部分结果；同一高亮器随后成功处理 JSON。现有各语言最终颜色、内嵌语言和解析续算测试保持通过。
- 12 项高亮测试通过（0 失败），日志 `/tmp/coflux-macos-093-query-batches.log`；6000 行样本本次约 80.0ms、主线程心跳 27 次，属于组件样本，不能推断真实窗口帧率或优于 Web。
- QueryMatch.next 内部单次匹配/谓词、capture 排序及字符串构造仍有同步阶段；分批不能承诺严格的端到端取消时限。完整 App 回归和真实 UI 性能仍待后续验收。


## 多语言与异步高亮后的完整回归（2026-09-06）

- 最新完整 Performance XCTest：101 项，94 通过、7 项钥匙串用例显式跳过、0 失败，115.215 秒。日志 `/tmp/coflux-macos-093-language-full.log`。包含新增原生语言、解析时间片/查询取消，以及真实终端/上传/工作区生命周期/网关 lease/P2P 等现有用例。
- 测试使用隔离 19873 fixture、内存凭据和临时签名，明确移除钥匙串开发/测试开关。该结果不涵盖正式签名、公证、跨 NAT 或全屏 UI 验收。
- 对照当前 Web/原生语言分派：61 种 Web 扩展名中原生登记 33 种，尚缺 28 种及 Dockerfile/Makefile 文件名识别。明细见 HIGHLIGHT-COVERAGE.md；分派覆盖不代表完整语法/嵌入语言支持。
- 当前工具仍无原生 CUA 操作接口；未把组件测试或源码对照当作真实用户手势验收。整体任务保持进行中，未提交代码。


## Ruby / Lua 原生高亮（2026-09-06）

- 新增 rb/lua 扩展名，使用 TreeSitterRuby 0.23.1 和 TreeSitterLua 0.2.0 原生 C 解析器；Markdown ruby 围栏映射到 rb，lua 围栏使用同一 Lua 解析器。
- 13 项高亮测试通过（0 失败），日志 `/tmp/coflux-macos-093-ruby-lua-tests.log`；新增检查两种语言的关键字、数字、注释和 Unicode 字符串，包含 Lua 多行字符串及最终覆盖颜色。
- 许可同步为 24 项锁定依赖及既有附加许可，共 105423 字节，校验通过。测试产物无脚本资源或 Web 运行时直接链接、许可一致、临时签名完整；报告 `/tmp/coflux-macos-093-ruby-lua-audit.json`。
- Web 扩展名分派覆盖更新为 35/61，剩余 26 种及 Dockerfile/Makefile 文件名识别，见 HIGHLIGHT-COVERAGE.md。当前仅运行高亮定向回归，未把它当作整体 UI/功能/性能完成。


## C# 原生语法高亮（2026-09-06）

- 接入 TreeSitterCSharp 0.23.1 的 C 解析器，支持 cs 扩展名及 Markdown csharp/c# 围栏别名。
- 14 项高亮测试通过（0 失败），日志 `/tmp/coflux-macos-093-csharp-tests.log`。新增核验关键字、Unicode 注释/字符串与插值数字的最终颜色，避免父级字符串覆盖表达式。
- 许可同步为 25 项锁定依赖及既有附加许可，共 106785 字节，校验通过。测试产物审查通过，报告 `/tmp/coflux-macos-093-csharp-audit.json`，无脚本资源或 Web 运行时直接链接；只证明该测试产物，不代表正式分发。
- 扩展名分派覆盖更新为 36/61，剩余 25 种及 Dockerfile/Makefile 文件名识别；整体 UI、功能和性能仍未完成验收。


## Dockerfile 原生高亮（2026-09-06）

- 接入 TreeSitterDockerfile 0.2.0 原生 C 解析器，按完整 basename 忽略大小写识别 Dockerfile；Dockerfile.txt 仍为未知文本。Markdown dockerfile 围栏调用同一解析器，不执行构建或 shell 指令。
- 15 项高亮测试通过（0 失败），日志 `/tmp/coflux-macos-093-dockerfile-tests.log`。新增覆盖文件名大小写、目录路径、误识别排除、指令/注释/JSON 字符串颜色及 Markdown Unicode 前缀范围。
- 许可同步为 26 项锁定依赖及既有附加许可，共 108099 字节，校验通过。测试产物审查无脚本资源或 Web 运行时直接链接，许可和临时签名完整；报告 `/tmp/coflux-macos-093-dockerfile-audit.json`。
- 扩展名分派仍为 36/61，另已补 Dockerfile 文件名识别；Makefile 及其余语言、Dockerfile 中 shell 子语言、完整 UI/功能/性能验收仍未完成。


## 多终端输出共享时间预算（2026-09-06）

- 新增 8 个真实 SwiftTerm 组件并发各 5000 行的负载测试，检查各终端结束标记、数据不串流及主线程心跳。原每泵独享 4ms 的实测最大心跳间隔 35.125ms，总排空 243.476ms，日志 `/tmp/coflux-macos-093-concurrent-output.log`。
- 改为按有积压且视图仍存活的泵数量分摊 4ms 预算，每个泵至少推进一块再让出；未改字节顺序、快照代次或接收背压。单次 feed/重置仍可能超过预算，这不是严格的全局时间上限。
- 相同负载修改后最大心跳间隔 9.646ms，总排空 250.129ms，日志 `/tmp/coflux-macos-093-concurrent-budget.log`。这是两次组件样本，不是分位数或真实窗口帧率，不能推断普遍优于 Web。
- TerminalPerformanceTests 6 项通过，包含并发隔离、跨帧 UTF-8/ANSI、快照替换、背压取消及 8.48MB 持续输出。真实多工作区窗口滚动/输入体验仍待验收。


## Makefile 原生高亮与配方正文（2026-09-06）

- 接入 TreeSitterMake 1.1.1，完整 basename 忽略大小写识别 Makefile，Makefile.txt 不误识别；Markdown makefile 围栏复用同一解析器。补充 conditional/repeat/include/exception 的关键字色映射。
- 初次用例暴露上游查询不着色 shell_text，三种路径的配方字符串断言失败，日志 `/tmp/coflux-macos-093-make-tests.log`。随后按原生 recipe_line 树节点提取 shell_text 正文交给 Bash 解析，不执行命令，保留连续配方片段和原文范围。
- 修复后 16 项高亮测试通过（0 失败），日志 `/tmp/coflux-macos-093-make-shell-tests.log`。覆盖变量、条件、导出、内置目标、Unicode 注释/配方字符串、文件名及围栏；不证明自定义 SHELL/.ONESHELL、复杂 Make 展开等完整语义对齐。
- 许可同步为 27 项锁定依赖及既有附加许可，共 109406 字节；检查通过。测试产物审查无脚本资源或 Web 运行时直接链接、许可匹配、临时签名完整；报告 `/tmp/coflux-macos-093-make-audit.json`。
- 扩展名覆盖仍为 36/61，Web 的两个完整文件名入口均已接通。整体 UI/功能/性能仍待完成验收。

## 解析时间片复用 UTF-16 输入（2026-09-06）

- 上游 `Parser.parse(String)` 每次重新编码整份文本；改为每请求编码一次，以字节偏移读取至多 32 KiB，并在超时续算时复用输入。上游 Input 仍复制每个读取块，本次没有消除全部分配或证明峰值内存/速度改善幅度。
- 新增代理对跨 32 KiB 边界的用例，验证完整中文/emoji 注释、后续字符串和关键字范围；既有解析续算、取消后新请求、查询取消及各语言用例一并通过。17 项、0 失败，日志 `/tmp/coflux-macos-093-utf16-chunks.log`。该定向结果不替代最新全套回归。
- Debug/Performance 在工程级固定 Manual、临时签名身份和空开发团队，覆盖 App 与测试目标；Release 保留正式签名配置。生成工程静态核对通过。本轮 XCTest 使用临时签名、内存凭据，未启用钥匙串集成测试；此前用户所见弹窗的具体来源尚未确认。
- 测试产物扫描 13 个 Mach-O，无 JS/HTML/WASM 资源、无 WebKit/JavaScriptCore 直接链接，许可一致、签名完整。报告 `/tmp/coflux-macos-093-utf16-audit.json`，不证明正式分发或动态加载行为。

## 最新原生端完整回归（2026-09-06）

- 复用健康的隔离 19873 fixture，Performance XCTest 完整运行：107 项中 100 通过、7 项钥匙串用例跳过、0 失败，115.634 秒。按日志逐项独立核对计数一致，日志 `/tmp/coflux-macos-093-latest-full.log`。
- 覆盖最新 17 项高亮用例、终端多泵预算、工作区状态、真实登录/PTY/Git、内存身份网关、lease 自然到期及自动重新授权、原生 P2P 和回退。测试使用临时签名，显式移除钥匙串开关。
- 8 终端组件样本最大主线程心跳间隔 9.121ms，排空 245.250ms；仅为本轮样本，不是窗口帧率或与 Web 的同条件比较。
- 原生 UI 操作工具当前仍不可用；逐屏视觉、真实拖选/IME/拖放、跨网络和正式分发仍未验收。仓库 TS/Rust/黑盒最终提交门也不能以此替代。

## Dockerfile shell 正文（2026-09-06）

- 通过原生 Dockerfile 树定位 shell_command，把连续正文交给原生 Bash 解析器，保留 UTF-16 范围和续行；RUN 的 --mount 参数、JSON exec 数组不属于该节点，不混入 shell 解析。只分析文本，不执行命令。
- 覆盖 RUN 条件/续行、CMD、ENTRYPOINT、HEALTHCHECK CMD、中文/emoji 字符串、JSON 数组中的 shell 关键字保持字符串色，并验证 Markdown dockerfile 围栏。18 项高亮测试通过，日志 `/tmp/coflux-macos-093-docker-shell.log`；107 项完整回归早于此次改动。
- 产物无脚本资源或 Web 运行时直接链接，许可匹配、临时签名完整；报告 `/tmp/coflux-macos-093-docker-shell-audit.json`。heredoc 正文、自定义 SHELL 与 Windows escape 方言仍未完整对齐，不能据此宣称 Dockerfile 全部语法完成。

## 快捷键组合状态对齐（2026-09-06）

- 对照当前 Web use-global-shortcuts 与 workspace-terminal 的 imperative handle，原生已采用 standalone Command 前缀和物理键位；这次未修改生产快捷键逻辑。
- 新增模型行为用例覆盖从变更页切回终端、标签双向循环、无效数字保持选择、创建占位时关闭不误杀真实终端、离开占位仍保留创建、关闭确认指向当前任务、后台工作区不被修改及帮助开关。WorkbenchStateTests 12 项通过，日志 `/tmp/coflux-macos-093-shortcut-navigation.log`。
- 该验证直接驱动 model，并非真实键盘/输入法/原生 sheet 事件派发验收；菜单、焦点与弹窗组合仍需实际 UI 操作证据。

## 顶栏新建终端等待反馈（2026-09-06）

- 对照 Web workspace-terminal 的新建按钮，修复原生等待期间仍显示静态加号的问题。现在显示原生 mini ProgressView、半透明禁用态，保留 24×24 尺寸，并提供“正在创建终端”的辅助功能标签。
- 沿用既有按工作区创建状态，不改变请求和占位选择逻辑。Performance 无签名构建通过，日志 `/tmp/coflux-macos-093-create-indicator.log`；本轮未启动 App 或执行签名，也未把编译通过当作真实窗口视觉验收。

## 离线删除记账（2026-09-06）

- Swift 共享客户端补齐中心离线时的任务删除记账，同登录认证恢复后在订阅后按序补发，重复请求去重，收到 taskRemoved 前保留目录实体。显式登录、登出、认证失败和账号切换清空；关闭操作跨 await 后检查独立登录代次与账号，防止旧结果影响新登录。
- 新增实际控制帧测试，覆盖重连补发、同账号登出再登录不补发、认证账号改变不补发。共享全套首跑遇到既有 P2P 测试在通道提升与异步 attach 投递之间的竞态，改为等待实际 attach 帧后，67 项 Swift Testing 与 3 项 XCTest 全过；日志 `/tmp/coflux-native-offline-removal-full-fixed.log`。
- 真实 direct/P2P 在中心断线时关闭、停止失败与旧异步关闭跨登录的专项验收仍待补齐；尚未执行这次共享改动后的 macOS 全套回归。

- 后续新增旧关闭等待跨同账号重新登录的确定性测试：真实假传输观察到 deviceRelayConnect 后登出，在旧 continuation 恢复前同步投递新认证与新错误，验证旧失败不能覆盖新错误或发送任务删除。AuthFlowTests 17 项通过，日志 `/tmp/coflux-native-stale-close.log`。只覆盖等待 holder 被 reset 拒绝的分支；真实 stop 成功晚到和断中心直连场景仍未验收。

- 后续真实 WebRTC 关闭专项通过：建立 P2P 终端、输出及 Git 验证后，仅切断测试客户端中心 WS 并阻止重连；设备通道关闭成功、收到 EXITED、本地目录实体保留、无新错误；恢复中心连接后自动删除。测试自身在清理前断言完成，未靠清理代码掩盖补发失败。与原有 P2P/relay 回退共 2 项通过，日志 `/tmp/coflux-macos-offline-close-p2p.log`，临时签名与内存凭据。仍非整个中心服务宕机、跨 NAT、本机 direct 或完整 macOS 回归验收。

- 再补本机 direct：相同流程分别注入原生 P2P 或纯内存身份的 NativeLocalDeviceProvider，明确确认通道模式；direct 完成后撤销测试 grant。direct 离线关闭、P2P 离线关闭、原有 P2P/relay 回退共 3 项通过，4.735 秒，日志 `/tmp/coflux-macos-offline-close-direct.log`。不访问钥匙串；仍未验证停止失败与晚到成功分支或整个中心宕机。

- 停止失败分支补验：假设备实际收到 attach/stop 后，返回匹配 requestID/operationID 的失败确认；验证任务保持 RUNNING、错误显示、当前及重连后的控制帧均无 taskRemove。TaskRemovalTests 1 项通过，日志 `/tmp/coflux-stop-rejected.log`。本次未运行 macOS App、不访问钥匙串；属于协议注入测试，尚非真实 worker 故障或旧停止成功晚到验证。

## 终端标签连接反馈（2026-09-06）

- 新增 attachingTaskIDs，由实际 startTask 请求进入，成功连接、被接管、退出、错误、删除、登出和暂停清理；RUNNING attach 采用 Web 的 500ms 视觉 grace，启动 15s 兜底。原生标签用 mini ProgressView 展示，不把后台 RUNNING 或缺少 holder 当作连接中，也不把 grace 结束当作获得控制权。
- 共享 Swift 全套 70 项 Swift Testing、3 项 XCTest 通过，日志 `/tmp/coflux-attach-indicator-core.log`；新增测试覆盖后台、grace/控制权边界及错误/删除/登出清理。
- macOS 真实终端与工作区状态 15 项定向回归通过（6.878 秒），日志 `/tmp/coflux-macos-attach-indicator.log`，使用内存凭据、临时签名。不是最新完整 macOS 全套或真实窗口视觉验收。

## 断线重连横幅（2026-09-06）

- 对照当前 Web workbench 的重连横幅：原生增加 mini ProgressView、warning 文字/10% 背景/20% 底边框，保留 28pt 布局高度；文案明确自动重连和最后一次同步状态。
- 移除仅凭 direct transport mode 宣称“本机终端仍可使用”的分支；通道类型不证明当前 holder 或任务可输入。网络、路由和控制权判定不变。
- Performance 无签名编译通过，日志 `/tmp/coflux-reconnect-banner-build.log`。本轮未启动 App 或访问钥匙串；实际窗口的渲染、模糊背景和完整断线视觉仍待验收。

## 错误提示可读性（2026-09-06）

- 对照 Web 错误提示，补充 circle-alert 图标、destructive/30 边框、圆角/阴影及普通前景文字；展示文案同样把“任务”替换成“终端”。
- 移除原生 5 行截断，开启文本选择复制；ViewThatFits 优先完整正文，超过 320pt 时采用滚动正文，关闭按钮留在外侧。短提示高度、极长错误滚动和实际选择手势仍需窗口验收。
- 无签名 Performance 构建通过，日志 `/tmp/coflux-error-toast-build.log`。本轮未启动 App 或访问钥匙串，不把编译通过当作视觉通过。

- 后续将提示提取为同一生产组件 WorkbenchErrorToast，用 NSHostingView 检查实际 fittingSize：10 字短错误为 268×80pt，2000 字长错误为 469×376pt（含外边距）；长内容未无限撑高，短提示未固定为最大高度。ErrorToastLayoutTests 1 项实际通过，日志 `/tmp/coflux-error-toast-layout-included.log`，使用临时签名和内存凭据。
- 初次新增测试未重新生成 Xcode 工程，实际执行 0 项；该轮不计为通过。重新生成后确认 1 项已执行。上述尺寸检查仍不证明真实滚动/拖选手势、完整窗口遮挡或逐屏视觉已验收。

## 当前完整回归与产物复核（2026-09-06）

- 最新 Performance XCTest 全套 112 项：105 通过、7 项钥匙串用例跳过、0 失败，119.323 秒；按逐项结果独立核对数量一致。日志 `/tmp/coflux-macos-current-full.log`，覆盖离线 direct/P2P 删除、连接指示、错误提示尺寸及此前原生功能。
- 同轮产物检查：13 个 Mach-O（含 XCTest）、0 JS/HTML/WASM 资源、0 WebKit/JavaScriptCore 直接链接，许可一致、临时签名完整。报告 `/tmp/coflux-macos-current-audit.json`；许可源检查为 27 项锁定依赖及附加许可，共 109406 字节。
- 不替代实际 UI、IME/拖放/跨文件选择、完整语言覆盖、Web/原生同条件性能对比、分发许可与正式签名，也不替代仓库 TS/Rust/黑盒提交门。当前尚未提交，整体目标未完成。

- 错误提示补充 ImageRenderer 原生组件快照并人工检查：两行中文、circle-alert、关闭按钮、圆角警示边框及留白可见且未裁切，展示文案正确使用“终端”。产物 `/tmp/coflux-native-error-toast.png`，同时作为 XCTest 附件保留；渲染与尺寸共 2 项通过，日志 `/tmp/coflux-error-toast-render.log`。仅短文本组件渲染，不代表全窗口、滚动或文字选择手势通过。

## 工作台离屏画面（2026-09-06）

- 新增隔离快照：1 项目、2 工作区、1 设备、0 任务，以 RootView 的生产组合渲染断线/空终端状态，不登录网络或启动 PTY。
- 初用 ImageRenderer 漏掉滚动区列表，原生进度变成占位；不能以图片生成和尺寸断言通过认定正确。改用未显示的 NSWindow 承载 NSHostingView，完成布局后 cacheDisplay；人工查看确认项目列表、选中态、顶栏、空状态和重连进度均可见。
- 逻辑尺寸 1360×860pt，产物 `/tmp/coflux-native-workbench-snapshot.png` 为 2720×1720px 并附于 XCTest；渲染/尺寸组共 3 项通过，日志 `/tmp/coflux-workbench-appkit-render.log`。这是整页静态画面的验证路径，不覆盖窗口装饰、真实输入、菜单、滚动/拖放，也尚未与相同 Web 数据逐项对比。

- 后续完成空工作区/断线状态的同数据 Web 对照，详见 `VISUAL-PARITY.md`。浏览器实际字号发现空状态标题13px、分支/变更按钮13px，已修正原生16/12pt的偏差并重新渲染，3项测试通过；日志 `/tmp/coflux-workbench-type-parity.log`。该状态剩余字体/间距差异及其他状态仍未完整对齐。
