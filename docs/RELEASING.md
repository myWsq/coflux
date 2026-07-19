# 发版流程

daemon = 两个 Rust 二进制：`coflux-supervisor`（装为系统服务）+ `coflux-worker`（**热升级下载 + ed25519 验签的对象**）。
发版 = 交叉编译 → 签名 worker → 发 GitHub Release（含 `manifest.json`，server 据此下发升级）。

## 一次性设置（签名密钥）

worker 产物用 ed25519 私钥签名，supervisor 用内置公钥验签——防"中心服务器被攻破→推恶意产物"。

```sh
node scripts/gen-keypair.mjs
```

输出两段：

1. **私钥（PKCS8 PEM）** → 设为仓库 GitHub secret `WORKER_SIGNING_KEY`（Settings → Secrets → Actions）。**私钥绝不进仓库。**
2. **公钥（hex）** → 覆盖 `crates/supervisor/release-pubkey.hex` 的内容（公钥非密，提交进仓库）。

> 在换入真公钥前，`release-pubkey.hex` 是全 0（无效点）→ supervisor **默认拒绝一切下载升级**（安全默认）。
> supervisor 也支持 env `COFLUX_WORKER_PUBKEY` 覆盖（测试 / 自带密钥部署用）。

提交公钥改动后，所有新构建的 supervisor 就内置了你的发布公钥。

## 发一个版本

发版前 checklist：

1. **main 的 CI 必须是绿的**（ci.yml 是质量门，黑盒测试依赖其内置的 Postgres service）。
2. `packages/cli` 若有改动，**提前 bump `package.json` 版本**——打 tag 时 `npm-publish.yml`
   会自动把它发到 npm（Trusted Publishing/OIDC，无 token；版本已存在则幂等跳过）。
   CLI 单独出修复时可在 Actions 页手动 dispatch 该 workflow。

```sh
git tag v1.2.3
git push origin v1.2.3
```

`v*` tag 触发 `.github/workflows/release.yml`：

1. **矩阵交叉编译** supervisor + worker：`x86_64`/`aarch64` 的 linux-musl（静态，`cross`）+ macOS（`aarch64`/`x86_64`，原生）。
2. **签名 + 清单**（`scripts/release-sign.mjs`，用 `WORKER_SIGNING_KEY`）：对每个 `coflux-worker-<target>` 产物算 sha256 + ed25519 签名。
3. **发布 Release**，资产含：
   - `coflux-worker-<target>`（原始二进制，下载+验签对象）+ `.sig`
   - `coflux-<tag>-<target>.tar.gz`（含两个二进制，人工安装用）
   - `manifest.json`（每个 target 的 `url`/`sha256`/`signature`）+ `SHA256SUMS`

`ci.yml`（push/PR 到 main）是质量门：类型检查 + `cargo test` + `cargo build`（`-D warnings`）+ 黑盒 20 项。

## 升级是怎么落地的

1. server 轮询 GitHub `/releases/latest`（天然排除 prerelease/draft）+ 该 release 的 `manifest.json`，缓存最新版本号与每 target 的 `url`/`sha256`/`signature`。
2. 每台在线 daemon 握手时（上报 `workerVersion`/`platform`/`arch`）立即比对一次；轮询到新 release 后再对全部在线 daemon 扫一遍：版本不等（且非空）、按 platform+arch 映射到 manifest 里的 target，就下发 `worker.upgrade{version,url,sha256,signature}`——不做 semver 比较，不等即推。
3. supervisor 下载 → 校 sha256 → 验签（内置公钥）→ 落 `~/.coflux/workers/<version>/` → 观察期切换；**验签不过则拒绝、保持当前版本**（见 `tests/src/signed-upgrade.test.mjs`）。
4. worker 换版本，PTY 会话在 supervisor 不受影响（热升级）。
5. 升级失败会导致 supervisor 回滚、worker 重连并重新上报旧版本；server 按 `(daemonId, version)` 记推送次数做退避（`COFLUX_AUTOUPDATE_MAX_ATTEMPTS`/`COFLUX_AUTOUPDATE_COOLDOWN_MS`），避免"回滚→再推→再失败"无限循环（见 `tests/src/auto-update.test.mjs`）。

未设 `COFLUX_AUTOUPDATE_REPO` 时该特性整体关闭，行为与现状完全一致；手动触发（`client.upgradeDaemon`）不受影响，仍是灰度/紧急场景的兜底手段。相关 env（均在 `apps/server/src/config.ts`）：`COFLUX_AUTOUPDATE_API_BASE`（默认 `https://api.github.com`）、`COFLUX_AUTOUPDATE_REPO`（`owner/repo`）、`COFLUX_AUTOUPDATE_POLL_MS`（默认 10 分钟）、`COFLUX_AUTOUPDATE_MAX_ATTEMPTS`（默认 3）、`COFLUX_AUTOUPDATE_COOLDOWN_MS`（默认 1 小时）。supervisor 版本随 web 设备 tooltip 一并可见，但**不**自动升级（见下）。

## 升级 supervisor 自身

supervisor 不走热升级（它持有 PTY）。用 `cofluxd update` 重下二进制并重启服务——很罕见。

> **发版后别忘了这步**：热升级只覆盖 worker。若本次发版含 supervisor 侧修复（看
> `git diff <上个tag>..HEAD -- crates/supervisor`），需在各 daemon 机器跑一次
> `cofluxd update`，否则修复永远不会到达生产的 supervisor。
