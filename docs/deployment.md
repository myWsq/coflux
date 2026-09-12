# Production deployment

This document separates the source migration runbook from the last recorded production layout. Tailcat retirement changes are not a production deployment. Verify live services before executing a rollout, and record the deployed tag and topology afterward.

See [RELEASING.md](RELEASING.md) for releases and [architecture.md](architecture.md) for architectural principles.

## Native transport migration runbook

This source requires Tailcat for remote Desktop/Linux connections and a matching
`coflux-transport` beside each worker. The custom relay service is retired from
builds and release artifacts. The legacy host inventory below describes the
pre-migration deployment only; it is not a command to recreate those services.

1. Release and validate matching Desktop, CLI, supervisor, worker, and transport
   artifacts. Existing supervisors need `cofluxd update` and an explicit daemon
   restart to acquire `transport_pair_v1` before paired hot upgrades. Preserve
   previous complete worker/helper releases for rollback.
2. Provision pinned upstream stock `derper` on the selected existing relay hosts,
   with publicly trusted TLS certificates, persistent DERP node keys, HTTPS access,
   and upstream STUN/UDP requirements. Do not reuse custom relay query-token
   paths or signing-key configuration. Pin the same Tailscale revision as
   `transport/tailcat/go.mod`; stock DERP is operated independently of product
   release artifacts.
3. Set `COFLUX_DERP_REGIONS` on the center to 1–8 upstream region descriptors,
   containing unique positive `RegionID` values and matching node IDs/hostnames.
   Both ends use the worker-selected region; helper replacement rotates regions.
4. Set `COFLUX_DERP_ADMISSION_PORT` on the center. The listener binds loopback
   only. Reach `/verify` from remote DERP hosts through authenticated private
   forwarding. Start stock DERP with `-verify-client-url <private-verify-url>`
   and **`-verify-client-url-fail-open=false`**; the upstream default is fail-open.
   Never route `/verify` through the public app proxy. Keep unrelated sites on
   these shared hosts intact.
5. Verify registered-node access, unknown-node rejection, admission outage
   rejection and recovery against real stock DERP. Check `/derp/probe`, actual
   application traffic, helper crashes, region outages, control disconnects,
   and existing PTY continuity. Local benchmark or fixture results do not prove
   real network latency or production readiness.
6. Deploy the center with control protocol floor 2 after clients and runtime
   bootstrap are ready. Versions below 2 are rejected; newer compatible peers
   remain allowed. DeviceEnvelope version stays 1. Frozen browser clients and
   current Swift/iOS remote paths are unavailable after this switch; use Desktop.
7. Remove obsolete custom-relay services and keys only as part of the authorized
   production cutover after native traffic is verified. This implementation task
   has not performed that cleanup or changed production.

Example region shape (replace the hostname with an operated DERP endpoint):

```json
[{"RegionID":901,"RegionCode":"private-jp","Nodes":[{"Name":"private-jp-1","RegionID":901,"HostName":"derp.example.com","DERPPort":443,"STUNPort":3478}]}]
```

Rollback requires a compatible server/client/runtime set. Rolling back only the
center to control version 1 causes current clients and workers to reject it.
For runtime regressions, restore the previous immutable worker/helper pair;
supervisor PTYs survive worker rollback. Keep DNS/Caddy rollback distinct from
application/runtime rollback.

## Last recorded pre-migration topology


Three machines, with one central instance—the agreed B7 product model in [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md).

```text
                     ┌──────────────── owo-jp-gw (Japan, 45.94.40.233)
  Browser / iOS ────>│  Public ingress: Caddy TLS termination, proxy to prod-jp
  Daemons            │  JP relay: coflux-relay:8790 (idle; not currently assigned)
                     └────────┬───────────────────────────────
                              │ Same-datacenter public network, RTT 1.4ms
                              v
                     ┌──────────────── prod-jp (Japan, 82.40.34.55)
                     │  coflux-server → 127.0.0.1:8787 (not public)
                     │  PostgreSQL 17 → 127.0.0.1:5432
                     │  Caddy: static SPA, Host routing, preview domains
                     └────────────────────────────────────────

                     ┌──────────────── prod-bj (Beijing, 49.232.53.23)
  Daemons ──────────>│  BJ relay: coflux-relay:8790 (the only assigned node)
                     └────────────────────────────────────────
```

Daemons run on users' machines, not as part of these server roles. prod-bj also hosts the owner's `VM-0-3-ubuntu` daemon, independently of its relay role.

## Domains and routing

**The main source of confusion: coflux.dev mixes proxied and DNS-only Cloudflare records.** Only wildcard routing remains behind Cloudflare's proxy.

| Domain | A record | Cloudflare proxy | Destination | Certificate |
| --- | --- | --- | --- | --- |
| `coflux.dev` | 45.94.40.233 | DNS-only | owo directly returns 301 to app | owo, HTTP-01 |
| `api.coflux.dev` | 45.94.40.233 | DNS-only | owo → prod-jp:8787 | owo, HTTP-01 |
| `app.coflux.dev` | 45.94.40.233 | DNS-only | owo → prod-jp SPA + `/client` WS | owo, HTTP-01 |
| `m.coflux.dev` | 45.94.40.233 | DNS-only | owo → prod-jp frozen mobile | owo, HTTP-01 |
| `*.coflux.dev` | 82.40.34.55 | **Proxied** | Direct to prod-jp port previews | prod-jp, **DNS-01** |
| `www.coflux.dev` | 82.40.34.55 | Proxied | No dedicated site; matches preview block | — |
| `relay.coflux.dev`<br>`relay-jp.coflux.dev` | 45.94.40.233 | DNS-only | owo relay:8790 | owo, HTTP-01 |
| `relay-bj.coflux.yourantiandi.com` | 49.232.53.23 | DNSPod wildcard | prod-bj relay:8790 | prod-bj |

`api`/`app`/`m` originally had **no dedicated records**, relying on the wildcard. Plan 089 created explicit DNS-only records on 2026-09-04; explicit records override wildcards. The wildcard stayed proxied, providing rollback: delete those three records and the wildcard takes over.

The mainland machine, prod-bj, hosts only the relay server role and uses the registered domain `yourantiandi.com`. `coflux.dev` has no mainland ICP registration and does not point to mainland IPs.

## prod-jp: center

Connect with `ssh root@prod-jp`. Debian 13, four cores, 7.8GB. **This host is shared with other projects**: Caddyfile also contains `cchost.cc`, `cchost.ai`, `pa.wsq.cool`, and others. Preserve them when editing.

- Source: `/opt/coflux`, **detached HEAD pinned to a tag**. Local main is hundreds of commits behind with no upstream; `git pull` is unsuitable.
- Service: systemd `coflux-server`, running `node --import tsx apps/server/src/index.ts`, bound only to `127.0.0.1:8787`.
- Database: apt-installed PostgreSQL 17, listening only on `127.0.0.1`, database and role both named `coflux`. Daily `/etc/cron.daily/coflux-pg-backup` writes custom-format (`-Fc`) backups to `/var/backups/coflux/`, retaining 14.
- Authentication: `COFLUX_AUTH=password`, self-managed users/scrypt; Supabase is retired. Create users with `DATABASE_URL=... node --import tsx scripts/create-user.mjs --email .. --password ..`.
- The four coflux sites—apex/api/app/m—use **`tls internal`**, since public ACME cannot validate this backend after DNS moves to ingress. `*.coflux.dev` still uses the Cloudflare DNS-01 plugin; **leave it unchanged**.
- Version 1.0.0 account CLI uses central `/api/client/login` and `/api/client/command`. Desktop and standalone CLI both depend on them; deploy the center before updating 1.0.0 clients. MCP/dedicated OAuth routes are removed; old tables remain through historical migrations. `COFLUX_PUBLIC_URL=https://api.coflux.dev` still serves device authorization and preview pages. Whole-site API proxying needs no Caddy changes.

## owo-jp-gw: public ingress and JP relay

Connect with `ssh owo-jp-gw`. Debian 13, two cores, same datacenter as prod-jp with 1.4ms RTT. **Nine other sites share this host**, including `zakki.owodns.com`, `cchost.cc`, `open.owo.nz`, and `pir.bannin.app`. Caddy changes affect them too.

- **Three IPs share one interface**: primary `45.94.40.29`; **`45.94.40.233`, the current ingress/relay address**; and old `45.94.40.123`, still returned by `ifconfig.me` and easily mistaken for the active address.
- Caddy **2.6.2 does not support `stream_close_delay`**. Do not copy that directive from prod-jp. Reload therefore disconnects long-lived coflux WebSockets; daemons reconnect automatically.
- **Do not run `caddy add-package` or upgrade the binary**: replacement restarts all nine other sites. The four ingress sites use HTTP-01 with DNS-only challenges reaching this host. Without wildcard certificates here, previews remain proxied through Cloudflare.
- Relay binary: `/opt/coflux-relay/coflux-relay`; systemd service `coflux-relay`; environment `/etc/coflux/relay.env`. **Never enable access logs for relay sites**, whose query strings contain tokens. The four ingress sites may log because daemon tokens travel in WS messages, not URLs; logs are at `/var/log/caddy/coflux-access.log`.

## prod-bj: Beijing relay

Connect with `ssh root@prod-bj`. Ubuntu 24.04, SA3.LARGE8, same service layout as JP relay. Central `COFLUX_RELAY_NODES` **currently assigns only this node**; JP is idle pending removal. Its IP previously suffered GFW interference from mainland networks, where the daemons reside.

The recorded deployment used custom home-relay selection. That source has been removed; follow the native migration runbook before deploying this branch.

This is also the mainland observation point. Test routing from here: local residential connections may be proxied and distort results.

## Server deployment after native migration prerequisites

After the native cutover prerequisites above are satisfied, update the server tag. Web/mobile assets remain frozen but their version-1 remote protocol cannot authenticate to this source:

```sh
ssh root@prod-jp 'cd /opt/coflux && git fetch --tags && git checkout <tag> \
  && pnpm install --frozen-lockfile \
  && systemctl restart coflux-server'
```

## Server-rendered browser pages (plan 107)

The system-browser flows—device enrollment through `/authorize/<token>` printed by `cofluxd up`, and preview access through `/proxy-auth`—are server-rendered HTML under `COFLUX_PUBLIC_URL`, `https://api.coflux.dev/...` in production. Whole-site API proxying sends them to 8787 without Caddy changes. Server generates no links to `app.coflux.dev` and reads no web-console URL configuration. The old web-address variable in `server.env` is unused and can be removed.

## Frozen web clients (plan 106)

`app.coflux.dev` and `m.coflux.dev` continue serving **the last pre-split builds**, without updates or conversion to download pages; `/` behavior is unchanged. They are legacy workbenches only. Daily work uses desktop, and server handles the two browser flows above. Old pages in frozen bundles remain manually accessible but have no incoming links. The last web/mobile source is at split baseline `ce7026b`; the currently deployed frozen build corresponds to `e32103b`, deployed 2026-09-11 with matching dist/build-id.txt.

**Before the next deployment from a post-split commit, perform this one-time step.** `git checkout <tag>` leaves ignored `apps/web/dist` and `apps/mobile/dist`, so frozen sites may accidentally survive a post-split checkout. That is persistence of ignored files, not automatic compatibility: `git clean`, a fresh checkout directory, or repository cleanup can remove them and invalidate `COFLUX_BUILD_ID_FILE`. Move frozen dist directories outside the repository and point Caddy roots/server.env there:

```sh
ssh root@prod-jp 'mkdir -p /opt/coflux-web-frozen \
  && cd /opt/coflux/apps \
  && cp -a web/dist /opt/coflux-web-frozen/app \
  && cp -a mobile/dist /opt/coflux-web-frozen/m'
# Caddyfile: set app.coflux.dev / m.coflux.dev roots to /opt/coflux-web-frozen/app and /m.
# Keep /client proxying unchanged; run caddy validate, then systemctl reload caddy.
# /etc/coflux/server.env:
#   COFLUX_BUILD_ID_FILE=/opt/coflux-web-frozen/app/build-id.txt,/opt/coflux-web-frozen/m/build-id.txt
# Restart coflux-server after env changes. Build-ID files are reread on each authentication.
```

Then remove leftover `web` / `mobile` directories under `/opt/coflux/apps`. Frozen bundles still require exact build-ID admission; plan 105 changed only `client_kind=desktop`. Move `COFLUX_BUILD_ID_FILE` with them. Unreadable files are silently ignored: an empty allow-set with unset `COFLUX_BUILD_ID` skips browser version checks entirely, accepting any build ID. It does not crash, but removes admission enforcement.

**Desktop admission (plan 105)** uses control-protocol version, not build ID. Production need not match client-release SHA and does not disconnect online desktop versions. Only breaking protocols require desktop release before deployment; see [RELEASING.md](RELEASING.md).

For Caddy changes: edit, run `caddy validate`, then `systemctl reload caddy`. On prod-jp, first load systemd's environment with `set -a; . /etc/caddy/cloudflare.env; set +a`; otherwise validation falsely reports `API token '' appears invalid`.

Verification:

```sh
curl -sS -o /dev/null -w "%{http_code}\n" https://app.coflux.dev/    # 200; API root 404 is normal
# Force HTTP/1.1 for WS; h2 cannot perform this upgrade and misleadingly returns 404.
curl -i --http1.1 -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  https://app.coflux.dev/client                                      # 101
ssh root@prod-bj 'curl -sS -o /dev/null -w "ttfb=%{time_starttransfer}\n" https://app.coflux.dev/'
```

End-to-end smoke: `scripts/prod-smoke.mjs`, using real DeviceEnvelope traffic through the native helper. It makes production changes and is run only during an authorized smoke test.

## Secrets

Record only locations/types, never values.

| Location | Contents |
| --- | --- |
| prod-jp `/etc/coflux/server.env` (600) | `DATABASE_URL` with database password; rendezvous signing seed `COFLUX_RELAY_SIGNING_KEY`. Required non-secret settings: `COFLUX_PUBLIC_URL=https://api.coflux.dev` and `COFLUX_INBOUND_QUEUE_MAX_MESSAGES=1024`. |
| prod-jp `/etc/coflux/pg-coflux.pass` (600) | PostgreSQL role password |
| prod-jp `/etc/caddy/cloudflare.env` (600) | Cloudflare API token with **DNS edit permission only for the coflux.dev zone**. Reading zone settings such as SSL mode returns `9109 Unauthorized`. |
| Relay nodes `/etc/coflux/relay.env` | `COFLUX_RELAY_PUBKEY`, a non-secret verification public key |

The relay key locations above belong to the pre-migration inventory. Native DERP uses node identities and fail-closed admission; it does not read those signing keys. Retire obsolete credentials during the authorized cutover.

## Rollback

**Ingress routing**, subject to roughly 300-second DNS TTL rather than near-instant proxied origin changes: delete the `api`/`app`/`m` A records so the wildcard takes over, restore apex to `82.40.34.55` with proxying, then remove `tls internal` from prod-jp's four sites.

**Code**: check out the previous tag, reinstall dependencies, and restart server. Frozen web builds do not participate.

## Pitfalls

- **Set both `header_up Host {host}` and `transport http { tls_server_name {host} }` when proxying to the origin.** With `https://<IP>`, Caddy otherwise uses the IP as TLS SNI. prod-jp has no matching IP site, so handshake fails and the proxy returns **502**. Host headers do not change SNI.
- **The apex `coflux.dev` must have a certificate holder**, or Cloudflare origin SNI fails with **525**. prod-jp's redirect-only block exists to hold that certificate; do not remove it merely because it returns 301.
- **Keep `/client` proxying on `app.coflux.dev`.** Frozen web connects to same-origin `wss://{location.host}/client`; omission leaves its authorization/consent pages stuck connecting. This is easy to lose in a Caddyfile rewrite.
- **ICMP is not a connectivity test here**: prod-jp and owo-jp-gw do not answer ping but work over TCP. Test TCP.
- **Residential local routing measurements can mislead**: Surge/TUN may intercept traffic, returning `198.18.x.x` fake IPs and misleading `nc` OPEN results. Use prod-bj for mainland observations.
- **Worker updates not dispatched after release**: first check whether `COFLUX_AUTOUPDATE_REPO` was commented out; this has happened before.
- **Daemon reconnects every two seconds after authentication**, with literal diagnostic `WS 入站队列超过硬上限`: since v0.29.0, server limits pending incoming messages per WS via `COFLUX_INBOUND_QUEUE_MAX_MESSAGES`, default 64. A large daemon such as Home (13 workspaces, 21 tasks) reports 65+ workspaceBranch/Diff/DefaultBranch, catalog, and checkpoint messages immediately after auth. Per-message awaited database operations cannot drain them quickly enough, so server disconnects and reconnect repeats the burst indefinitely. This occurred on first production deployment of v0.29.0+ on 2026-09-05. Production now sets `COFLUX_INBOUND_QUEUE_MAX_MESSAGES=1024`, retaining the 16MB byte limit. Root-cause work on burst/drain mismatch needs a separate plan; do not remove this setting.
- Center polls GitHub Releases for upgrades. If moved to mainland China, assess that route; `COFLUX_AUTOUPDATE_API_BASE` can point to a mirror.
