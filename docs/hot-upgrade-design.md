# daemon 自动热升级设计（方案 A）

> 状态：方案已定（**A：supervisor 持有 PTY + worker 可升级**），尚未实现。目标：daemon 后台自动升级，且**升级时运行中的 PTY/Agent 会话存活**。
>
> 关键决策（2026-06 讨论确认）：
> - **目标基线**：坚持"升级时运行中会话零丢失"，故走方案 A（而非基线方案：launcher + re-exec + agent resume）。
> - **supervisor 用 Rust**，worker 保持 TS。理由见 [§语言与打包](#语言与打包)。
> - **排序**：先收尾[二进制数据面](ROADMAP.md#1-二进制数据面)，再做 supervisor 拆分——UDS 必然要自己分帧，长度前缀二进制帧是 UDS 与 WS 共用的帧格式，先把它做稳，拆分时 WS 这段不返工。
> - **签名**：方向定为 ed25519 + supervisor 内置公钥（无现有发布签名体系可复用），但**首版先不做**，列入后续优化项。⚠️ 见 [§安全](#安全)：验签是热升级**真正启用前**的硬前置，未补上前 worker 自动升级不得开启。

## 背景与约束

- daemon 散落在用户各台机器上，无法强制升级 → 需要后台自动升级。
- PTY 是 daemon 进程的子进程，daemon 一退出会话就死（B3 决策）。要让会话跨"代码更换"存活，必须把**持有 PTY 的进程**与**会升级的逻辑**分开。
- 信任模型：单用户自有机器。但自动跑下载来的代码 = 潜在全网 RCE，**验签是热升级启用前的硬前置**（首版可暂缺，但在未补上前不得开启 worker 自动升级，详见 [§安全](#安全)）。

## 拓扑

```
        ┌─────────────────────────────────────────┐
        │ supervisor（Rust 静态二进制；极少升级）   │
        │  · 持有 PTY(portable-pty) 进程 + scrollback│  ← 升级 worker 时这些不动
        │  · 起/管/重启/升级 worker                 │
        │  · 下载新版 + 验签(ed25519) + 切换 + 回滚 │
        └───────────────▲───────────────────────────┘
          本地 UDS IPC   │  session.create/write/resize/kill/replay ↕ pty.output/started/exit
        ┌───────────────┴───────────────────────────┐
        │ worker（TS；频繁升级，承载大部分逻辑）     │
        │  · 连服务器(WS) + 认证 + git + fs + 协议   │
        │  · 会话编排                                │
        └───────────────▲───────────────────────────┘
                    WS   │  ↕  现有 daemon↔server 协议
                     中心服务器
```

**拆分边界（按现有 `apps/daemon/src/` 文件）**：`sessions.ts`(PTY+scrollback+背压) → supervisor（Rust 重写）；`index.ts` 的 WS/认证/重连/路由 + `creds.ts`/`git.ts`/`exec.ts`/`fs.ts` → worker。
**关键洞察**：拆完后**原生依赖 `node-pty` 完全留在 supervisor**，worker 退化为纯 JS（git 是 spawn、fs 是 node:fs、sqlite 在 server）。所以 worker 打包很容易，supervisor 作为 Rust 静态二进制也无原生模块折腾（连 `scripts/fix-pty-perms.mjs` 的 prebuild 执行位坑都消失）。

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

- 发布产物用私钥签名；**supervisor 内置公钥**，切换前验签 + sha256。**（首版延后，见下方 ⚠️）**
- 全程 TLS；升级下载通道与控制通道分离。
- 版本可固定 / 灰度。

> ⚠️ **签名延后的前置约束**：验签是"自动下载并运行远端代码"的安全闸门——缺它时，中心服务器一旦被攻破即可向全网 daemon 推任意代码（全网 RCE）。因此首版可以不实现验签，但 **worker 自动升级投递在验签补齐前不得启用**：拆分阶段 supervisor 只拉起本地已安装的 worker，不接 `worker.upgrade` 下载流程。补验签后再开启升级。

## 代价（取舍）

- PTY 字节多一跳本地 IPC（supervisor→worker→server），背压跨两段。
- 两级 resync、两套连接生命周期，复杂度上升。
- supervisor 偶尔也需升级（那次非热升级，但很罕见）。

## 软化点

跑的是 Agent（Claude Code/Codex），它们有 `--continue/--resume`、成果落工作区文件。即便会话重启，让 agent 自己 resume 往往够用 —— 若接受"自动升级 + 会话重启"，则**基线方案**（launcher + 验签 + re-exec，无 supervisor 拆分）就足够，复杂度低很多。方案 A 是"要会话零丢失"时的选择。

## 已定决策（2026-06 讨论确认）

1. **排序**：先收尾[二进制数据面](ROADMAP.md#1-二进制数据面)，再做 supervisor 拆分。UDS 字节流必须自己分帧，长度前缀二进制帧是 UDS 与 WS 共用的帧格式；先把它在 WS 这段做稳，拆分时不返工。
2. **打包**：
   - **supervisor = Rust 静态二进制**——一并解决"打包"难题：无 node 运行时依赖、无原生模块 prebuild（`portable-pty` 自带、`ed25519-dalek` 验签），`scripts/fix-pty-perms.mjs` 那类 prebuild 执行位坑直接消失。
   - **worker = TS**——拆分后原生依赖 `node-pty` 全留在 supervisor，worker 退化为纯 JS（git 走 spawn、fs 走 node:fs、sqlite 在 server），打包成可替换产物即可；保留共享 `@coflux/protocol` 类型与快速迭代。具体形态（`node --experimental-sea` / `bun build --compile` / 带 node tarball）实现时再定，不阻塞设计。
3. **签名**：方向是 **ed25519 + supervisor 内置公钥**（无现有体系可复用），但**首版延后**，列入后续优化项。**前置约束**：在验签补齐前，supervisor 不得自动下载并运行远端 worker 产物（即热升级特性整体不启用）；拆分阶段可先只跑本地已安装的 worker，不接升级投递。
