# 生产部署

记录生产环境**当前长什么样**。每次变更拓扑的 plan 落地后，回来更新这里——
plan 记的是"这次改了什么"，这份记的是"现在是什么"。

发版流程见 [RELEASING.md](RELEASING.md)；架构原理见 [architecture.md](architecture.md)。

## 拓扑

三台机，中心只有一个实例（B7 已定的产品形态，见 [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md)）。

```
                     ┌──────────────── owo-jp-gw（日本，45.94.40.233）
  浏览器 / iOS ──────>│  公网入口：Caddy 终结 TLS，反代回 prod-jp
  daemon（各用户机器）│  jp relay：coflux-relay:8790（当前空转，中心未派发）
                     └────────┬───────────────────────────────
                              │ 同机房公网，RTT 1.4ms
                              v
                     ┌──────────────── prod-jp（日本，82.40.34.55）
                     │  中心 coflux-server → 127.0.0.1:8787（不对外）
                     │  PostgreSQL 17 → 127.0.0.1:5432
                     │  Caddy：静态 SPA + 按 Host 路由 + 预览域
                     └────────────────────────────────────────

                     ┌──────────────── prod-bj（北京，49.232.53.23）
  daemon ───────────>│  bj relay：coflux-relay:8790（中心当前只派发这个）
                     └────────────────────────────────────────
```

daemon 跑在各用户自己的机器上，不在任何一台服务器（prod-bj 上有一台自用 daemon
`VM-0-3-ubuntu`，与它的 relay 角色无关）。

## 域名与线路

**最容易搞混的一点：coflux.dev 下橙云与灰云并存。** 只有泛域名还在 Cloudflare 代理后面。

| 域名 | A 记录 | CF 代理 | 终点 | 证书 |
| --- | --- | --- | --- | --- |
| `coflux.dev` | 45.94.40.233 | 灰云 | owo 直接 301 → app | owo，HTTP-01 |
| `api.coflux.dev` | 45.94.40.233 | 灰云 | owo → prod-jp:8787 | owo，HTTP-01 |
| `app.coflux.dev` | 45.94.40.233 | 灰云 | owo → prod-jp（SPA + `/client` WS） | owo，HTTP-01 |
| `m.coflux.dev` | 45.94.40.233 | 灰云 | owo → prod-jp（mobile，已冻结） | owo，HTTP-01 |
| `*.coflux.dev` | 82.40.34.55 | **橙云** | 直达 prod-jp，端口转发预览域 | prod-jp，**DNS-01** |
| `www.coflux.dev` | 82.40.34.55 | 橙云 | 无对应 site，落进预览域 block | — |
| `relay.coflux.dev`<br>`relay-jp.coflux.dev` | 45.94.40.233 | 灰云 | owo 的 relay:8790 | owo，HTTP-01 |
| `relay-bj.coflux.yourantiandi.com` | 49.232.53.23 | DNSPod 泛解析 | prod-bj 的 relay:8790 | prod-bj |

`api`/`app`/`m` 原本**没有独立记录**、靠泛记录覆盖；2026-09-04（plan 089）新建了独立
灰云记录（独立优先于泛记录），泛记录保持橙云不动——这也是回滚的退路：删掉这三条，
泛记录自动接管。

大陆机器（prod-bj）只承载 relay，且用的是备案域名 `yourantiandi.com`；`coflux.dev`
未备案，不落在大陆 IP 上。

## prod-jp —— 中心

`ssh root@prod-jp`。Debian 13，4 核 7.8G。**这台机不是 coflux 独占**，Caddyfile 里还有
`cchost.cc` / `cchost.ai` / `pa.wsq.cool` 等站点，改配置别误伤。

- 代码 `/opt/coflux`，形态是 **detached HEAD 钉在 tag**（本地 main 落后数百提交且无
  upstream，`git pull` 不可用）。
- 中心服务：systemd `coflux-server`，`node --import tsx apps/server/src/index.ts`，
  只绑 `127.0.0.1:8787`。
- 数据库：本机 apt PostgreSQL 17，只听 `127.0.0.1`，库/角色均名 `coflux`。
  每日备份 `/etc/cron.daily/coflux-pg-backup` → `/var/backups/coflux/`（`-Fc`，留 14 份）。
- 认证 `COFLUX_AUTH=password`（自建 users 表 + scrypt，Supabase 已退役）。
  建号：`DATABASE_URL=... node --import tsx scripts/create-user.mjs --email .. --password ..`
- Caddy 上 coflux 的四个站（裸域/api/app/m）用 **`tls internal`**（自签）——它们转灰云后
  公网 ACME 必然失败；`*.coflux.dev` 仍走 DNS-01 cloudflare 插件，**别动**。
- MCP / OAuth（plan 090）：`server.env` 里须有 `COFLUX_PUBLIC_URL=https://api.coflux.dev`
  （issuer 与所有元数据 URL 由它拼，不看请求 Host）。宿主接入地址 `https://api.coflux.dev/mcp`；
  端点 `/.well-known/oauth-protected-resource[/mcp]`、`/.well-known/oauth-authorization-server`、
  `/oauth/{register,authorize,token}` 全部随 api 站反代到 8787，无需单独 handle。上线检查：
  owo-jp-gw 与 prod-jp 的 api 站块没有别的 `.well-known` handle（HTTP-01 只占 `acme-challenge`）；
  确认页在 `app.coflux.dev/oauth/consent`（SPA 兜底即可）；web 与 server 须同批部署（新 client 消息 +
  版本准入）。

## owo-jp-gw —— 公网入口 + jp relay

`ssh owo-jp-gw`。Debian 13，2 核。与 prod-jp 同机房（RTT 1.4ms）。**该机压着 9 个其他
站点**（`zakki.owodns.com` / `cchost.cc` / `open.owo.nz` / `pir.bannin.app` 等），
动它的 Caddy 就是动这些站。

- **三个 IP 绑同一网卡**：`45.94.40.29`（主）、**`45.94.40.233`（入口与 relay 域名现用，
  认准这个）**、`45.94.40.123`（旧，但 `ifconfig.me` 仍显示它，极易误判）。
- Caddy **2.6.2**，**不支持 `stream_close_delay`**，勿从 prod-jp 的配置照搬该指令。
  代价是 reload 会掐断 coflux 的 WS 长连接，daemon 自动重连。
- **严禁 `caddy add-package` 或升级二进制**——会替换二进制并让那 9 个站一起重启。
  因此入口四站只能走 HTTP-01（灰云下挑战直达本机），拿不到泛证书，预览域才留在橙云。
- relay 二进制 `/opt/coflux-relay/coflux-relay`，systemd `coflux-relay`，
  env `/etc/coflux/relay.env`。**relay 站点严禁开 access_log**（token 在 query string）；
  入口四站可以开（daemon 的 token 走 WS 消息，不在 URL 里），日志在
  `/var/log/caddy/coflux-access.log`。

## prod-bj —— bj relay

`ssh root@prod-bj`。Ubuntu 24.04，SA3.LARGE8。形态与 jp relay 一致。中心的
`COFLUX_RELAY_NODES` **当前只派发这一个节点**（jp 那个空转待拆）——原因是 jp 的 IP
曾被 GFW 干扰而国内不可达，而 daemon 都在国内。

派发规则：channel 用 daemon 上报的 `homeRelayId`，未上报时回退 `nodes[0]`，
所以增删节点时**首项必须始终是可达节点**（`apps/server/src/relay-rendezvous.ts`）。

也是国内视角的观测点——验证线路时从这台机打，本机家宽可能走代理而失真。

## 常规部署

只改 web 可省重启（静态替换零停机，不打断在线 daemon/会话）；只改 server 可省构建。

```sh
ssh root@prod-jp 'cd /opt/coflux && git fetch --tags && git checkout <tag> \
  && pnpm install --frozen-lockfile \
  && pnpm --filter @coflux/web build \
  && systemctl restart coflux-server'
```

mobile 若随共享层变更需重建：`pnpm --filter @coflux/mobile build`。

改 Caddy：编辑 → `caddy validate` → `systemctl reload caddy`。
在 prod-jp 上 validate 必须先 `set -a; . /etc/caddy/cloudflare.env; set +a`，
否则拿不到 systemd 注入的 env，会报 `API token '' appears invalid` 假警报。

验证：

```sh
curl -sS -o /dev/null -w "%{http_code}\n" https://app.coflux.dev/    # 200（api 根路径 404 属正常）
# WS 必须强制 HTTP/1.1，h2 下升级不成立会误报 404
curl -i --http1.1 -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  https://app.coflux.dev/client                                      # 101
ssh root@prod-bj 'curl -sS -o /dev/null -w "ttfb=%{time_starttransfer}\n" https://app.coflux.dev/'
```

端到端冒烟：`scripts/prod-smoke.mjs`（走真协议与独立 relay 路径）。

## 秘密

只记位置与类型，值一律不入库。

| 位置 | 内容 |
| --- | --- |
| prod-jp `/etc/coflux/server.env`（600） | `DATABASE_URL`（含库密码）、`COFLUX_RELAY_SIGNING_KEY`（rendezvous 签名种子） |
| prod-jp `/etc/coflux/pg-coflux.pass`（600） | PG 角色口令 |
| prod-jp `/etc/caddy/cloudflare.env`（600） | CF API token，**仅 coflux.dev zone 的 DNS 编辑权限**——读 zone settings（如 SSL 模式）会返回 `9109 Unauthorized` |
| relay 节点 `/etc/coflux/relay.env` | `COFLUX_RELAY_PUBKEY`（验签公钥，非秘密） |

relay 密钥轮换顺序：换中心 seed → 同步新公钥到各 relay 的 `relay.env` → 重启两端
（当前单公钥实现，窗口内 relay 短暂不可用）。

## 回滚

**入口链路**（受 DNS TTL≈300s 约束，不再是橙云改源站的秒级生效）：
删掉 `api`/`app`/`m` 三条 A 记录（泛记录自动接管）→ 裸域改回 `82.40.34.55` + 橙云 →
撤掉 prod-jp 四站的 `tls internal`。

**代码**：`git checkout` 回上一个 tag，重装依赖重建 web 重启 server。

## 坑

- **回源必须同时写 `header_up Host {host}` 和 `transport http { tls_server_name {host} }`。**
  Caddy 反代到 `https://<IP>` 时 TLS SNI 默认取上游 IP，prod-jp 没有匹配 IP 的 site，
  握手直接失败、上游报 **502**。`header_up Host` 只改 HTTP 头，改不了 SNI。
- **`coflux.dev` 裸域必须有人持证书**，否则 CF 回源 SNI 握手报 **525**。prod-jp 上那个
  只做 301 的 block，存在意义就是持证书，别因为"只是个跳转"而省掉。
- **`app.coflux.dev` 的 `/client` 反代不能丢**：web 前端连同源 `wss://{location.host}/client`，
  漏了这段会一直卡"连接中"。重写 Caddyfile 时最容易丢。
- **ICMP 不是判据**：prod-jp 与 owo-jp-gw 都 ping 不通，但 TCP 正常。判连通性用 TCP。
- **本机家宽测线路会失真**：Surge 等工具的 TUN 会接管流量，DNS 返回 `198.18.x.x` fake-IP、
  `nc` 报 OPEN 都是假象。国内视角一律从 prod-bj 打。
- **发版后 worker 不投递**先查 `COFLUX_AUTOUPDATE_REPO` 是否被注释掉了（有过前科）。
- 中心轮询 GitHub Release 做升级编排；若中心迁到大陆需注意该链路，
  `COFLUX_AUTOUPDATE_API_BASE` 可指向镜像。
