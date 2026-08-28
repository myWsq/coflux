# DeviceRouter 跨端行为 trace

`behavior-traces.json` 是 TypeScript `packages/client` 与 Swift
`packages/swift-client` 共用的 DeviceRouter 语义向量。两端各自用真实状态机和 fake transport
解释同一串事件，避免两份手写测试只在名字上“看起来一样”，实际约束逐渐漂移。

这里仅收录两端真正共有的 relay/session 子集。Web 独有的 loopback、P2P、transport
promotion 和心跳继续由 TypeScript 专项测试覆盖；不得为了让 Swift 消费 fixture 而扩大 iOS
功能范围。

trace 只表达可观察契约，不固定随机 `request_id`、`channel_id`、transport generation、重试次数
或 wall-clock 时刻。64 位序号统一写成十进制字符串，避免 JSON number 精度造成跨语言差异。
新增事件时必须同时实现 TS 与 Swift 解释器；不兼容调整需递增 `schemaVersion`。
