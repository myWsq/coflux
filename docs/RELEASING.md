# 发版流程

daemon = 两个 Rust 二进制：`coflux-supervisor`（装为系统服务）+ `coflux-worker`（热升级对象）。
发版 = 交叉编译 → 分域签名 supervisor/worker → 发 GitHub Release（含 `manifest.json`，server 据此下发 worker 升级，cofluxd 据此验安装包）。

## 一次性设置（签名密钥）

daemon 产物用 ed25519 发布私钥签名。worker 同时保留原始二进制签名（供旧 supervisor
滚动兼容）和 domain-separated release statement；supervisor 使用自己的 statement domain。
两类 statement 都绑定版本、Rust target、sha256 与产物大小，component 由独立 domain 隔离。
supervisor 热升级验 worker，npm 包内的 cofluxd 则用同一公钥验 supervisor + worker 后再安装。
这样发布权限与中心/下载源权限分开，未持发布私钥者既不能替换产物，也不能把合法产物改名成另一个
component、版本或架构。注意这不是中心控制面的沙箱：中心已有 exec/session 编排能力。

```sh
node scripts/gen-keypair.mjs
```

输出两段：

1. **私钥（PKCS8 PEM）** → 设为 `release-signing` environment secret
   `WORKER_SIGNING_KEY`。**私钥绝不进仓库。**
2. **公钥（hex）** → 同时覆盖 `crates/supervisor/release-pubkey.hex` 与
   `packages/cli/release-pubkey.hex`（公钥非密，提交进仓库；CI 检查两份一致）。

> 在换入真公钥前，`release-pubkey.hex` 是全 0（无效点）→ supervisor **默认拒绝一切下载升级**（安全默认）。
> supervisor 也支持 env `COFLUX_WORKER_PUBKEY` 覆盖（测试 / 自带密钥部署用）。

提交公钥改动后，所有新构建的 supervisor 与新发布的 cofluxd 都内置了你的发布公钥。

## 一次性设置（macOS 签名 + 公证）

cargo 交叉/原生编译产物只有 ad-hoc 签名（无 Team ID、未公证）。macOS（Sequoia 起）对新下载的
顶层可执行文件（launchd 直接 spawn，`cofluxd update` 换的 supervisor 二进制正是这条路径）会判
`OS_REASON_CODESIGNING` 静默 SIGKILL——`launchctl print gui/$(id -u)/com.coflux.daemon` 的
`last exit reason` 能看到（2026-07-20 实测踩坑）。用真 Developer ID 证书签名 + 苹果公证从根上
解决发布资产的系统身份；cofluxd 仍会先做 ed25519 验真，再按实测需要在本机 ad-hoc 重签，用户无需
手动处理。

需要 Apple Developer Program 账号（付费）。一次性生成：

1. **Developer ID Application 证书**（不是 Apple Development / Apple Distribution，那两种是给
   App Store 用的）：Xcode 或 Apple Developer 后台生成，导出 `.p12`（带密码）。
2. **App Store Connect API Key**（Developer 权限即可，用于 `notarytool` 免交互认证）：
   App Store Connect → Users and Access → Integrations → 生成，下载 `.p8`，记 Key ID + Issuer ID。

6 个 `release-signing` environment secret：

| Secret | 内容 |
| --- | --- |
| `MACOS_CERT_P12` | `.p12` 的 base64（`base64 -i cert.p12`，不要额外加换行） |
| `MACOS_CERT_PASSWORD` | 导出 `.p12` 时设的密码 |
| `APPLE_TEAM_ID` | Team ID（本项目：`8Y2J55823C`） |
| `NOTARY_API_KEY_P8` | `.p8` 文件原文（含首尾 `-----BEGIN/END PRIVATE KEY-----`） |
| `NOTARY_KEY_ID` | API Key ID |
| `NOTARY_ISSUER_ID` | Issuer ID |

签名身份字符串（`release.yml` 里硬编码，非密）：`Developer ID Application: Shuaiqi Wang (8Y2J55823C)`。

> **裸二进制不支持 stapling**（只有 .app/.pkg/.dmg 能钉公证票据）。所以只签名+提交公证，不 staple——
> Gatekeeper 首次执行时联网向苹果查公证记录，daemon 本来就要联网连 server，可接受；机器完全离线
> 时首次执行公证校验可能失败或变慢，这是裸二进制公证的固有限制。
>
> `KEYCHAIN_PASSWORD` 不需要存成 secret：CI 每次跑时用 `openssl rand` 现生成一个，只在当次
> runner 生命周期内有效，无需持久化。
>
> Developer ID 证书通常 5 年有效期，到期需要重新生成 `.p12` 并更新 `MACOS_CERT_P12`/`MACOS_CERT_PASSWORD`。

## 一次性设置（GitHub/npm 发布保护，必需）

以下是 GitHub/npm 外部状态，不能靠仓库内 YAML 自动创建。workflow 里的 tag/SHA、main-tip
校验只是防误操作门，**不是权限边界**；真正的发布授权由 ruleset、protected
environment 和 npm Trusted Publisher 共同承担。上线前逐项完成：

- [ ] 在 GitHub Rulesets 为 `v*` 建立两套 tag ruleset：一套限制 **create**，只把发布维护者列入
  bypass；另一套限制 **update/delete**，发布维护者不在 bypass，只有最小 break-glass 管理员集
  可绕过并需定期审计。bypass 对整套 ruleset 生效，不能用同一套规则同时表达这两种权限。
- [x] 创建 protected environments `release-signing` 与 `npm-publish`，配置最小 deployment branch/tag
  规则：`release-signing` 只放行 `v*`；`npm-publish` 需考虑下游 `workflow_run` 的 ref 是 `main`，手动补发
  也只允许 `main`。**不配 required reviewers**（2026-09-05 决定：单人维护，人工审批只是每次发版多点一下网页，
  签出产物的前提仍是「有权创建 `v*` tag 的人推了 tag」，由下面的 tag ruleset 把守）。
- [ ] 把 `WORKER_SIGNING_KEY`、`MACOS_CERT_P12`、`MACOS_CERT_PASSWORD`、`APPLE_TEAM_ID`、
  `NOTARY_API_KEY_P8`、`NOTARY_KEY_ID`、`NOTARY_ISSUER_ID` 从 repository secrets 迁到
  `release-signing` environment secrets。
- [ ] 在 npm 的 `cofluxd` Trusted Publisher 中绑定本仓库、`.github/workflows/npm-publish.yml`
  和 environment 名 `npm-publish`；名字必须与 workflow job 的 `environment` 完全一致。
- [ ] 撤销 npm legacy/automation/granular publish token，删除 `NPM_TOKEN` 类 GitHub secret 与
  `.npmrc` 里的 `_authToken`；自动发布只保留 GitHub OIDC Trusted Publishing。
- [ ] 若仓库已提供 Immutable Releases，启用它，并收紧可管理 Release 的 write/admin 角色；
  它是防资产事后替换的纵深防御，不能替代客户端的 ed25519 校验。

> **迁移顺序不能颠倒**：workflow 的持密 job 已绑定上述 environment，但 YAML 不能替你建立
> reviewer/ref policy。先在后台创建并保护 environment，再复制 secrets、验证 release/OIDC，最后才删
> repository secrets 和旧 token。若 environment 尚未正确配置，不得推 release tag 或手动补发 npm；
> 仅出现同名 environment 不能证明 required reviewer/ref policy 已生效。

## 发一个版本

发版前 checklist：

1. 本地必须在 `main` 且 `HEAD == origin/main`；release metadata 会 fresh-fetch 再做同样的硬门。
   这只防在旧/分叉 commit 上误打新 tag，不替代上面的 `v*` ruleset。
2. **main 的 CI 必须是绿的**（ci.yml 是质量门，黑盒测试依赖其内置的 Postgres service）。
3. `packages/cli` 若有改动，**提前 bump `package.json` 版本**——打 tag 时 `npm-publish.yml`
   会自动把它发到 npm（Trusted Publishing/OIDC，无 token；版本已存在则幂等跳过）。
   CLI 单独出修复时可在 Actions 页手动 dispatch 该 workflow。
4. 确认没有正在运行或 pending 的 `release` / `npm-publish`；每次只推一个 tag，
   等 GitHub Release 和下游 npm workflow 都结束后再发下一个。

```sh
git fetch --prune origin
test "$(git branch --show-current)" = main
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
git tag v1.2.3
git push origin refs/tags/v1.2.3
```

**禁止** `git push --tags`、一条命令推多个 tag，或在上一次发布未结束时继续推 tag。
GitHub concurrency 在此只有 one-running/one-pending；第三个 burst run 会取代旧 pending，
即 latest-pending-wins，不是 FIFO 队列，被取代的中间版本不会自动补发。

`v*` tag 触发 `.github/workflows/release.yml`：

1. **矩阵交叉编译** supervisor + worker：`x86_64`/`aarch64` 的 linux-musl（静态，`cross`）+ macOS（`aarch64`/`x86_64`，原生）；linux 矩阵额外产出独立 relay（`coflux-relay`，plan 043，服务器节点部署用，macOS 不产）。
2. **签名 + 清单**（`scripts/release-sign.mjs`，用 `WORKER_SIGNING_KEY`）：签名 job 只有
   `contents:read`，与最终持 `contents:write` 的 GitHub Release job 分离。每个
   `coflux-worker-<target>` 生成 legacy raw-binary 签名和 worker release statement 签名；每个
   `coflux-supervisor-<target>` 生成 supervisor release statement 签名。worker 的精确 transcript 是
   `"coflux-worker-release-v1\0" || BE32(len(version)) || version || BE32(len(target)) || target || sha256(raw 32B) || size(BE64)`；
   supervisor 只把 domain 换成 `"coflux-supervisor-release-v1\0"`，其余字段相同；`version`/`target`
   按 UTF-8 编码。下载 URL 不属于发布身份，只是可替换的下载位置，因此不签入。relay 产物不签名
   （人工 ssh 部署、不走自动下载验签），只进 `SHA256SUMS` 供部署校验。
3. **生成 release note**（`scripts/release-notes.mjs`）：取上一个 `v*` tag 到本 tag 的 commit，按
   type 分组（新功能 / 修复 / 重构与内部改动 / 其他），剥掉冗余的 type 前缀、scope 加粗，剔除
   `chore(0xx)`/`plan(0xx)` 这类计划文档流转，末尾附 daemon 与 cofluxd CLI 的升级须知（CLI 版本
   没变就不印那句指令）。**不用 GitHub 的 `generate_release_notes`**——它只汇总 PR，而本仓库直接
   push main，产出永远是光秃秃一行 compare 链接。这也意味着 **commit message 就是 changelog**：
   写清楚 scope 和一句人话结论，发版时零加工直接见人。生成器自带 `--self-check`，挂在 ci.yml。
4. **发布 Release**，资产含：
   - `coflux-worker-<target>`（原始二进制，下载+验签对象）+ `.sig`（legacy raw）+
     `.release.sig`（release statement）
   - `coflux-supervisor-<target>` + `.release.sig`（cofluxd 安装前验签）
   - `coflux-relay-<linux-target>`（独立 relay 节点部署用；节点形态与升级流程见 [deployment.md](deployment.md)）
   - `coflux-<tag>-<target>.tar.gz`（含 supervisor+worker，人工安装用）
   - `manifest.json` schema 2（顶层 `version`；`worker`/`supervisor` 各 target 的
     `url`/`target`/`sha256`/`size`/`releaseSignature`，worker 另有 legacy `signature`）+
     `SHA256SUMS`

> **P2 / TODO（npm 旧 run 幂等 vs. fail closed）**：`npm-publish-guard.mjs` 目前会先严格校验
> registry `dist-tags.latest` 及其对应 versions，再判断待发版本是否已存在。因此 latest
> 缺失/损坏时，即使旧 run 的精确版本已在 npm 上也会失败，而不是幂等跳过。这是有意的
> fail closed：当前 guard 没有可靠的“这只是旧 release 重放”上下文，草率把 exact-existing
> 提到 latest 校验之前，会让新 CLI release 在 registry 状态异常时静默成功。遇到此情况先
> 人工诊断/修复 npm latest；只有在引入可验证的 rerun context 与对应反例测试后才放宽。

`ci.yml`（push/PR 到 main）是质量门：类型检查/前端构建 + Rust 测试与构建（`-D warnings`）+
全量真实进程黑盒 + Swift/iOS 构建门。

## 升级是怎么落地的

1. server 轮询 GitHub `/releases/latest`（天然排除 prerelease/draft）及该 release 的 schema 2
   `manifest.json`；只有 release tag、manifest 顶层版本和每个 target 条目的形状全部一致才缓存。
2. 每台在线 daemon 握手时（上报 `workerVersion`/`platform`/`arch`）立即比对一次；轮询到新 release
   后再对全部在线 daemon 扫一遍。server 仍只做“不等即推”，下发
   `worker.upgrade{version,url,target,sha256,artifactSize,signature,releaseSignature}`；真正的版本单调性由
   每台 supervisor 的本地持久状态裁决。
3. 新 supervisor 先要求带 `v` 的规范严格 SemVer、匹配本机的 Rust target，并在网络请求前拒绝低于或
   等于已提交 floor 的降级/重放。随后有界下载，核对已签名 size、sha256、legacy raw 签名与 release
   statement 签名，全部通过才原子落入 `~/.coflux/workers/<version>/`。任一校验失败都保持当前 worker。
4. 候选接管 UDS、连回中心并完成 resync 后，观察期才算健康。提交顺序是先原子持久
   `worker.active`，再原子持久 `worker.release-floor`；floor 写失败时不宣告提交，并在本进程内禁用新的
   远程升级。若恰好在两者之间崩溃，重启会从已安全恢复的 active SemVer 重建并持久化 floor。
5. `worker.release-floor` 是已提交远程发布的单调高水位，只在观察期 commit 后推进；仅下载、验签、落盘
   或 pending 失败都不会推进。SemVer build metadata 不参与 precedence，因此同 precedence 的另一 build
   字符串也按 replay 拒绝。候选失败时 supervisor 仍可内部回滚到旧 active；floor 限制的是之后的**远程
   请求**，不是禁止安全回滚或本地管理员切换。
6. worker 换版本时 PTY 会话在 supervisor 不受影响。失败后 worker 重连并重新上报旧版本；server 按
   `(daemonId, version)` 累计推送次数，达到 `COFLUX_AUTOUPDATE_MAX_ATTEMPTS` 后在本次 server 生命周期
   内永久停止该版本，避免“回滚→再推→再失败”无限循环（见 `tests/src/auto-update.test.mjs`）。

未设 `COFLUX_AUTOUPDATE_REPO` 时该特性整体关闭。手动 `clientUpgradeDaemon` 仍是灰度/紧急兜底，
但给新 supervisor 下发远程 URL 时也必须提供完整的新字段；只有 `url` 为空的本地已知版本切换不走该
信任链。为滚动兼容，manifest 继续保留 legacy raw 签名，protobuf/UDS 的新增字段可被旧
worker/supervisor 忽略；反向组合里，新 supervisor 收到只有 raw 签名的远程请求会 fail closed。
相关 env（均在 `apps/server/src/config.ts`）：`COFLUX_AUTOUPDATE_API_BASE`（默认
`https://api.github.com`）、`COFLUX_AUTOUPDATE_REPO`（`owner/repo`）、`COFLUX_AUTOUPDATE_POLL_MS`
（默认 10 分钟）、`COFLUX_AUTOUPDATE_MAX_ATTEMPTS`（默认 3）。supervisor 版本随 web 设备 tooltip
一并可见，但**不**自动升级（见下）。

## 中心机器的前置要求：时钟必须同步

online lease 的 `expiresAt` 由 **中心** 时钟算（`now + config.localLeaseTtlMs`，默认 45s），由
**daemon** 时钟校验（`crates/worker/src/local_auth.rs` `validate_lease`），两端没有 skew 容差。
中心时钟慢于 daemon 超过 45s，每条 lease 到达即过期，daemon 日志刷 `local lease 安装被拒: lease 已过期`，
direct 路径的 rpc/lifecycle scope 全废（offline grant 覆盖的 session read/control 仍可用，所以
`cofluxd doctor` 依然报绿——不要用它排除这个故障）。

2026-07-25 在 prod-jp 上实际踩到：`timedatectl` 显示 `System clock synchronized: no`、
NTP service `n/a`，系统时钟比 RTC 和真实时间慢 78s。修法：

```sh
apt-get install -y systemd-timesyncd && timedatectl set-ntp true
timedatectl   # 确认 System clock synchronized: yes
```

新中心机器上线时先查这一项。

## cofluxd 首次安装 / 升级 supervisor 自身

supervisor 不走热升级（它持有 PTY）。用 `cofluxd update` 重下 supervisor 与随包 worker 并重启服务——
很罕见。cofluxd npm 包内置与 supervisor 相同的 ed25519 公钥；远端安装必须先取得精确 SemVer tag 的
schema 2 manifest，严格匹配 version/target/size/sha256，并分别验证 worker/supervisor 的 release
statement（worker 还验证 legacy raw 签名）。两个文件都通过后才从同一暂存代替换；macOS 的本地
ad-hoc 重签也只能发生在验签之后。旧 release 若没有 supervisor 条目会 fail closed，不回退到裸下载。
`--bin-dir` 是本机管理员显式选择的本地产物路径，保留为不走远端信任链的开发/救援入口。
这条远端安装信任链从 `cofluxd@0.12.0` 起生效；0.11.x 及更早版本必须先升级 CLI。

新 supervisor 启动后仍会用其 bundled worker 的严格 SemVer 与已有 `worker.release-floor` 的较大者作为
远程 anti-rollback 起点。当前两处内置公钥必须一致，CI 自检会阻止漂移。**不能直接轮换信任根**：
旧 cofluxd/supervisor 不会接受只由新 key 签的 release；真要轮换，必须先设计并发布由旧 key 认证的
双信任/交接版本，再切换签名 key，不能只改两个 hex 文件。

> **发版后别忘了这步**：热升级只覆盖 worker。若本次发版含 supervisor 侧修复（看
> `git diff <上个tag>..HEAD -- crates/supervisor`），需在各 daemon 机器跑一次
> `cofluxd update`，否则修复永远不会到达生产的 supervisor。
