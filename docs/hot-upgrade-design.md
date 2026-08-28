# daemon 自动热升级设计（方案 A）

> 状态：已落地。daemon 是 `coflux-supervisor` + `coflux-worker` 两个 Rust 二进制，零 Node 运行时；
> worker 可自动下载、校验双 ed25519 签名、做持久 anti-rollback、观察期切换和崩溃回滚，升级时
> PTY/Agent 会话存活。
> supervisor 自身仍由 `cofluxd update` 人工升级；cofluxd 在安装前用同一发布根验证
> supervisor/worker，并持久拒绝远端降级。

## 1. 为什么拆两个进程

PTY 是持有它的进程的资源。若把网络、协议和 PTY 都放在一个频繁升级的进程里，更换代码就会杀死
正在运行的 shell/Agent。方案 A 把稳定 session authority 与频繁变化的 transport adapter 分开：

```text
┌──────────────────────────────────────────────────────────┐
│ coflux-supervisor（极少升级）                              │
│ · portable-pty + sessiond：PTY、VT/history、holder/seq     │
│ · UDS server                                              │
│ · spawn/监控 worker、版本注册表、观察期与回滚               │
│ · 下载 + 双签名验真 + SemVer anti-rollback                │
└──────────────────────▲───────────────────────────────────┘
                       │ 本地 UDS
                       │ control JSON + DeviceEnvelope frame
┌──────────────────────┴───────────────────────────────────┐
│ coflux-worker（频繁升级）                                  │
│ · 中心 WS、认证、重连、loopback gateway                    │
│ · direct/opaque relay、git/exec/fs、checkpoint             │
└──────────────────────▲───────────────────────────────────┘
                       │ /daemon protobuf WS
                    中心服务器
```

worker 崩溃、升级或与中心断线时，supervisor 继续读 PTY、推进 VT/history，并保留 sessiond 中的
logical holder/sequence；本地/relay channel transport 由新 worker 重建。transport 永远没有暂停全部
PTY 的裁决权。

## 2. UDS 与两级对账

UDS 是长度前缀 record stream：控制消息用 JSON，数据消息用首字节 frame kind 区分。当前 terminal
input/resize/output 全部在 DeviceEnvelope 内由 sessiond 裁决；旧 input/replay frame 编号 2/3 已保留但
拒绝解码。kind 1 只通知 worker 某 session 的 checkpoint 已脏，不携带 raw PTY。

worker 启动后分两级恢复：

1. 连接 supervisor，发送 `resync.request`，取得存活 `SessionInfo(sessionId, taskId, pid)`；
2. 建立/恢复中心连接，上报 daemon resync 与完整 Device catalog；
3. 重建 checkpoint dirty 集合、本地 gateway 和 relay channel；
4. client 以更高 transport generation reattach，logical holder 与未确认 input 可继续。

Session 缺席不直接等于 exit；sessiond tombstone/catalog 才是退出事实。中心也不会因为 worker/server 重启
杀死 unknown orphan。

## 3. 升级流程

1. release workflow 为四个平台构建 supervisor/worker，生成 schema 2 manifest，并用同一 ed25519
   私钥签原始 worker，以及 worker/supervisor 各自 domain-separated 的 release statement。statement
   精确绑定 `version`、Rust `target`、sha256 原始 32 字节和 artifact size；URL 只表示下载位置，不签入。
2. server 轮询 stable GitHub Release；daemon 握手或轮询发现版本落后时，下发
   `worker.upgrade {version,url,target,sha256,artifactSize,signature,releaseSignature}`。
3. worker 把升级请求经 UDS 交给 supervisor。
4. supervisor 要求规范严格 SemVer 与本机 target，并先按本地 `worker.release-floor` 拒绝降级/重放；
   再有界下载到 `COFLUX_HOME/workers/` 临时目标，核对已签名 size、sha256、legacy raw 签名与 release
   statement 签名。任一不符都删除/拒绝候选，保持当前 worker。
5. 验证通过后切换版本并启动观察期。新 worker 连接 UDS、完成两级对账，PTY 全程不动。
6. 观察期内连续崩溃达到阈值，supervisor 自动回退上一版；稳定通过后先持久 `worker.active`，再持久
   `worker.release-floor` 才提交。pending 不推进 floor；active→floor 之间崩溃时，重启从安全恢复的
   active SemVer 重建 floor。floor 持久失败则不提交并禁用新的远程升级。

同一坏版本的 server 推送还有 daemon/版本级退避上限，避免反复切换。

## 4. 安全边界

- ed25519 把“发布 daemon 二进制”的权限与中心、下载源分开：未持发布私钥者不能把任意字节冒充
  合法升级产物。它不是中心控制面的权限隔离；已控制中心的攻击者仍可编排系统现有的 exec/session
  能力，不能把这层验签表述成“中心失陷后无 RCE”。公钥编译进 supervisor 并随 cofluxd npm 包分发；
  发布私钥只在 protected environment secret 中。
- 测试可用 `COFLUX_WORKER_PUBKEY` 注入临时公钥，因为本地可信方已拥有机器权限；远端中心无法设置
  本机 env，不削弱生产威胁模型。
- legacy raw 签名保留给旧 supervisor；新 supervisor 还必须验证带 domain separation 的 release
  statement，防止把一份合法二进制重标成其它版本/架构/大小。新字段通过 protobuf unknown field 与
  serde 忽略未知字段实现“新 server/worker → 旧 supervisor”滚动兼容；raw-only 请求对新 supervisor
  fail closed。
- `worker.release-floor` 采用严格 SemVer precedence，等于 floor（包括仅 build metadata 不同）也按重放
  拒绝。它只约束远程发布请求；supervisor 内部仍可回滚到旧 active，本地已知版本切换也由管理员负责。
- sha256 用于 manifest/传输完整性，双签名用于产物及发布元数据的来源真实性，全部必须通过。
- 下载失败、hash 错、签名错、无法落盘或候选崩溃，都不能破坏当前 worker 和 PTY。
- supervisor 升级不热切换：它持有 authority，必须由 `cofluxd update` 明确重启，届时不承诺活 session
  保留。cofluxd 会先验证 supervisor/worker 的 component-separated statement，再从同一暂存代替换；
  `cofluxd.release-floor` 与 `worker.release-floor` 的较大者阻止下载源重放旧的合法 release。

## 5. 与本地优先数据面的关系

升级目标不是“让中心继续 replay PTY”。最终架构中：

- raw PTY 永不发送到中心；
- direct/relay 都承载相同 DeviceEnvelope，holder/sequence 在 sessiond；
- worker 重启导致 channel/generation 重建，client 自动重投未 ACK input；sessiond 去重保证 effect once；
- output 若产生 gap，client 重新 attach 取 sessiond snapshot；
- checkpoint 是可丢弃、按 session 合并的派生状态，不会反压 PTY。

因此“worker 可替换”和“中心不在本地 terminal 热路径”是同一 authority 切分的两个结果。

## 6. 验收

黑盒 harness 直接启动真实 server、supervisor、worker，并用临时 `COFLUX_HOME` 隔离：

- 杀 worker：PTY 存活，重启后 catalog/attach 恢复；
- 切到合法新版本：观察期提交，会话存活；
- 候选崩溃循环：自动回滚，会话存活；
- 合法签名：远程下载升级成功；
- sha256、size、version、target 或任一签名被篡改：必须拒绝且保持当前版本；
- 已提交版本在 supervisor 重启后仍拒绝降级与同 precedence 重放；
- worker 重启期间 direct/relay holder、input ACK 与 output snapshot 自愈不产生重复 effect。

发布与密钥操作见 [RELEASING.md](RELEASING.md)，最终 authority/transport 设计见
[architecture.md](architecture.md)。
