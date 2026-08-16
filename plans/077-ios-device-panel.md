# Plan 077: iOS 设备面板——机群连接路径、延迟与版本一眼可见

> 快速迭代模式（用户："实现一版，先看看效果"）：本档为占号 + 决策记录，设计稿全文见
> 会话产出（信息架构、线框、规范映射），执行=本会话 self-execution，真机验收后按需增补。

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none（消费 076 的 DevicePing 协议与 065 relay 节点信息，均已上线）
- Category: feature
- Execution: self
- Planned at: `63753ba`, 2026-08-16

## Requirement

iOS 端目前全 app 只有项目头一颗 7px 在线圆点，机群的连接路径（relay 节点）、RTT、
worker/supervisor 版本完全不可见。新增设备页把 web 侧栏 tooltip 的信息集搬进 iOS，
信息优先级：健康（在线+RTT）→ 路径（transport+节点）→ 版本 → 身份（host/platform）。

## Decisions & tradeoffs（设计稿定稿 + 用户默认拍板）

- **一个入口一页解决**：首页 toolbar 账号左侧加设备按钮（`macbook.and.iphone`），push
  DevicesView；不做详情页（机群个位数，行三层装下全部，扫一眼优先）。
- **行三层**：名称+状态点+等宽 RTT / host·platform / transport 徽章+版本（mono）。
  离线：空心环+整行 72% 透明，第三层换"离线 · 最后已知版本"；不显示离线时长
  （需 server 下发 last-seen，不为一行灰字动协议）。
- **视觉零新增**：全部沿用 Theme token（051 对齐 web）；transport 图标三分语汇同 web
  （bolt/dot.radiowaves/cloud，形状表路径、颜色表延迟）；RTT 分档同 web 200ms。
- **RTT 心跳只在设备页在场时测**（web measureOnly 同概念）：DeviceRouter 加
  `retainMeasure`，`measureCount` 计入 sessionLaneDemand（否则 ping 间隙 lane 被
  idle 释放、每轮重复 rendezvous）；页面离开即停，不常驻耗电。ping 走既有
  request/response 台账（DevicePing/Pong，076 协议已在），10s 周期 5s 超时。
- **relay 节点**：openRelayChannel 的 rendezvous URL host 存 Channel→activate 时上报
  route（web relayHost 同源）；徽章显示 host 首段（relay-bj）。
- **不做**：iOS P2P transport（WebRTC.framework 另立项，UI 枚举已预留）；设备管理操作；
  "是否最新版"徽标。

## Scope

In: `apps/ios/Coflux/Views/DevicesView.swift`（新）、`WorkspaceListView.swift`（toolbar）、
`Client/DeviceRouter.swift`（retainMeasure/ping/relayHost）、`Client/CofluxClient.swift`
（deviceTransports 状态 + 接线）。
Out: proto/server/daemon/web/mobile 一切；xcodeproj 加测试文件（071 同理由）。

## Done criteria

- xcodebuild 构建过；既有 CofluxTests 不回归。
- 设备页展示全部在线/离线设备四级信息；RTT 与 relay 节点在页面停留时点亮。
- 真机验收待用户（no-frontend-verification 惯例）。
