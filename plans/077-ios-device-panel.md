# Plan 077: iOS device panel — fleet connection path, latency, and version at a glance

> Rapid iteration mode (user: “implement one version first, then review the result”): this document records the reserved number and decisions. The complete design is in the session output (information architecture, wireframes, and specification mapping). Execution = self-execution in this session; supplement as needed after real-device acceptance.

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none (consumes the DevicePing protocol from 076 and relay-node information from 065; both are already live)
- Category: feature
- Execution: self
- Planned at: `63753ba`, 2026-08-16

## Requirement

The iOS app currently shows only one 7px online dot beside the project header. The fleet’s connection path (relay node), RTT, and worker/supervisor versions are completely hidden. Add a device page that brings the information set from the web sidebar tooltip to iOS, with this priority: health (online + RTT) → path (transport + node) → version → identity (host/platform).

## Decisions & tradeoffs (design finalized + user approved defaults)

- **One entry, one page**: add a device button (`macbook.and.iphone`) to the left of the account in the home toolbar and push `DevicesView`. There is no detail page (the fleet has only a few devices; three lines contain everything and the page should be scannable).
- **Three lines per row**: name + status dot + monospaced RTT / host·platform / transport badge + version (mono). Offline devices use a hollow ring and 72% opacity for the whole row; the third line becomes “Offline · last known version”. Do not show offline duration (it would require `last-seen` from the server and is not worth a protocol change for one gray line of text).
- **No new visual tokens**: reuse all Theme tokens (aligned with web in 051); transport icons use the same three-part vocabulary as web (`bolt`/`dot.radiowaves`/`cloud`), with shape representing the path and color representing latency; RTT buckets match web’s 200ms threshold.
- **Measure RTT only while the device page is visible** (the same concept as web `measureOnly`): add `retainMeasure` to `DeviceRouter`, and include `measureCount` in `sessionLaneDemand` (otherwise the lane is released as idle between pings and each round repeats rendezvous). Stop when the page disappears; do not consume power continuously. Ping uses the existing request/response ledger (`DevicePing`/`Pong`, protocol 076 is already in place), every 10s with a 5s timeout.
- **Relay node**: store the rendezvous URL host from `openRelayChannel` and report the route on activation (same source as web `relayHost`); the badge shows the first host segment (`relay-bj`).
- **Out of scope**: iOS P2P transport (a separate WebRTC.framework project; the UI enum is already reserved), device-management actions, and an “up to date” badge.

## Scope

In: `apps/ios/Coflux/Views/DevicesView.swift` (new), `WorkspaceListView.swift` (toolbar), `Client/DeviceRouter.swift` (`retainMeasure`/ping/`relayHost`), `Client/CofluxClient.swift` (`deviceTransports` state + wiring).

Out: everything in proto/server/daemon/web/mobile; adding test files to the xcodeproj (same reason as 071).

## Done criteria

- `xcodebuild` succeeds; existing `CofluxTests` has no regression.
- The device page displays all online/offline devices with four levels of information; RTT and the relay node light up while the page is visible.
- Real-device acceptance awaits the user (the usual no-frontend-verification convention).
