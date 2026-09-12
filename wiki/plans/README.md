# Implementation plans

| Plan | Status | Execution | Dependencies |
| --- | --- | --- | --- |
| [Durable account notifications](20260912-notification-inbox.md) | DONE | subagent | None |
| [Unified desktop lifecycle and device onboarding](20260912-desktop-runtime-lifecycle.md) | DONE: implementation, real-machine acceptance, and follow-up fixes complete | self | None |
| [Unified product version and release entry point](20260912-unified-release-version.md) | IN_PROGRESS | self | Desktop lifecycle plan |
| [Device-managed agent integration](20260912-agent-integration-lifecycle.md) | DONE | self | None |
| [Replace custom remote networking with Tailcat](20260912-tailcat-transport.md) | IMPLEMENTED: default migration verified; release acceptance gaps remain | subagent | None; sequential transport, integration, delivery, and acceptance milestones |
| [Interactive-only terminals with do-script semantics](20260912-interactive-terminal-model.md) | DONE, merged into main (2026-09-12); real-machine acceptance with a packaged daemon is pending the user | subagent fable | None; a later plan covers notify targeting a terminal and desktop tab landing |
| [Executor engine and transport](20260912-executor-engine.md) | DONE, merged into main (2026-09-12); not released; user acceptance on a real machine pending | subagent opus | None |
| [Reconcile the executor engine branch with main 1.0.0](20260912-executor-reconcile.md) | DONE, merged into main (2026-09-12): `coflux executor run` on both CLIs; cancellation bound to confirmed runtime stops; SKILL re-grafted at plugin 0.15.0 | subagent opus | Executor engine plan |
