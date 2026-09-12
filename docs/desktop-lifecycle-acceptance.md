# Isolated desktop lifecycle acceptance

Passing automation does not establish that permissions, native confirmation dialogs, and real updates work in the signed desktop app. Record evidence for each separately.

## Account cleanup and network recovery

```sh
cargo build -p coflux-supervisor -p coflux-worker -p coflux-relay
node --import tsx scripts/verify-desktop-account-lifecycle.mjs
```

The script uses the harness to create a temporary database, two real daemons, and temporary directories. The center listens on 8878; override it with `COFLUX_ACCOUNT_ACCEPTANCE_PORT`. Binary paths accept the same overrides as black-box tests: `COFLUX_SUPERVISOR_BIN`, `COFLUX_WORKER_BIN`, and `COFLUX_RELAY_BIN`.

It verifies real WebSocket account control, offline local cleanup, outbox retries after recreating components, old-token revocation, and preservation of another device's live terminals and project files. It assembles desktop account components directly and uses a storage test double. Consequently, it is not part of the `tests/src` black-box suite and does not replace GUI logout confirmation or safeStorage acceptance.

## Signed app and real updates

1. Prepare a local test center, temporary database and account, and separate `COFLUX_HOME` and `COFLUX_DESKTOP_USER_DATA` directories. Point the latter's `settings.json` at the test center.
2. Copy two apps from build artifacts and use a separate test bundle ID, such as `dev.coflux.acceptance`. Keep the same signing identity for old and new versions. Do not overwrite `/Applications/Coflux.app`. Keep both `CFBundleName` and the package's `productName` as `Coflux`; otherwise Electron cannot find its Helper.
3. Set `LSEnvironment` in both apps' `Info.plist` to the isolated directories so updater restarts retain isolation. After modifying asar, update `ElectronAsarIntegrity`; after signing, run `codesign --verify --deep --strict`. Record local Apple Development verification separately from Developer ID notarization.
4. Configure a local generic feed in `Contents/Resources/app-update.yml` with a separate `updaterCacheDirName`. Package the new version using `ditto -c -k --sequesterRsrc --keepParent`. The version, ZIP filename, size, and SHA-512 in `latest-mac.yml` must match the actual artifact. Bind the HTTP server only to `127.0.0.1` and expose only the test manifest and ZIP.
5. Launch the old app through LaunchServices. Do not infer permission ownership by spawning its main executable directly: that may inherit the launching terminal's TCC responsibility. Pass the isolated environment explicitly and do not change `HOME`:

   ```sh
   open -n -a "$ACCEPTANCE_APP" \
     --env "COFLUX_HOME=$ACCEPTANCE_HOME" \
     --env "COFLUX_DESKTOP_USER_DATA=$ACCEPTANCE_USER_DATA" \
     --env COFLUX_LOCAL_GATEWAY_PORT=0
   ```

6. Log in, create a terminal, and run:

   ```sh
   COFLUX_CHECK=preserved
   printf 'BEFORE=%s PID=%s\n' "$COFLUX_CHECK" "$$"
   ```

   Record `runtime.sock` status: instanceId, runtimeId, sessionId, taskId, and PID. Accumulate the UDS response through a newline before parsing; the first data event need not contain complete JSON.
7. Publish the new manifest to the test feed, wait for the built-in updater to download it, and click Update in the app. Confirm that Squirrel replaced and restarted the app, the running version changed, and userData still points to the test directory. Print the variable and PID again in the same terminal; both must match their pre-update values. Compare runtime status as well. A forced restart, reattach, or visible terminal history alone does not establish a successful real update.

## Windows, quit, logout, and permissions

- Click the window's red close button: the app, runtime, and shell must stay alive. Reopening through the Dock/LaunchServices must allow continued input. `Cmd+W` closes a terminal tab and cannot substitute for the window-close test.
- With a live terminal, press `Cmd+Q`: canceling preserves the variable/PID; confirming ends the app, runtime, and terminals.
- With a live terminal, choose Log Out in the account menu: canceling leaves it running; confirming returns to login, removes local terminals and plaintext credentials, cleans up this device's cloud terminal records, and invalidates the old session without affecting other devices. Record logout without live terminals separately.
- Grant Full Disk Access only to the test `.app`; do not add the supervisor or substitute the real installation. Run `/bin/ls "$HOME/Library/Safari" >/dev/null` in an actual terminal and record only its exit code. Verify before authorization, after authorization, and after updating. TCC logs for other services, such as ScreenCapture/AppleEvents, do not establish terminal Full Disk Access ownership.
- If automation returns only menu AX nodes without a screenshot and clicking produces no state change, record the action as unverified and complete it through actual UI interaction. Do not assume the click succeeded or conclude that the app failed.

## Cleanup

First send stop to the exact instanceId through the isolated `runtime.sock`, then stop the test app, feed, and center, letting the harness remove its temporary database. Confirm that no process still uses the temporary app before deleting directories.

Remove only this test's separate updater/ShipIt caches. Leave production app caches, real services, and other workspaces untouched. If retaining an environment for the user's permission acceptance, explicitly record which test instances remain running rather than claiming cleanup is complete.
