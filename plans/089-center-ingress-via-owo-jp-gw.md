# Plan 089: 中心访问链路去 CF 橙云——owo-jp-gw 灰云入口反代

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `plans/README.md`.
>
> Drift check: `git diff --stat df2286a..HEAD -- crates/relay/src/main.rs crates/worker/src/main.rs packages/cli/cofluxd.mjs apps/ios/Coflux/Client/Config.swift plans/README.md`

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: none
- Category: migration
- Execution: self
- Planned at: `df2286a`, 2026-09-04

## Requirement

用户报"中心服务太卡了"。根因已实测量化：`api/app/m/*.coflux.dev` 全挂在 Cloudflare
橙云上，CF 免费版无中国节点，国内请求先出境到 CF 边缘、再回源日本 prod-jp，而
prod-jp 的 `82.40.34.55` 本身还是 [[gfw-blocked-home-line]] 记录过的受干扰 IP。实测
从国内（prod-bj）打 `https://app.coflux.dev/` **TTFB 1.598s**、`api` **1.637s**；同
机测 `relay-bj`（国内直连）只要 **0.034s**。

完成后应满足：

1. `api.coflux.dev` / `app.coflux.dev` / `m.coflux.dev` / `coflux.dev` 四个域名从国内
   解析到 `45.94.40.233`（owo-jp-gw）并直连（灰云），由该机 Caddy 反代回 prod-jp
   `82.40.34.55`（同机房，实测 RTT 1.4ms）。
2. 中心服务本体零改动：`/opt/coflux` 代码、PG17、`coflux-server` systemd、
   `/etc/coflux/server.env` 全部不动，`git` 不产生任何源码 diff。
3. 客户端零改动：18 台已 enroll 设备的 `~/.coflux/settings.json` 与 iOS 均不需要改，
   因为域名不变。
4. 国内实测 TTFB 相对 1.6s 基线有可观测的下降，且 daemon 全部回连、WS 升级正常。
5. owo-jp-gw 上既有 9 个站点与 prod-jp 上的预览域 `*.coflux.dev` 不受损。

**相邻错误解**（都算失败）：

- 把中心迁到 prod-bj（用户在 departure check 明确否决，理由是不想让未备案的
  coflux.dev 裸跑在腾讯云 IP 上）。
- 修改 `*.coflux.dev` 泛记录或让它指向 owo-jp-gw——预览域必须继续留在橙云走 prod-jp。
- 为了拿 `stream_close_delay` 或 DNS-01 泛证书而升级 owo-jp-gw 的 Caddy 二进制。
- 改 `packages/cli/cofluxd.mjs` / `apps/ios/.../Config.swift` 里的域名——域名不变正是
  本方案的核心红利。
- 在 owo-jp-gw 上放一份 web/mobile 静态副本充当真 CDN（引入部署同步负担，收益仅 1.4ms）。

## Decisions & tradeoffs

- **入口节点选 owo-jp-gw (`45.94.40.233`)，中心留在 prod-jp**。Rejected: 中心迁
  prod-bj（国内直连 3.6ms，最快）——用户明确不接受未备案域名跑在大陆云 IP 上，且需
  搬 PG、装 PGDG 源、承担 18 台设备的迁移风险。Rejected: 中心搬到 owo-jp-gw 本机——该
  机仅 2 核、已压 9 站 + relay + docker，而省下的那一跳只值 1.4ms。Based on: 实测
  owo-jp-gw → `82.40.34.55` `conn=0.0015s` / ping `avg 1.399ms`。

- **新建 `api`/`app`/`m` 三条独立灰云 A 记录，而不是"改四条记录"**。这三个域名当前
  **没有独立 DNS 记录**，全靠泛记录 `*.coflux.dev A 82.40.34.55 proxied=True` 覆盖；
  CF 中独立记录优先于泛记录，因此新建即生效。裸域 `coflux.dev` 有独立记录，改其
  `content` 与 `proxied`。Rejected: 直接把泛记录改成灰云指 `.233`——会连带把预览域
  `{shortId}-p.coflux.dev` 一起拽走，而 owo 上没有泛证书能力（见下条），预览域立刻全废。
  Based on: CF API 列出的 coflux.dev zone 记录只有 `*.coflux.dev` / `coflux.dev` /
  `www.coflux.dev` / `relay.coflux.dev` / `relay-jp.coflux.dev` 五条 A 记录。
  **副作用（有利）**：泛记录全程不动，回滚只需删掉新建的三条，泛记录自动接管。

- **回源必须走 HTTPS**：`reverse_proxy https://82.40.34.55` + `header_up Host {host}`
  + `transport http { tls_insecure_skip_verify }`。daemon 与 client 的认证 token 走这
  条链路，同机房也不接受明文。`tls_insecure_skip_verify` 是必需的，因为对端证书将变成
  Caddy 自签（见下条）。Rejected: 反代到 `http://82.40.34.55`（明文承载 token）。
  Rejected: 直连 `82.40.34.55:8787`——该端口只绑 `127.0.0.1`，且 `app`/`m` 的静态 SPA
  由 prod-jp 的 Caddy `file_server` 提供、根本不在 8787 上。Based on:
  `ss -ltnp` 显示 `127.0.0.1:8787`；prod-jp `/etc/caddy/Caddyfile:60-94` 的 app 站是
  `root * /opt/coflux/apps/web/dist` + `file_server`。

- **prod-jp 上 `coflux.dev`/`api`/`app`/`m` 四站改用 `tls internal`（Caddy 内部 CA 自签）**。
  转灰云后这四个域名的 ACME HTTP-01 挑战会落到 `.233`，prod-jp 上的续期必然持续失败并
  刷错日志。改自签 + 上游 `tls_insecure_skip_verify` 闭环。**`*.coflux.dev` 预览域必须
  保持原样走 DNS-01（`tls { dns cloudflare {env.CF_API_TOKEN} }`），一个字都不要动**。
  Rejected: 保留这四站的公网 ACME 并让 owo 把 `/.well-known/acme-challenge/*` 回代给
  prod-jp——为一个不再需要公网证书的后端引入一条长期存在的特例路径。Based on:
  prod-jp `/etc/caddy/Caddyfile:48,53,60,95` 四站现无显式 tls 指令（走默认 ACME），
  `:116` 的 `*.coflux.dev` 显式用 cloudflare DNS-01。

- **owo-jp-gw 上四站走 HTTP-01，且严禁改动 Caddy 二进制**。灰云后 ACME 挑战直达
  `.233`，无需 DNS 插件。该机 Caddy **2.6.2** 压着 9 个现有站点（`zakki.owodns.com` /
  `cdn77.owodns.com` / `cchost.cc` / `relay.coflux.dev, relay-jp.coflux.dev` /
  `open.owo.nz` / `suon.owo.nz` / `cdn.cchost.cc` / `pir.bannin.app` /
  `gateway.bannin.app`），`caddy add-package` 或版本升级都会替换二进制并令这 9 站一起
  重启。Rejected: 升级到 2.11 + cloudflare 插件以换取 `stream_close_delay` 和泛证书
  ——用户在 departure check 明确选择不升级。

- **owo 的四站配置不得包含 `stream_close_delay`**。Caddy 2.6.2 不认这个子指令（实测
  `caddy validate` 报 `unrecognized subdirective stream_close_delay`），照搬 prod-jp
  的配置会让 validate 直接失败。**接受的代价**：owo 每次 `systemctl reload caddy` 会
  掐断 coflux 的 WS 长连接，daemon/web 自动重连。

- **owo 上新增的四站可以开 `access_log`；`relay.coflux.dev` 站点的禁令继续有效**。已核实
  daemon 走 `connect_async(&cfg.server_url)` 直连、token 在 WS 建立后由 protobuf 消息
  承载，URL 里没有凭据；而 relay 的 token 确实在 query string。Based on:
  `crates/worker/src/main.rs:1092`（`connect_async(&cfg.server_url)`，URL 由
  `:474` 的 `server_url` 原样传入）对比 `crates/relay/src/main.rs:248-250`（`.query()`
  取 token）。

- **(decided while planning) 先用 `m.coflux.dev` 单域试切，验证通过后再切 api/app/裸域**。
  存在一个无法回避的 ACME 时序死锁：owo 上的 HTTP-01 挑战只有在该域名已经解析到 `.233`
  之后才能完成，因此**证书无法在切换前预签**，切 DNS 到证书签发完成之间必然有一个
  HTTPS 不可用窗口（每域约数十秒）。`m.coflux.dev` 服务的是已冻结的 mobile 端
  （见 [[mobile-companion]]），中断无人受影响，是天然的小白鼠：用它把"新建灰云记录 →
  owo 签发 → 反代回源 → 200/101"整条链路跑通，再切两个关键域。Rejected: 从 prod-jp
  复制现有 PEM 到 owo 用 `tls <cert> <key>` 显式指定以消除窗口——引入一份 90 天后过期
  且与自动续期冲突的手工证书，为省数十秒中断埋长期隐患。Rejected: 四域一次性切——
  把唯一一次学习机会押在关键域上。

## Direction

四台角色：**CF DNS**（记录切换）、**owo-jp-gw**（新入口，追加站点）、**prod-jp**
（后端，四站改自签）、**prod-bj**（纯观测点，国内视角实测，不做任何变更）。

顺序上先让 prod-jp 具备"被回源"的能力，再切 DNS，最后验收——反过来做会在切换后撞上
后端证书问题。

### Milestone 1: prod-jp 四站转为只接回源

`coflux.dev` / `api` / `app` / `m` 四站改用 `tls internal`，`*.coflux.dev` 预览域与
文件内其余站点（`dash.cchost.cc`、`cchost.ai`、`pa.wsq.cool` 等）零改动。此时线上仍走
橙云，行为不应有可观测变化（CF 到源站的 SSL 模式若为 Full 非 strict，自签可被接受；
若切换后出现 525，见 STOP conditions）。

Validation:
`ssh root@prod-jp 'caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile'` → exit 0，
且 reload 后 `curl -sS -o /dev/null -w "%{http_code}" https://app.coflux.dev/` 仍为 200。

### Milestone 2: owo-jp-gw 追加四站（配置就位，暂不生效）

在 `/etc/caddy/Caddyfile` 尾部追加 `coflux.dev` / `api` / `app` / `m` 四站，全部反代
`https://82.40.34.55` 并透传 `Host`。裸域保持与 prod-jp 一致的 301 → app 语义。此时
四域仍解析到 CF，新站点拿不到流量也签不到证书，属预期。

Validation: `ssh owo-jp-gw 'caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile'`
→ exit 0（这一步同时证明配置里没有 2.6.2 不认的指令）。reload 后既有 9 站全部存活。

### Milestone 3: 单域试切 m.coflux.dev

新建 `m.coflux.dev` A → `45.94.40.233`、`proxied=false`，等待 owo 完成 HTTP-01 签发。

Validation: `curl -sS -o /dev/null -w "%{http_code}" https://m.coflux.dev/` → 200，
且从国内测得 TTFB 明显低于 1.6s 基线。失败则删除该记录回滚（泛记录接管），并按 STOP
条件停下。

### Milestone 4: 切 api / app / 裸域

新建 `api`、`app` 两条灰云 A 记录 → `.233`；裸域 `coflux.dev` 改 `content` 为 `.233`
且 `proxied=false`。`*.coflux.dev` 与 `www.coflux.dev` 不动。

Validation: 四域全部 200/301；WS 升级返回 101；daemon 在中心日志里回连。

### Milestone 5: 验收与观测

国内视角 TTFB 对比、既有站点无损、daemon 全数回连、Caddy 日志无证书错误。结论写回本
plan 与 `plans/README.md`；若 TTFB 收益不达预期，如实记录数字并交由用户决定是否回滚
（回滚预案见 Maintenance notes）。

## Landmines

- **`api`/`app`/`m` 没有独立 DNS 记录**，全靠 `*.coflux.dev A 82.40.34.55 proxied=True`
  覆盖。误改泛记录会把预览域一起拽走。
- **ACME 时序死锁**：owo 上的 HTTP-01 必须在 DNS 已指向 `.233` 之后才能完成，证书无法
  预签，切换必然带一个数十秒的 HTTPS 窗口。这正是 Milestone 3 存在的理由。
- **owo-jp-gw 有三个 IP 绑在同一网卡**：`45.94.40.29`（主）、`45.94.40.233`（**本次要
  用的**，ssh 别名与 relay 域名现用）、`45.94.40.123`（旧，且 `ifconfig.me` 显示出方向
  默认仍走它）。记忆 [[relay-nodes]] 里"jp 节点 IP = 45.94.40.123"已过期。
- **`coflux.dev` 裸域必须持有证书**，否则回源 SNI 握手报 525——prod-jp
  `/etc/caddy/Caddyfile:45-47` 的注释记着这个坑（同 `origin.cchost.cc` 2026-08-10）。
  该 block 存在的唯一意义就是持证书，不要因为"只是个 301"而省掉它。
- **Caddy 2.6.2 不支持 `stream_close_delay`**，prod-jp 四站配置里的该指令不能照搬。
- **GRE 隧道 `10.0.0.2 ↔ 10.0.0.1` 不通向 prod-jp**（prod-jp 只有 `127.0.0.1` 与
  `82.40.34.55`），回源只能走公网。
- **`relay.coflux.dev, relay-jp.coflux.dev` 站点严禁 `access_log`**（token 在 query），
  改同一个 Caddyfile 时不要顺手给它加上。
- **验证 WS 必须强制 HTTP/1.1**，h2 下 WS 升级不成立会误报 404。
- `www.coflux.dev` 当前橙云指 prod-jp 但那边没有对应 site block，实际落进
  `*.coflux.dev` 预览域 block。属既有状况，本 plan 不处理也不要"顺手修"。

## Scope

In scope:

- prod-jp `/etc/caddy/Caddyfile` 中 `coflux.dev` / `api.coflux.dev` / `app.coflux.dev`
  / `m.coflux.dev` 四个 site block 的 tls 指令（`:48` / `:53` / `:60` / `:95`）
- owo-jp-gw `/etc/caddy/Caddyfile` 尾部追加四个 site block
- Cloudflare `coflux.dev` zone：新建 `api`/`app`/`m` 三条 A 记录，修改 `coflux.dev` 一条
- `plans/089-center-ingress-via-owo-jp-gw.md`、`plans/README.md`

Out of scope:

- 中心服务本体（`/opt/coflux`、PG17、`coflux-server`、`/etc/coflux/server.env`）——本次
  是纯链路变更，不重启 server、不重建 web
- 仓库源码——域名不变，`packages/cli/cofluxd.mjs:26` 与
  `apps/ios/Coflux/Client/Config.swift:12` 均不改
- `*.coflux.dev` 泛记录与 prod-jp `:116` 的预览域 site block——继续留在橙云
- `www.coflux.dev`——既有状况，本次不碰
- owo-jp-gw 的 Caddy 二进制、既有 9 个 site block（含 relay 站）
- prod-bj——仅作国内观测点，不做任何变更
- 18 台设备的 `settings.json`、iOS 发版

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| prod-jp 配置校验 | `ssh root@prod-jp 'caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile'` | exit 0 |
| owo 配置校验 | `ssh owo-jp-gw 'caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile'` | exit 0 |
| 四域可达 (acceptance) | `for h in coflux.dev api.coflux.dev app.coflux.dev m.coflux.dev; do curl -sS -o /dev/null -w "$h %{http_code}\n" https://$h/; done` | app/m 200、api 404（无根路由，属正常）、裸域 301 |
| WS 升级 (acceptance) | `curl -i --http1.1 -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" https://app.coflux.dev/client` | `101 Switching Protocols` |
| 国内 TTFB 验收 (acceptance) | `ssh root@prod-bj 'curl -sS -o /dev/null -w "ttfb=%{time_starttransfer}\n" https://app.coflux.dev/'` | 显著低于 1.598s 基线 |
| 既有 9 站无损 (acceptance) | `ssh owo-jp-gw 'for u in https://cchost.cc/ https://relay.coflux.dev/ https://zakki.owodns.com/ https://cdn.cchost.cc/; do curl -sS -o /dev/null -w "$u %{http_code}\n" $u; done'` | 与变更前一致 |
| daemon 回连 (acceptance) | `ssh root@prod-jp 'journalctl -u coflux-server --since "10 min ago" \| grep -c "daemon authed"'` | > 0 且无反复重连 |
| 预览域未受损 (acceptance) | `dig +short web-3000-p.coflux.dev @1.1.1.1` | 仍解析到 CF Anycast 地址 |

## Done criteria

- [ ] 两台机的 `caddy validate` 均 exit 0。
- [ ] `api`/`app`/`m`/`coflux.dev` 四域从国内解析到 `45.94.40.233` 且 HTTPS 证书有效。
- [ ] 国内 TTFB 实测数字已记录，并与 1.598s 基线明确对比。
- [ ] WS 升级返回 101；daemon 在中心日志中回连且无反复重连。
- [ ] owo-jp-gw 既有 9 站与 `*.coflux.dev` 预览域行为不变。
- [ ] `git status --porcelain` 仅含 `plans/` 下文件——本 plan 不应产生任何源码 diff。
- [ ] 中心服务未重启、`/opt/coflux` 未改动。
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Milestone 3 的 `m.coflux.dev` 试切失败（证书签不下来、502、或 TTFB 不降反升）——删除
  该记录回滚，报告后停止，不要继续切 api/app。
- 切换后出现 **525**（回源 SNI 握手失败）——说明 `tls internal` 与 CF/owo 的回源验证组合
  不成立，回滚并报告。
- owo-jp-gw 上任一既有站点在 reload 后不可达。
- 需要改动 owo-jp-gw 的 Caddy 二进制、`*.coflux.dev` 泛记录，或任何仓库源码才能推进。
- Decisions & tradeoffs 中引用的事实不再成立（尤以 DNS 记录构成、`8787` 仅绑回环、
  Caddy 2.6.2 不支持 `stream_close_delay` 三条为要）。
- 任一验证命令在一次合理修复后仍连续失败两次。

## Maintenance notes

- **回滚预案**（受 DNS TTL 约束，约 5 分钟，不再是橙云时代改源站的秒级生效）：删除新建的
  `api`/`app`/`m` 三条 A 记录（泛记录 `*.coflux.dev` 自动接管，这是本方案刻意保留的
  退路），裸域 `coflux.dev` 改回 `content=82.40.34.55` + `proxied=true`，再把 prod-jp
  四站的 `tls internal` 撤销以恢复公网 ACME。
- **证书续期依赖**：owo 上四站的 HTTP-01 续期要求这四个域名持续保持灰云。将来若有人把
  它们改回橙云，续期会在 60 天后静默失败。
- **失去的东西**：去掉橙云等于放弃 CF 的 DDoS 防护与 IP 隐藏，`45.94.40.233` 直接暴露；
  同时 owo 的 Caddy 每次 reload 都会掐断 coflux 的 WS。
- **收益的不确定性**：立项时唯一可信的国内实测是 prod-bj → `.233` 的
  `conn=0.431/0.396/0.149s` 三次剧烈抖动，样本少且腾讯云出境不等于家宽体感。若日后体感
  再次变差，先重测这一跳，而不是先怀疑中心。
- 记忆 [[relay-nodes]] 中"jp 节点 = 45.94.40.123"与 [[prod-server]] 中"DNS A →
  82.40.34.55"两条均已过期，本 plan 落地后应一并更新。
