# Implementation plans

| Plan | Status | Execution | Dependencies |
| --- | --- | --- | --- |
| [Unified desktop lifecycle and device onboarding](20260912-desktop-runtime-lifecycle.md) | DONE: implementation, real-machine acceptance, and follow-up fixes complete | self | None |
| [Unified product version and release entry point](20260912-unified-release-version.md) | IN_PROGRESS | self | Desktop lifecycle plan |
| [Device-managed agent integration](20260912-agent-integration-lifecycle.md) | DONE | self | None |
| [Executor engine and transport](20260912-executor-engine.md) | DONE on `dev/20260912-executor-engine` (relocated from `plans/116-executor-engine.md`; not merged into main, not released; user acceptance on a real machine pending) | subagent opus | None |
| [Reconcile the executor engine branch with main 1.0.0](20260912-executor-reconcile.md) | DONE (merged main up to 5f66e8b; `coflux executor run` on both CLIs; cancellation bound to confirmed runtime stops; SKILL re-grafted at plugin 0.13.0; black-box 213/213 excluding agent-activity; one REVISE round) | subagent opus | Executor engine plan |
