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
   release artifacts. derper binds STUN to the IP of its `-a` flag, so a derper
   behind a reverse proxy on loopback cannot serve STUN; run upstream `stund`
   beside it instead, and point `STUNPort` only at a STUN server coflux owns.
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
                     ┌──────────────── prod-jp (Japan, 82.40.34.37)
                     │  coflux-server → 127.0.0.1:8787 (not public)
                     │  PostgreSQL 17 → 127.0.0.1:5432
                     │  Caddy: static SPA, Host routing, preview domains
                     └────────────────────────────────────────

                     ┌──────────────── prod-bj (Beijing, 49.232.53.23)
  Daemons ──────────>│  BJ relay: coflux-relay:8790 (the only assigned node)
                     └────────────────────────────────────────
```

Daemons run on users' machines, not as part of these server roles. prod-bj also hosts the owner's `VM-0-3-ubuntu` daemon, independently of its relay role.

## Current topology: the centre on coflux-sh (since 2026-10-09 20:47)

The centre, its database and the DERP/STUN node run on one Tencent Cloud host in Shanghai. prod-jp only forwards the `coflux.dev` names to it; prod-bj no longer carries coflux traffic.

```text
  mainland devices ──(direct)──> api.coflux.yourantiandi.com ┐
                                                             ├─> coflux-sh (Shanghai, 49.234.42.193)
  coflux.dev clients ─> Cloudflare ─> prod-jp Caddy ─────────┘    Caddy :443 → coflux-server 127.0.0.1:8787
                        (forwarder: SNI api.coflux.yourantiandi.com,  PostgreSQL 17 127.0.0.1:5432
                         Host kept, XFF = CF-Connecting-IP)           derper 127.0.0.1:8444 (derp.coflux.yourantiandi.com)
                                                                      stund UDP 3479
```

**Why `coflux.dev` cannot point at this host.** Tencent Cloud blocks names without a mainland ICP filing on 80/443: once it notices one, HTTP gets a 302 to `dnspod.qcloud.com/static/webblock.html?d=<name>` and HTTPS is reset after the ClientHello. It is reactive (the first requests on 2026-10-09 went through, then the block appeared) and it applies to Cloudflare's origin pulls too, which surface as **525**. Traffic from inside Tencent Cloud (prod-bj) is not filtered, so **prod-bj is not a valid observation point for this block**; test from a residential or foreign machine. The filter sees only SNI/Host in the clear, so a forwarder that dials with SNI on the registered name and sends the original `Host` passes, and the coflux.dev site blocks on coflux-sh route it as before. `yourantiandi.com` is filed under the same Tencent account (`app-id` 1301555531), which is what makes its names servable here.

- **Host**: `ssh root@49.234.42.193` (local alias `coflux-sh`). Debian 13, 2 cores, 1.9GB plus a 2GB `/swapfile`, zone `ap-shanghai-4`. Security group: TCP 22/80/443, **UDP 3479**.
- **DNS** (DNSPod): `api.coflux.yourantiandi.com` and `derp.coflux.yourantiandi.com` are explicit A records to 49.234.42.193; `*.yourantiandi.com` still points at prod-bj. Certificates for both are Let's Encrypt via Caddy (HTTP-01/TLS-ALPN). The coflux.dev certificates were copied from prod-jp and renew by DNS-01 with the same zone token.
- **Centre**: same layout as prod-jp had — `/opt/coflux` detached at a tag, systemd `coflux-server` with `/etc/coflux/server.env` and `tailcat.env`, frozen web in `/opt/coflux-web-frozen`, daily `/etc/cron.daily/coflux-pg-backup`. `COFLUX_PUBLIC_URL` and `COFLUX_DAEMON_URL` use `api.coflux.yourantiandi.com`, and `COFLUX_PUBLIC_URL_ALIASES=https://api.coflux.dev` (2.17.0+). Login and device-authorization links are built on whichever of the two a client connected to, because native clients refuse a sign-in page on another origin; the preview gate uses the primary name. `COFLUX_EXECUTOR_KEYS` is the original value; a new one would orphan every stored executor credential.
- **Client addresses**: Caddy here trusts only prod-jp (`trusted_proxies static 82.40.34.37/32`), and prod-jp sets `X-Forwarded-For` from `CF-Connecting-IP`, so login rate limits still see the real client. Without both, every forwarded user would share prod-jp's budget.
- **DERP**: region 902 `private-sh`, node `derp.coflux.yourantiandi.com`, STUNPort 3479. `coflux-derp.service` reads the Caddy-managed certificate through links in `/var/lib/coflux-derp/certs`; `coflux-derp-cert.path` restarts it on renewal. Admission is loopback (`http://derp:<token>@127.0.0.1:8793/derp-verify` in `/etc/coflux-derp/admission.env`, 0600), so it no longer depends on any public route. Caddy's unit runs without `--environ`, which would print the Cloudflare token into the journal.
- **Latency**: mainland → `api.coflux.yourantiandi.com` TTFB about 0.1s; through Cloudflare and prod-jp about 1.9s. Shanghai ↔ prod-jp RTT is 40–60ms but loses SYNs at evening peak (up to ~18% of new connections take a 1s retransmit), so the forwarder is a compatibility path, not the target.
- **Retired**: prod-jp's `coflux-server` is stopped and disabled, its database left as of the cutover dump `/var/backups/coflux/coflux-cutover-sh-20261009-204739.dump`. prod-bj's `coflux-derp`/`coflux-stun` are no longer advertised.

**Rollback**: dump coflux-sh's database and restore it on prod-jp first (anything written since the cutover exists only here), then `cp /etc/caddy/Caddyfile.bak-pre-sh-forwarder-20261009_204726 /etc/caddy/Caddyfile` on prod-jp, reload Caddy, re-enable and start prod-jp's `coflux-server` with its old `tailcat.env` (region 901 on prod-bj), and stop coflux-sh's server.

The sections below describe the hosts as they were before this move, with prod-jp now acting only as the forwarder.

## Domains and routing

**Since 2026-10-09 20:47 the coflux.dev names still resolve to prod-jp through Cloudflare, but prod-jp forwards them to coflux-sh (see above).** **Earlier on 2026-10-09 the centre's public names are proxied by Cloudflare straight to prod-jp; owo-jp-gw is no longer in the path.** On 2026-10-08 prod-jp lost all networking for about a day (no reboot, no data loss), and when it came back owo-jp-gw's addresses (`45.94.40.29`, `45.94.40.233`) were unreachable from mainland networks on every port while still reachable from abroad. Mainland daemons and clients could not reach the centre, so ingress moved to Cloudflare's proxy. Mainland TTFB through Cloudflare is about 1.7s, versus 0.27s through owo; that is the price of not depending on one blockable address. Do not point these names at prod-jp DNS-only either: that exposes the origin address to the same blocking.

| Domain | A record | Cloudflare proxy | Destination | Certificate |
| --- | --- | --- | --- | --- |
| `coflux.dev` | 82.40.34.37 | **Proxied** | prod-jp returns 301 to app | prod-jp, **DNS-01** |
| `api.coflux.dev` | 82.40.34.37 | **Proxied** | prod-jp:8787 | prod-jp, **DNS-01** (served by the `*.coflux.dev` certificate) |
| `app.coflux.dev` | 82.40.34.37 | **Proxied** | prod-jp SPA + `/client` WS | prod-jp, **DNS-01** (served by the `*.coflux.dev` certificate) |
| `m.coflux.dev` | 82.40.34.37 | **Proxied** | prod-jp frozen mobile | prod-jp, **DNS-01** |
| `*.coflux.dev` | 82.40.34.37 | **Proxied** | Direct to prod-jp port previews | prod-jp, **DNS-01** |
| `www.coflux.dev` | 82.40.34.37 | Proxied | No dedicated site; matches preview block | — |
| `relay.coflux.dev`<br>`relay-jp.coflux.dev` | 45.94.40.233 | DNS-only | owo relay:8790 | owo, HTTP-01 |
| `relay-bj.coflux.yourantiandi.com` | 49.232.53.23 | DNSPod wildcard | prod-bj relay:8790 | prod-bj |
| `dl.coflux.dev` | R2 custom domain (managed by Cloudflare) | **Proxied** | R2 bucket `coflux-releases`: the release download mirror, latest stable only | Cloudflare edge (min TLS 1.2) |

`api`/`app`/`m` originally had **no dedicated records**, relying on the wildcard. Plan 089 created explicit DNS-only records pointing at owo-jp-gw on 2026-09-04; on 2026-10-09 the same records were repointed to prod-jp with the proxy on. Switching back to owo is the reverse: set the four records to `45.94.40.233` DNS-only and check owo's Caddy still proxies to prod-jp. Before doing so, confirm owo is reachable from prod-bj (`nc -z 45.94.40.233 443`).

`dl.coflux.dev` is the R2 bucket's custom domain, not a DNS record we manage; like any explicit record it overrides the proxied wildcard for that one name. A zone Cache Rule (`http.host eq "dl.coflux.dev"`) makes every response cache-eligible and takes edge and browser TTLs from the origin `Cache-Control` that the release workflow sets; without it, extension-less binaries, `.json` and `.yml` would not be cached. The bucket's `r2.dev` URL is disabled. It is part of the product contract: stable manifests, desktop builds and cofluxd read it. See [RELEASING.md](RELEASING.md#r2-download-mirror-dlcofluxdev).

**DERP admission outage, 2026-09-17 — read this before moving the centre.** prod-bj's `coflux-derp` runs stock `derper` with `-verify-client-url-fail-open=false`: it asks the centre about every client key and relays for nobody when it cannot ask. That call used to travel through `coflux-derp-admission-tunnel.service`, an SSH tunnel whose target host and port were written into the unit file *on prod-bj*. When prod-jp changed IP the tunnel died, admission failed closed, and every remote device in the account went dark for hours — while the control plane stayed healthy, `coflux device exec` kept working, and clients showed only 「正在探测」 forever. The single visible symptom was in prod-bj's own log: `rejected: Post "http://127.0.0.1:8793/verify": connection refused`. The tunnel is now disabled and masked out of the boot sequence; `-verify-client-url` points at `https://derp:<token>@api.coflux.dev/derp-verify`, held in `/etc/coflux-derp/admission.env` (0600) because a systemd unit is world-readable. Diagnose future relay silence with `journalctl -u coflux-derp | grep rejected` first.

**STUN is `coflux-stun.service` on UDP 3479 (since 2026-09-29).** Every Tailcat node learns its public UDP endpoint by STUN against the region's `STUNPort`; without an answer it advertises only interface addresses, and every pair not on one LAN silently stays on DERP relay — nothing errors, the sidebar just shows 「中继连接」. `coflux-derp` runs `-stun=false` because it listens on `-a 127.0.0.1:8444` behind Caddy, and derper binds STUN to that address. `coflux-stun.service` runs `/opt/coflux-derp/stund -stun :3479 -http 127.0.0.1:3480` (upstream `tailscale.com/cmd/stund`, built from the pinned revision like `derper`; the debug port must stay on loopback — stund's default is `:3479` on every interface). **UDP 3478 on this host belongs to the owner's personal `derper.service` (a Tailscale tailnet DERP on 8443) and must never reappear in `COFLUX_DERP_REGIONS`**: until 2026-09-29 coflux advertised it, so stopping that unrelated service would have dropped every coflux direct path without a signal. Diagnose from any machine with `stunc 49.232.53.23 3479` (build `tailscale.com/cmd/stunc` in `transport/tailcat`; a plain RFC 5389 probe is ignored by Tailscale's STUN server), and on prod-bj with `curl -s 127.0.0.1:3480/debug/varz | grep stun_requests`, whose `success` count grows as coflux devices reconnect.

The mainland machine, prod-bj, hosts only the relay server role and uses the registered domain `yourantiandi.com`. `coflux.dev` has no mainland ICP registration and does not point to mainland IPs.

## prod-jp: center

Connect with `ssh root@prod-jp`. Debian 13, four cores, 7.8GB. **This host is shared with other projects**: Caddyfile also contains `cchost.cc`, `cchost.ai`, `pa.wsq.cool`, and others. Preserve them when editing.

- Source: `/opt/coflux`, **detached HEAD pinned to a tag**. Local main is hundreds of commits behind with no upstream; `git pull` is unsuitable.
- Service: systemd `coflux-server`, running `node --import tsx apps/server/src/index.ts`, bound only to `127.0.0.1:8787`.
- Database: apt-installed PostgreSQL 17, listening only on `127.0.0.1`, database and role both named `coflux`. Daily `/etc/cron.daily/coflux-pg-backup` writes custom-format (`-Fc`) backups to `/var/backups/coflux/`, retaining 14.
- Authentication: `COFLUX_AUTH=password`, self-managed users/scrypt; Supabase is retired. Create users with `DATABASE_URL=... node --import tsx scripts/create-user.mjs --email .. --password ..`.
- The four coflux sites—apex/api/app/m—use the Cloudflare **DNS-01** plugin, like `*.coflux.dev` (since 2026-10-09; between 2026-09-04 and then they used `tls internal` behind owo). DNS-01 issuance does not depend on where the records point, so the origin keeps publicly valid certificates whichever ingress is in front. Backup before the change: `/etc/caddy/Caddyfile.bak-cf-ingress-20261009_112923`.
- **DERP admission** (2026-09-18): `COFLUX_DERP_ADMISSION_TOKEN` in `server.env`, and `api.coflux.dev` carries a `handle /derp-verify*` route to the loopback admission listener on 8793. The relay authenticates with Basic credentials built from that token; the secret is never in a path or a log. This replaced an SSH tunnel from prod-bj — see the outage note under prod-bj. **When this host's address changes, nothing here needs editing**, which is the whole point of the change.
- Version 1.0.0 account CLI uses central `/api/client/login` and `/api/client/command`. Desktop and standalone CLI both depend on them; deploy the center before updating 1.0.0 clients. MCP/dedicated OAuth routes are removed; old tables remain through historical migrations. `COFLUX_PUBLIC_URL=https://api.coflux.dev` still serves device authorization and preview pages. Whole-site API proxying needs no Caddy changes.

## owo-jp-gw: former public ingress and JP relay

**Out of the coflux path since 2026-10-09** (see *Domains and routing*); its Caddy sites are left in place for a switch back. It is unreachable from mainland networks, so `ssh prod-jp` jumps through prod-bj instead of owo.

Connect with `ssh owo-jp-gw`. Debian 13, two cores, same datacenter as prod-jp with 1.4ms RTT. **Nine other sites share this host**, including `zakki.owodns.com`, `cchost.cc`, `open.owo.nz`, and `pir.bannin.app`. Caddy changes affect them too.

- **Three IPs share one interface**: primary `45.94.40.29`; **`45.94.40.233`, the current ingress/relay address**; and old `45.94.40.123`, still returned by `ifconfig.me` and easily mistaken for the active address.
- Caddy **2.6.2 does not support `stream_close_delay`**. Do not copy that directive from prod-jp. Reload therefore disconnects long-lived coflux WebSockets; daemons reconnect automatically.
- **Do not run `caddy add-package` or upgrade the binary**: replacement restarts all nine other sites. The four ingress sites use HTTP-01 with DNS-only challenges reaching this host. Without wildcard certificates here, previews remain proxied through Cloudflare.
- Relay binary: `/opt/coflux-relay/coflux-relay`; systemd service `coflux-relay`; environment `/etc/coflux/relay.env`. **Never enable access logs for relay sites**, whose query strings contain tokens. The four ingress sites may log because daemon tokens travel in WS messages, not URLs; logs are at `/var/log/caddy/coflux-access.log`.

## prod-bj: Beijing relay

Connect with `ssh root@prod-bj`. Ubuntu 24.04, SA3.LARGE8, same service layout as JP relay. Central `COFLUX_RELAY_NODES` **currently assigns only this node**; JP is idle pending removal. Its IP previously suffered GFW interference from mainland networks, where the daemons reside.

The recorded deployment used custom home-relay selection. That source has been removed; follow the native migration runbook before deploying this branch.

This is also the mainland observation point. Test routing from here: local residential connections may be proxied and distort results.

## Server deployment

The center runs a detached checkout of a release tag. Take a database backup before a deployment carrying a schema migration, since the daily cron backup can be hours old:

The centre host is coflux-sh (`root@49.234.42.193`) since 2026-10-09; the commands are unchanged otherwise. Fetching from GitHub and npm works from there but is slower than from Japan.

```sh
ssh root@49.234.42.193 'sudo -u postgres pg_dump -Fc -d coflux > /var/backups/coflux/coflux-predeploy-<tag>-$(date +%Y%m%d-%H%M%S).dump'
ssh root@49.234.42.193 'cd /opt/coflux && git fetch --tags origin; git checkout <tag>'
ssh root@49.234.42.193 'cd /opt/coflux && pnpm install --frozen-lockfile && systemctl restart coflux-server'
```

Run the steps separately rather than chaining them with `&&`. Checking out and installing leaves the running service untouched until the restart, so a failure there costs nothing; and `git fetch --tags` exits non-zero whenever an old tag on this host would be clobbered, which silently skips a chained checkout. Confirm afterwards with `git log --oneline -1`, `systemctl is-active coflux-server`, `curl -sS http://127.0.0.1:8787/health`, and the boot lines in `journalctl -u coflux-server`. Migrations run at boot inside one transaction under an advisory lock; `SELECT version, name FROM coflux.schema_migrations ORDER BY version DESC` shows what applied.

**Deploying a tag that contains the native transport additionally requires the prerequisites above**, because that source sets the control protocol floor to 2 and rejects every older client and worker. Tags predating it deploy normally. Web/mobile assets remain frozen, and their version-1 remote protocol cannot authenticate to the native-transport source.

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

## Sign in with GitHub or Google (plan 20260923)

Provider sign-in is embedded in the center (Better Auth, pinned in `apps/server/package.json`) and exists only with `COFLUX_AUTH=password`. Each provider is enabled independently when its client id is set; with none enabled, every login surface shows the password form alone. Better Auth does the OAuth round trip only: coflux still issues its own session tokens and short page sessions, and the Better Auth session is deleted at handoff.

| Variable | Kind | Meaning |
| --- | --- | --- |
| `COFLUX_GITHUB_CLIENT_ID` / `COFLUX_GITHUB_CLIENT_SECRET` | id: setting; secret: **secret** | GitHub OAuth app. Setting the id enables GitHub; the secret is then required (fail-closed start in production). |
| `COFLUX_GOOGLE_CLIENT_ID` / `COFLUX_GOOGLE_CLIENT_SECRET` | id: setting; secret: **secret** | Google OAuth client (web application). Same rule as GitHub. |
| `COFLUX_AUTH_SECRET` | **secret** | Better Auth signing/encryption secret, at least 32 random characters. Required in production as soon as any provider is enabled. |
| `COFLUX_SIGNUP_ALLOWLIST` | setting | Comma-separated exact addresses and `@domain` entries allowed to **create** a user through a provider, e.g. `owner@example.com,@example.org`. Empty or unset: nobody new. Existing users (same verified email) always sign in and never need to be listed. Changing it means editing `server.env` and restarting. |

Register these callback URLs with the providers, under `COFLUX_PUBLIC_URL`:

- GitHub OAuth app, "Authorization callback URL": `${COFLUX_PUBLIC_URL}/api/auth/callback/github` (production: `https://api.coflux.dev/api/auth/callback/github`).
- Google OAuth client, "Authorized redirect URIs": `${COFLUX_PUBLIC_URL}/api/auth/callback/google`.

**Google only admits the consent screen's listed test users until the OAuth consent screen is published** ("In production"). A sign-in failing for everyone else before that is a console setting, not a code defect.

A provider sign-in is accepted only with a provider-verified email: it lands on the existing user with that email (same account and data), creates a passwordless user and personal account when the email is allowlisted, and is otherwise refused with 「该邮箱未开通 Coflux」.

**Schema migration 7 (`auth_identity`) is one-way.** It adds the `auth_user`, `auth_session`, `auth_account` and `auth_verification` tables and drops `NOT NULL` on `users.password_hash` (provider-created users have no password). An older server cannot run against a migrated database; take the backup described under *Server deployment* before deploying it, and say so in the release notes. Better Auth's runtime migration is never used; a Better Auth upgrade that changes its table shape needs a new coflux migration.

Native clients sign in through `/login/<request>` (desktop app and `coflux login` without flags): loopback redirect with PKCE, or a paste code over SSH. Whole-site API proxying already covers `/api/auth/*` and `/login/*`; no Caddy change is needed.

End-to-end smoke: `scripts/prod-smoke.mjs`, using real DeviceEnvelope traffic through the native helper. It makes production changes and is run only during an authorized smoke test.

## Secrets

Record only locations/types, never values.

| Location | Contents |
| --- | --- |
| coflux-sh `/etc/coflux-derp/admission.env` (600) | DERP verify URL carrying `COFLUX_DERP_ADMISSION_TOKEN` as Basic credentials |
| coflux-sh: the prod-jp rows below, at the same paths | Copied unchanged at the 2026-10-09 cutover (`server.env` with the two URLs above changed). prod-jp keeps its copies; its `cloudflare.env` is still what the forwarder's DNS-01 renewals use. |
| prod-jp `/etc/coflux/server.env` (600) | `DATABASE_URL` with database password; rendezvous signing seed `COFLUX_RELAY_SIGNING_KEY`; when provider sign-in is enabled, `COFLUX_AUTH_SECRET` and the provider client secrets (`COFLUX_GITHUB_CLIENT_SECRET`, `COFLUX_GOOGLE_CLIENT_SECRET`). Required non-secret settings: `COFLUX_PUBLIC_URL=https://api.coflux.dev` and `COFLUX_INBOUND_QUEUE_MAX_MESSAGES=1024`. |
| prod-jp `/etc/coflux/pg-coflux.pass` (600) | PostgreSQL role password |
| prod-jp `/etc/caddy/cloudflare.env` (600) | Cloudflare API token with **DNS edit permission only for the coflux.dev zone**. Reading zone settings such as SSL mode returns `9109 Unauthorized`. |
| Relay nodes `/etc/coflux/relay.env` | `COFLUX_RELAY_PUBKEY`, a non-secret verification public key |

The relay key locations above belong to the pre-migration inventory. Native DERP uses node identities and fail-closed admission; it does not read those signing keys. Retire obsolete credentials during the authorized cutover.

## Rollback

**Ingress routing** (current: Cloudflare proxy → prod-jp, since 2026-10-09): the four origin sites carry DNS-01 certificates, so ingress changes are DNS-only. Edit the four A records with the zone token in prod-jp's `/etc/caddy/cloudflare.env` (run the API calls on prod-jp so the token never leaves it). Proxied origin changes apply almost at once; leaving proxied for DNS-only takes the roughly 300-second TTL, and Surge on the owner's Mac may need `POST /v1/dns/flush`.

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
