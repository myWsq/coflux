# Device-managed agent integration

Coflux supplies agent integration with the native `coflux` CLI on macOS and Linux.
The desktop installer updates `$COFLUX_HOME/bin/coflux` atomically even when the
local daemon remains running. `cofluxd update` downloads and verifies the native CLI
alongside supervisor and worker before replacing the installed files. Old releases
without a CLI artifact remain installable; they do not provide this integration.
Worker-only hot upgrades do not replace the CLI or its integration.

## Launch and update

Supported automatic shell entry points are zsh, bash and fish. `claude` and `codex`
resolve the installed native CLI on every invocation. User functions take
precedence. A self-referencing zsh/bash alias such as `alias codex='codex --yolo'`
keeps its arguments and still reaches the integration; an alias pointing elsewhere
bypasses it. In fish an alias is a function and therefore takes precedence. Custom
shells and dedicated launchers can use:

```sh
coflux agent run claude -- --resume
coflux agent run codex -- resume
coflux agent status
```

The first rollout requires a shell with the new wrapper. Shells already running the
pre-integration wrapper cannot acquire a new function automatically; open a new
terminal or use the explicit launch command. Once the wrapper is installed, an
already-open shell selects subsequent CLI updates on its next agent invocation.
An active agent is never restarted to update integration.

Each launch hashes the full native executable (which embeds the shared skill),
validates or creates an immutable directory under `agent-integrations/<sha256>`, and
pins both hooks and business CLI calls to that directory. Generated manifests,
hooks, executable bytes and the skill are checked before reuse. A damaged bundle
produces an unavailable message and the agent starts normally. The launcher never
modifies a bundle already referenced by another process.

Bundles are deliberately retained, including after exit, so suspended agents and
restored sessions cannot lose files. They can be removed during an explicit device
uninstall, after its agents have stopped. No automatic age-based deletion is used.
Run-status files are local acknowledgement snapshots under `agent-runs`; `status`
reports runs for the current terminal session and marks absent processes exited.
PID liveness is diagnostic, not proof that a reused PID is the original agent.

## Adapters and readiness

Claude uses a session plugin directory with a discoverable skill. Codex uses
session configuration hooks and an absolute pointer to the immutable skill. Both
execute the native CLI directly; no Node or Python interpreter is required on the
device. Python is used only by developer acceptance probes.

The verified native versions are Claude Code 2.1.269 and Codex CLI 0.154.0. Older
versions without these hook/command-line contracts are not supported. New host
versions should run the native acceptance probe before changing this adapter.
Compatibility with a retained local runtime is checked by the existing local
workspace API: successful responses must contain a nonempty workspace identity.
A missing, unreachable or incompatible API never yields a ready acknowledgement or
fabricated coordinates. This integration adds no new server wire-protocol contract.

Codex displays its native review UI when the hook definition needs approval.
Coflux never writes trust hashes or substitutes the user's configuration directory.
The initial message reports an unconfirmed integration and points to `/hooks`.
`coflux agent status` distinguishes unconfirmed, ready, unavailable, ended and
exited snapshots, independently of the agent's activity state. An acknowledgement
means a hook ran and successfully queried the local workspace API. Missing hooks
alone do not establish whether review is pending. If approval happens later,
UserPromptSubmit retries context acquisition and updates readiness.

SessionStart refreshes coordinates, including resume and compact sources. Codex
defers its compact-source SessionStart until immediately before the next model
request, including continuations within a turn. Ordinary
prompts avoid repeating unchanged context. Claude EnterWorktree/ExitWorktree follows
workspace ownership, WorktreeRemove forgets the deleted worktree, and the managed
worktree removal guidance remains enforced. These calls use the same local APIs as
the account CLI's existing integration.

## Explicit workspace entry

`coflux workspace enter <path>` is the host-independent terminal migration command.
Create worktrees with `coflux workspace new`, or select an existing path, then enter
it explicitly. Entry reuses `workspace.locate`; same-repository validation,
registration, server-confirmed ownership and PTY preservation remain unchanged.
The lower-level `workspace locate` command remains available to Claude's native
EnterWorktree/ExitWorktree hooks without recording a Codex selection.

In a managed Codex invocation, entry saves the confirmed absolute workspace path
under `$COFLUX_HOME/agent-workspaces/`, keyed by native conversation ID, device and
project. Run acknowledgements bind CLI commands to the conversation announced by
the native hook. New conversations do not inherit selections, while compaction and
resume restore them even under a new launcher run or Coflux terminal. PostToolUse
and UserPromptSubmit verify the selected workspace and inject changed context;
they never migrate ownership based on command text or a transient tool workdir.
SessionStart revalidates and reattaches the selected path instead of reverting to
the host's original cwd. A missing path or failed validation produces unavailable
context and cannot silently fall back to that original directory.

Entry returns `hostCwdChanged: false`: no child process can change the host's cwd.
The shared skill requires explicit workdir/cwd for subsequent commands, absolute
paths for file tools, and reading the target AGENTS.md before edits. Sandbox
permissions remain controlled by the host. This is an explicit directory contract
with the agent, not transparent rewriting of every host tool. `resumeSupported`
is true only when the managed Codex conversation selection was saved. Outside that
integration, entry still migrates the terminal but does not promise restoration.
The npm entry point delegates this command to the native CLI so selection state
has one implementation.

## Optional and bypassed use

External terminals continue to use optional marketplace installation. Managed
integration does not edit global agent settings. Old Codex plugin management is
outside this mechanism and remains user-owned.

```sh
COFLUX_AGENT_INTEGRATION=off claude
COFLUX_AGENT_INTEGRATION=off codex
```

User-supplied native launch arguments are preserved. An explicit native executable
path or `command claude` / `command codex` bypasses shell functions as usual.

## Validation

```sh
node --test tests/src/agent-integration.test.mjs tests/src/cli-release-trust.test.mjs tests/src/release-sign.test.mjs
python3 tests/acceptance/agent-launch.py
python3 tests/acceptance/agent-hosts.py
python3 tests/acceptance/codex-workspace.py
```

The launcher probe checks an update within one live shell, immutable old files,
argument forwarding and unavailable-bundle fallback. The native-host probe uses
temporary homes and a loopback fake provider: no real credentials, model requests
or global configuration changes. It verifies actual model-input context, native
Codex review, unrelated user-hook coexistence and native session resume with changed
workspace coordinates. Both native compaction flows refresh context, and a changed
Codex delivery requires a new native review. The black-box CLI test separately
exercises delayed acknowledgement recovery and worktree cleanup.
The workspace probe uses a local Responses fixture to make real Codex execute the
entry command, checks the following model request for the selected-directory
context, and resumes the native conversation in another synthetic terminal.
