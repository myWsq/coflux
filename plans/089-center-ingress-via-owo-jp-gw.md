# Plan 089: Remove Cloudflare proxying from center ingress and reverse-proxy through owo-jp-gw

> This plan is an outcome contract, not a step-by-step script. Understand requirements and decisions, then design against live code. Validate milestones only if also the verifier; delegated executors implement with verification outside their sessions. Stop on any STOP condition. Update plans/README.md when complete.
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

The user reported a slow center. Measured cause: api/app/m/*.coflux.dev all use Cloudflare's proxied records; free CF has no China nodes, so requests leave China for CF edges then return to Japan prod-jp. Its 82.40.34.55 address is also affected as recorded in [[gfw-blocked-home-line]]. From prod-bj, app TTFB is **1.598 s**, api **1.637 s**, versus **0.034 s** for directly reachable domestic relay-bj.

Outcomes:

1. api/app/m/coflux.dev resolve from China to 45.94.40.233, owo-jp-gw, using DNS-only records. Its Caddy reverse-proxies to prod-jp 82.40.34.55 in the same datacenter, measured RTT 1.4 ms.
2. Center itself unchanged: /opt/coflux, PG17, coflux-server systemd, /etc/coflux/server.env; no source diff.
3. No client changes to eighteen enrolled devices' settings.json or iOS because domains stay the same.
4. Observable domestic TTFB reduction against 1.6 s, all daemons reconnect, WS upgrades work.
5. Preserve owo's nine existing sites and prod-jp wildcard previews.

Incorrect solutions:
- Move center to prod-bj, explicitly rejected because the user does not want an unregistered coflux.dev domain directly on Tencent Cloud's mainland IP.
- Change wildcard *.coflux.dev or point it to owo; previews must stay proxied to prod-jp.
- Upgrade owo Caddy for stream_close_delay or DNS-01 wildcard certificates.
- Change CLI/iOS domains, defeating the core benefit.
- Copy web/mobile static assets to owo as a CDN, adding deploy synchronization to save only 1.4 ms.

## Decisions & tradeoffs

- **Ingress owo-jp-gw 45.94.40.233, center stays prod-jp.** Rejected: prod-bj center is fastest at 3.6 ms but violates user's mainland-domain choice and requires PG migration/PGDG setup/eighteen-device risk. Rejected: center on owo's two-core machine already hosting nine sites, relay, Docker, to save one 1.4 ms hop. Evidence: owo→82.40.34.55 connection 0.0015 s, ping average 1.399 ms.
- **Create three independent DNS-only A records api/app/m, not modify four existing records.** Those names currently inherit wildcard *.coflux.dev A 82.40.34.55 proxied=true. Specific records override wildcard. Modify the existing apex content/proxied fields. Rejected: moving wildcard would move {shortId}-p previews to a host lacking wildcard certificate capability. CF currently lists only wildcard/apex/www/relay/relay-jp A records. Benefit: rollback deletes three new records and wildcard automatically resumes.
- **HTTPS origin is mandatory**: reverse_proxy https://82.40.34.55, header_up Host {host}, and transport http with tls_server_name {host} and tls_insecure_skip_verify. Tokens must not travel plaintext even within the datacenter. Skip verification is needed for backend internal certificates. **SNI hostname is also mandatory, added during execution**: IP upstream defaults SNI to IP, unmatched by prod-jp Caddy, causing handshake failure/502. curl -k with only Host m.coflux.dev returned 000; curl --resolve m.coflux.dev:443:82.40.34.55 returned 200. HTTP Host cannot set TLS SNI. Rejected: HTTP plaintext; direct :8787 is loopback-only and cannot serve app/m static SPAs, which use Caddy file_server under /opt/coflux/apps/web/dist. Evidence: ss and prod-jp Caddyfile:60-94.
- **Use tls internal on prod-jp's four named sites.** After DNS-only cutover, ACME HTTP-01 reaches owo, so prod-jp renewal would continuously fail. Internal certificates plus upstream skip-verify close that loop. **Wildcard previews retain existing Cloudflare DNS-01 exactly unchanged.** Rejected: forwarding ACME challenges to backend creates a permanent exception for certificates backend no longer needs. Evidence: named sites at Caddyfile:48,53,60,95 currently default ACME; wildcard :116 explicitly uses Cloudflare DNS.
- **Owo uses HTTP-01; never change its Caddy binary.** DNS-only directs challenges there without plugins. Caddy 2.6.2 serves zakki.owodns.com, cdn77.owodns.com, cchost.cc, relay.coflux.dev/relay-jp.coflux.dev, open.owo.nz, suon.owo.nz, cdn.cchost.cc, pir.bannin.app, gateway.bannin.app. add-package/upgrades replace binary and restart all nine. User explicitly rejected upgrading to 2.11/Cloudflare plugin for delay/wildcard support.
- **No stream_close_delay in owo config.** 2.6.2 validation reports unrecognized subdirective. Accepted cost: each Caddy reload drops Coflux WS connections; clients/daemons reconnect.
- **Access logging allowed only for the four new sites; relay logging prohibition remains.** Daemon connect_async uses the configured URL unchanged and sends tokens later in protobuf; relay extracts token from query. Evidence: worker main.rs:1092,474 versus relay main.rs:248-250.
- **Planning decision: pilot m.coflux.dev first, then api/app/apex.** HTTP-01 cannot sign before DNS points to owo, so each domain has an unavoidable tens-of-seconds HTTPS gap. Frozen mobile has no affected users and tests DNS→issuance→proxy→200/101 end-to-end before critical domains. Rejected: copied backend PEM creates manually managed 90-day certificates conflicting with renewals; all-at-once cutover risks the critical domains on the first learning attempt.

## Direction

Roles: CF DNS switches records; owo appends ingress sites; prod-jp adjusts backend certificates; prod-bj only measures domestic performance without changes.

Original direction prepared backend before DNS, then accepted the cutover to avoid backend certificate trouble.

> **Execution order correction, implemented 2026-09-04**: changing all four backend sites to tls internal first is unsafe while still proxied: Full (strict) CF rejects self-signed origins with 526. The token in /etc/caddy/cloudflare.env only edits DNS; reading zone settings returns 9109 Unauthorized, so this assumption cannot be verified. Instead complete each domain end-to-end: add owo site → DNS-only cutover → HTTP-01 issuance → verify → set that backend site tls internal. Internal certificates are introduced only after leaving CF, eliminating the SSL-mode assumption without changing decisions.

### Milestone 1: Four backend sites accept origin traffic

Original milestone: set tls internal for apex/api/app/m, leaving wildcard previews and unrelated dash.cchost.cc/cchost.ai/pa.wsq.cool sites untouched. While still proxied this only preserves behavior with non-strict Full; see the execution correction above and STOP for 525.
Validation: prod-jp caddy validate exits 0; after reload app curl remains 200.

### Milestone 2: Append four owo sites

Append sites proxying HTTPS to 82.40.34.55 with Host preserved. Apex retains 301 to app. Before DNS cutover they receive neither traffic nor successful issuance, as expected.
Validation: owo caddy validate exits 0, proving no unsupported 2.6.2 directives; all existing sites survive reload.

### Milestone 3: Pilot m.coflux.dev

Create A 45.94.40.233 with proxied=false; await HTTP-01.
Validation: HTTPS 200 and domestic TTFB clearly below 1.6 s. Failure deletes record for wildcard rollback, then STOP.

### Milestone 4: api/app/apex

Create api/app DNS-only A records to .233; modify apex content and proxied=false. Leave wildcard/www.
Validation: four domains' expected 200/301 responses, WS 101, daemon reconnections in center logs.

### Milestone 5: Acceptance and observation

Compare domestic TTFB, verify existing sites/all daemons/no certificate errors, and record results here/index. If gains disappoint, report numbers and let the user decide rollback per Maintenance notes.

## Landmines

- api/app/m currently have no independent records; wildcard edits would redirect previews too.
- HTTP-01 cannot pre-sign before DNS moves, requiring the pilot and brief HTTPS gap.
- Owo has three IPs on one NIC: .29 primary, **.233 chosen/current SSH and relay**, .123 old but still default egress reported by ifconfig.me. [[relay-nodes]]'s .123 ingress memory is stale.
- Apex must have a certificate even for a 301, or origin SNI fails with 525. Backend Caddyfile:45-47 records this, matching origin.cchost.cc's 2026-08-10 issue.
- Never copy stream_close_delay to Caddy 2.6.2.
- GRE 10.0.0.2↔10.0.0.1 does not reach prod-jp, which has only loopback/public IP; origin uses public network.
- Never add relay access logs: query contains tokens.
- Force HTTP/1.1 for WS tests; h2 would falsely return 404.
- Existing proxied www has no dedicated backend block and falls into wildcard preview handling. Leave this unrelated condition unchanged.

## Scope

In scope:
- Four prod-jp named-site tls directives at Caddyfile:48/53/60/95
- Four appended owo site blocks
- Three new CF A records and apex modification
- This plan and index

Out of scope:
- Center source/PG/systemd/env, no server restart or web rebuild
- Repository source, including unchanged CLI/iOS domain constants
- Wildcard record and backend preview block at :116
- www
- Owo binary and nine existing blocks
- Prod-bj changes, observer only
- Eighteen device settings and iOS release

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Backend config | `ssh root@prod-jp 'caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile'` | exit 0 |
| Ingress config | `ssh owo-jp-gw 'caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile'` | exit 0 |
| Domain acceptance | `for h in coflux.dev api.coflux.dev app.coflux.dev m.coflux.dev; do curl -sS -o /dev/null -w "$h %{http_code}\n" https://$h/; done` | app/m 200; api 404, no root route; apex 301 |
| WS acceptance | `curl -i --http1.1 -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" https://app.coflux.dev/client` | 101 Switching Protocols |
| Domestic TTFB | `ssh root@prod-bj 'curl -sS -o /dev/null -w "ttfb=%{time_starttransfer}\n" https://app.coflux.dev/'` | Clearly below 1.598 s |
| Existing sites | `ssh owo-jp-gw 'for u in https://cchost.cc/ https://relay.coflux.dev/ https://zakki.owodns.com/ https://cdn.cchost.cc/; do curl -sS -o /dev/null -w "$u %{http_code}\n" $u; done'` | Matches baseline |
| Daemon reconnect | `ssh root@prod-jp 'journalctl -u coflux-server --since "10 min ago" \| grep -c "daemon authed"'` | Positive count, no repeated reconnects |
| Preview unaffected | `dig +short web-3000-p.coflux.dev @1.1.1.1` | CF Anycast |

## Done criteria

- [ ] Both Caddy validations exit 0.
- [ ] `api`/`app`/`m`/`coflux.dev` resolve from mainland China to `45.94.40.233`, with valid HTTPS certificates.
- [ ] Measured TTFB recorded against 1.598 s baseline.
- [ ] WS 101; daemons reconnect without recurring churn.
- [ ] Nine existing sites/wildcard previews unchanged.
- [ ] `git status --porcelain` contains only files under `plans/`; this plan produces no source diff.
- [ ] Center not restarted; /opt/coflux untouched.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- Pilot issuance/502/performance failure: delete new m record, report, stop before api/app.
- 525 origin SNI failure after cutover: certificate/origin combination invalid, rollback/report.
- Any existing owo site becomes unreachable after reload.
- Progress requires binary/wildcard/source changes.
- Cited facts change, especially DNS structure, loopback-only 8787, or unsupported stream_close_delay.
- Validation fails twice after one reasonable fix.

## Implemented results (2026-09-04)

Contemporaneous domestic prod-bj measurements:

| Domain | Path | TTFB |
| --- | --- | --- |
| app.coflux.dev | DNS-only → owo → prod-jp | 0.193 / 0.268 / 0.272 s |
| api.coflux.dev | Same | 0.178 / 0.191 / 0.279 / 0.292 s |
| m.coflux.dev | Same | 0.180 / 0.194 / 0.272 / 0.291 s |
| www.coflux.dev | Still proxied, control group | 1.712 / 1.852 / 2.138 s |

App baseline 1.598 s became about 0.27 s, recorded as **roughly sevenfold**. Both /client and /daemon upgraded with 101. Owo access logs confirm all four domains traversed it: app 208, apex 105, m 98, api 88 requests including SPA assets.

Two preexisting unrelated observations, left untouched:
- cchost.cc/cdn.cchost.cc fail DNS resolution from owo and prod-bj. They belong to another zone outside this token's permission, unrelated to this change.
- Another account's Echoo-Mac-mini reconnects every one to two minutes since 20:43, before any change. This account's Bytedance Work/Devbox show no recurring reconnects afterward.

## Maintenance notes

- **Rollback**, subject to roughly five-minute DNS TTL rather than proxied near-instant origin changes: delete three new api/app/m records for wildcard fallback; apex returns to 82.40.34.55 proxied=true; remove four backend tls internal directives to restore public ACME.
- **Renewal depends on DNS-only**: moving the four names back behind CF causes owo HTTP-01 renewal to fail after about sixty days.
- **Lost protections**: no CF DDoS protection/IP hiding, .233 exposed; every owo Caddy reload drops WS.
- **Performance uncertainty**: initial credible domestic connection samples to .233 were highly variable, 0.431/0.396/0.149 s. Few Tencent Cloud samples do not equal residential experience. Re-measure this hop first if experience worsens.
- [[relay-nodes]]'s Japan .123 and [[prod-server]]'s DNS A→82.40.34.55 notes are stale and should be updated after this plan.
