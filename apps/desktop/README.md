# Coflux Desktop

The macOS desktop app for Coflux: Electron, React 19, and xterm.js. This is the primary desktop implementation; earlier native macOS and web implementations are retained only in Git history.

The app requires macOS 26+ on Apple Silicon. It bundles the terminal runtime and a native `coflux` command, so users do not need to install Node.js or a separate CLI.

## Development

Start the local PostgreSQL instance and server from the repository root, then launch the app:

```sh
pnpm dev:pg
pnpm dev:server
# In another terminal:
pnpm -C apps/desktop dev
```

The renderer uses port 5274 for HMR. Its control connection goes directly to `ws://localhost:8787/client`; an available Vite page does not imply that the server is running.

```sh
pnpm -C apps/desktop typecheck
pnpm -C apps/desktop test
pnpm -C apps/desktop build
```

Development data lives under `Coflux-dev`, separate from installed-app credentials and runtime state. Use `COFLUX_DESKTOP_USER_DATA` and `COFLUX_HOME` for isolated acceptance instances.

## Bundling the runtime

Build the native components first:

```sh
cargo build -p coflux-supervisor -p coflux-worker -p coflux-cli
COFLUX_DESKTOP_DAEMON_DIR=../../target/debug pnpm -C apps/desktop run pack
```

Use **`run pack`**, not pnpm's package-archive `pack` command. The result is `dist/mac-arm64/Coflux.app`; available local signing identities determine its development signature. A local build is not a notarized release.

`stage-daemon.mjs` requires an explicit source directory containing `coflux-supervisor`, `coflux-worker`, and `coflux`. It copies them to `build/daemon`, along with the `VERSION` sidecar and the repository's Claude Code plugin. Missing components fail the build.

The version comes from the source directory's `VERSION`, then `COFLUX_DESKTOP_DAEMON_VERSION`, otherwise `dev`. Release builds compile and stage the same `vX.Y.Z` product version. The runtime and plugin are placed outside the ASAR under `Contents/Resources/daemon`.

```sh
# Stage only, including for an unpackaged development app:
pnpm -C apps/desktop run stage-daemon --from ../../target/debug

# Generate distributable artifacts:
COFLUX_DESKTOP_DAEMON_DIR=../../target/debug pnpm -C apps/desktop run dist

# Recompile the Icon Composer asset on macOS with Xcode 26:
pnpm -C apps/desktop run icon
```

`build/AppIcon.icon` is the icon source. The icon command exports `Assets.car` and `AppIcon.icns`; both generated files are committed for CI.

## Runtime lifecycle

The main app owns the local device lifecycle. Signing in prepares and connects the device. The app launches its runtime directly, keeps runtime files in content-addressed directories under `COFLUX_HOME/desktop-runtimes`, and connects through an instance-checked local socket.

- Closing the window keeps the app and device online.
- Fully quitting confirms and ends local terminals.
- Signing out confirms, ends local terminals, clears local credentials and terminal data, and reconciles remote cleanup. Project files and other devices are preserved.
- Installing an app update reconnects to the existing runtime. The CLI can be replaced independently.
- Restarting the terminal-holding Supervisor ends its processes. Runtime updates can be deferred until tasks finish.

Full Disk Access guidance targets **Coflux.app**. Runtime binaries retain their application signature rather than receiving a separate ad-hoc identity during installation. A legacy LaunchAgent migration requires an explicit user action; it must not silently interrupt existing terminals.

The app's `client.sock` lets the bundled `coflux` reuse the signed-in account without returning the session credential. Terminal shells receive the CLI through PATH and the bundled Claude Code plugin through `COFLUX_CLAUDE_PLUGIN_DIR`.

## Application structure

| Path | Role |
| --- | --- |
| `src/main` | Electron lifecycle, native capabilities, runtime management, and updates |
| `src/preload` | Sandboxed IPC bridge |
| `src/renderer` | React/xterm workbench; `@` resolves here |
| `src/shared/desktop-bridge.ts` | Typed `window.cofluxDesktop` contract |
| `test/config.test.ts` | Packaging and release configuration constraints |

The renderer expects the desktop bridge to exist. It has no browser fallback. Device authorization and port-preview access pages are served by `apps/server` and opened in the system browser.

## Security and configuration

- Packaged UI assets are served from `coflux-app://app/`, not a remote URL. Keep the renderer's absolute base and CSP intact.
- Enable sandboxing and context isolation; keep Node integration disabled. Validate IPC sender origins and payloads. The bridge exposes no general filesystem or shell API.
- The main process sets WebSocket Origin to `https://desktop.coflux.dev`. This value participates in local grants; changing it invalidates those grants.
- Session tokens are encrypted with Electron `safeStorage` in `userData/session-token.bin`. Encryption or decryption failure falls back to a signed-out state, never plaintext storage.
- Server address precedence is `--server=`, `COFLUX_SERVER_URL`, app `settings.json`, then the packaged or development default.
- Window bounds are stored in `userData/window-state.json`. Main-process and updater logs are in `~/Library/Logs/Coflux/main.log`.
- Client admission uses the control protocol version. A server deployment does not require an identical desktop build SHA.

Renderer dependencies are bundled by Vite and normally belong in `devDependencies`. External main-process dependencies such as `electron-updater` and `electron-log` belong in `dependencies` so they are included in the ASAR.

## Releases

The unified `vX.Y.Z` workflow calls `desktop-release.yml` to build, Developer ID sign, notarize, and verify the app. Desktop and runtime artifacts are published to the same GitHub release before the stable `desktop-updates` feed advances. See [RELEASING.md](../../docs/RELEASING.md).

Read [design guidelines](../../docs/design-guidelines.md) before changing UI behavior and [architecture](../../docs/architecture.md) before changing runtime ownership.
