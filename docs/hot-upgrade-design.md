# daemon 自动热升级设计（方案 A）

> 状态：方案已定（**A：supervisor 持有 PTY + worker 可升级**），尚未实现。目标：daemon 后台自动升级，且**升级时运行中的 PTY/Agent 会话存活**。

## 背景与约束

- daemon 散落在用户各台机器上，无法强制升级 → 需要后台自动升级。
- PTY 是 daemon 进程的子进程，daemon 一退出会话就死（B3 决策）。要让会话跨"代码更换"存活，必须把**持有 PTY 的进程**与**会升级的逻辑**分开。
- 信任模型：单用户自有机器。但自动跑下载来的代码 = 潜在全网 RCE，**验签是硬要求**。

## 拓扑

```
        ┌─────────────────────────────────────────┐
        │ supervisor（稳定、极少升级）              │
        │  · 持有 node-pty 进程 + scrollback        │  ← 升级 worker 时这些不动
        │  · 起/管/重启/升级 worker                 │
        │  · 下载新版 + 验签 + 切换 + 回滚           │
        └───────────────▲───────────────────────────┘
          本地 UDS IPC   │  session.create/write/resize/kill/replay ↕ pty.output/started/exit
        ┌───────────────┴───────────────────────────┐
        │ worker（频繁升级，承载大部分逻辑）         │
        │  · 连服务器(WS) + 认证 + git + fs + 协议   │
        │  · 会话编排                                │
        └───────────────▲───────────────────────────┘
                    WS   │  ↕  现有 daemon↔server 协议
                     中心服务器
```

## 关键设计：两级 resync（复用现有模式）

`worker↔supervisor`（本地 UDS）与 `daemon↔server`（WS）**是同一套模式**——"会话跨重连存活 + resync 重挂"，只是下沉一层。
- 升级 = **只重启 worker**；PTY 在 supervisor 里不受影响。
- worker 重启后：① 重连 supervisor 的 UDS、resync 拿回存活会话；② 重连 server、resync。会话全程没死。
- scrollback 放 supervisor → 连 worker 崩溃都能恢复。

IPC：Unix domain socket（Windows 用 named pipe，Node `net` 同一套 path API），worker 作为独立进程连接、可重连，镜像 WS 行为。

## 升级流程

1. server 检测 worker 版本 < 期望 → 下发 `worker.upgrade{version, url, sha256, signature}`（WS）。
2. worker 把信号转给 supervisor。
3. **supervisor**（稳定、安全关键）下载产物 → **验签 + 校验 sha256** → 落盘新版本。
4. supervisor 重启 worker 到新版；worker 重连 + 两级 resync；会话存活。
5. **回滚**：保留上一版；新 worker 在 N 秒内崩溃 M 次 → 自动回退。

## 安全

- 发布产物用私钥签名；**supervisor 内置公钥**，切换前验签 + sha256。
- 全程 TLS；升级下载通道与控制通道分离。
- 版本可固定 / 灰度。

## 代价（取舍）

- PTY 字节多一跳本地 IPC（supervisor→worker→server），背压跨两段。
- 两级 resync、两套连接生命周期，复杂度上升。
- supervisor 偶尔也需升级（那次非热升级，但很罕见）。

## 软化点

跑的是 Agent（Claude Code/Codex），它们有 `--continue/--resume`、成果落工作区文件。即便会话重启，让 agent 自己 resume 往往够用 —— 若接受"自动升级 + 会话重启"，则**基线方案**（launcher + 验签 + re-exec，无 supervisor 拆分）就足够，复杂度低很多。方案 A 是"要会话零丢失"时的选择。

## 待定（开工前）

1. 排序：先收尾二进制数据面、还是先做 supervisor 拆分。
2. worker 打包方式：`node --experimental-sea` / `bun build --compile` / 带 node 运行时 tarball。
3. 签名密钥体系：复用现有的，还是新设计（ed25519）。
