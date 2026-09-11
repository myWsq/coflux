# Cross-client DeviceRouter behavior traces

`behavior-traces.json` contains DeviceRouter semantic vectors shared by TypeScript `packages/client` and Swift `packages/swift-client`. Each interprets the same event sequence using its real state machine and fake transports, avoiding separately handwritten tests that appear equivalent by name while gradually diverging in their constraints.

The fixtures cover only the relay/session subset genuinely shared by both clients. Web-specific loopback, P2P, transport promotion, and heartbeats remain covered by dedicated TypeScript tests. Do not expand iOS functionality merely to make Swift consume fixtures.

Traces express observable contracts without fixing random `request_id`, `channel_id`, transport generations, retry counts, or wall-clock times. Encode 64-bit sequences as decimal strings to avoid cross-language JSON-number precision differences. Implement new events in both TS and Swift interpreters; increment `schemaVersion` for incompatible changes.
