# Implementation plans

| Plan | Status | Execution | Dependencies |
| --- | --- | --- | --- |
| [Unified desktop lifecycle and device onboarding](20260912-desktop-runtime-lifecycle.md) | DONE: implementation, real-machine acceptance, and follow-up fixes complete | self | None |
| [Unified product version and release entry point](20260912-unified-release-version.md) | IN_PROGRESS | self | Desktop lifecycle plan |
| [Device-managed agent integration](20260912-agent-integration-lifecycle.md) | DONE | self | None |
| [Interactive-only terminals with do-script semantics](20260912-interactive-terminal-model.md) | DONE on `dev/20260912-interactive-terminal-model` (not merged, not released); real-machine acceptance with a packaged daemon is pending the user | subagent fable | None; a later plan covers notify targeting a terminal and desktop tab landing |
