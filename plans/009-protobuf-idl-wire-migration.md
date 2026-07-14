# 009：协议真相源 Protobuf 化 + wire 迁移 protobuf binary

## 背景与决策

协议镜像已达四份（TS 类型 + TS 校验表 + Rust serde + 未来 Swift 客户端），维护不可持续。
决策（2026-07-15，与用户对齐）：

- **真相源**：`proto/`（独立子项目，Buf 管理），`coflux/v1/{common,daemon,client}.proto`。
- **三端生成**：TS（protobuf-es v2）→ `packages/protocol/src/gen`；Rust（prost）→ `crates/protocol/src/gen`；Swift（swift-protobuf）→ `proto/gen/swift`（macOS App 立项后再迁入 App 目录）。
- **wire format 破坏性变更**（原子切换，不做新旧并存——全部 daemon/client 均自有可控）：
  - 旧：JSON 文本帧（内部标签 `type` + camelCase）+ 自定义二进制帧（kind 1..4）。
  - 新：**WS 上只有 binary message，每条 = 一个 protobuf 编码信封**（`/daemon`：`DaemonToServer`/`ServerToDaemon`；`/client`：`ClientToServer`/`ServerToClient`）。数据面（pty/proxy）作为信封 oneof 的普通载荷，payload 一律 `bytes`。
  - protojson 仅用于日志调试，不上 wire。
- **Rust daemon 保留**（CLI 语言问题与真相源解耦，无限期搁置迁 TS 的想法）。

## 语义映射要点（对照旧协议）

- 消息集与语义 1:1 保留；`device.authorizeInfo` 双向同名拆分为 `DeviceAuthorizeInfoRequest`（C→S）/`DeviceAuthorizeInfoResult`（S→C）；`error` 消息 → `ServerError`。
- `TaskStatus`/`FsEntry.type` 由字符串改为 proto enum（DB 存储仍为字符串，hub 做映射）。
- 时间戳（`created_at` 等 ms epoch）与 `FsEntry.size` 用 `double`：保持旧 JSON 的 JS number 语义，避免 protobuf-es int64→bigint 的类型涟漪。
- `timeout_ms` 收窄为 `uint32`；`cols/rows/port` 为 `uint32`（Rust 侧钳制到 u16）。
- pty payload 由「已解码 string」改为 `bytes`：回放与实时输出天然字节一致，旧 `replayFrameToOutput` 的字节级 hack 随之删除；xterm.js `write(Uint8Array)`、SwiftTerm `feed(byteArray:)` 均直接支持。
- 运行时校验：protobuf 解码即结构校验，旧 `isValid*` 手写校验表删除；解码失败/未知 oneof case 丢弃并记日志。
- supervisor⟷worker 的 UDS IPC（`crates/protocol/src/ipc.rs`）为进程内部协议，**不动**。

## 阶段与闸口

1. **proto 建模 + 三端生成**：`buf lint` 过；`buf generate` 产物 into 各消费端。✅
2. **TS 迁移**：`packages/protocol` 重构为「生成代码 + 信封 helpers」；`apps/server`、`apps/web` 全量切换。闸口：两个 `tsc --noEmit` 零错误。
3. **Rust 迁移**：`crates/protocol` 的 `wire.rs` 退役、prost 生成类型接管；`frame.rs` **保留**——它同时服务 supervisor⟷worker 的 UDS 内部链路（PTY 数据 + 热升级传输），改它就要动 supervisor；worker 负责在「UDS 帧 ⟷ WS protobuf 信封」之间转换。闸口：`cargo build` 零警告、`cargo test` 过。
4. **黑盒测试迁移**：`tests/src/harness.mjs` 内联 codec 改为消费 `packages/protocol` 的生成信封（生成代码源自真相源而非应用实现，黑盒性质保持）；全部用例适配。闸口：`pnpm -C tests test` 全绿。
5. **发版**：版本 bump（breaking，0.x 主线跳次版本）+ tag 触发 release.yml（交叉编译 + ed25519 签名 worker + GitHub Release）。
6. **prod-jp 部署实测**：server/web/daemon 全量更新；冒烟：daemon 上线、建任务、终端 IO、断线 replay、端口转发。

## CI 治理

- `buf lint` + `buf breaking --against '.git#branch=main,subdir=proto'` 进 ci.yml；生成产物进 git，CI 校验「重新生成零 diff」防手改生成文件。

## 风险与回滚

- 原子切换意味着部署窗口内新旧不互通：server 与 daemon 必须同批升级（prod-jp 上二者同机，窗口极短）。
- 回滚 = 部署旧版本二进制/静态资源（协议无 DB schema 变更，数据层不受影响）。
