import assert from "node:assert/strict";
import { test } from "node:test";

import {
  authorizeTokenFromUrl,
  buildDaemonSettings,
  daemonServerUrl,
  daemonSettingsJson,
  launchAgentPlist,
  parseCredentialsDaemonId,
  parsePendingAuth,
} from "./daemon-files";
import { daemonHomePaths, resolveCofluxHome } from "./daemon-paths";

const HOME_DIR = "/Users/alice";

test("路径：默认 ~/.coflux；COFLUX_HOME 设了就尊重；plist 固定在 ~/Library/LaunchAgents", () => {
  assert.equal(resolveCofluxHome({}, HOME_DIR), "/Users/alice/.coflux");
  assert.equal(resolveCofluxHome({ COFLUX_HOME: "/tmp/cf" }, HOME_DIR), "/tmp/cf");
  assert.equal(resolveCofluxHome({ COFLUX_HOME: "  " }, HOME_DIR), "/Users/alice/.coflux");
  const paths = daemonHomePaths(HOME_DIR, { COFLUX_HOME: "/tmp/cf" });
  assert.equal(paths.binDir, "/tmp/cf/bin");
  assert.equal(paths.supervisorBin, "/tmp/cf/bin/coflux-supervisor");
  assert.equal(paths.workerBin, "/tmp/cf/bin/coflux-worker");
  assert.equal(paths.cliBin, "/tmp/cf/bin/cofluxd");
  assert.equal(paths.settings, "/tmp/cf/settings.json");
  assert.equal(paths.logFile, "/tmp/cf/daemon.log");
  assert.equal(paths.credentials, "/tmp/cf/credentials.json");
  assert.equal(paths.pendingAuth, "/tmp/cf/pending-auth.json");
  assert.equal(paths.fdaStatus, "/tmp/cf/fda-status");
  assert.equal(paths.supervisorVersion, "/tmp/cf/supervisor-version");
  assert.equal(paths.plist, "/Users/alice/Library/LaunchAgents/com.coflux.daemon.plist");
});

test("LaunchAgent plist 与 cofluxd.mjs 的 plistXml 逐字同构", () => {
  const paths = daemonHomePaths(HOME_DIR, {});
  const expected = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.coflux.daemon</string>
  <key>ProgramArguments</key>
  <array><string>/Users/alice/.coflux/bin/coflux-supervisor</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>COFLUX_HOME</key><string>/Users/alice/.coflux</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/alice/.coflux/daemon.log</string>
  <key>StandardErrorPath</key><string>/Users/alice/.coflux/daemon.log</string>
</dict>
</plist>
`;
  assert.equal(launchAgentPlist(paths), expected);
});

test("daemon 地址跟随 app：/client 换 /daemon，其他路径直接落 /daemon，去掉 query", () => {
  assert.equal(daemonServerUrl("wss://api.coflux.dev/client"), "wss://api.coflux.dev/daemon");
  assert.equal(daemonServerUrl("ws://localhost:8787/client"), "ws://localhost:8787/daemon");
  assert.equal(daemonServerUrl("wss://self.example/prefix/client"), "wss://self.example/prefix/daemon");
  assert.equal(daemonServerUrl("wss://self.example/?x=1"), "wss://self.example/daemon");
});

test("settings.json 照 applyConfig：serverUrl 跟随 app、deviceName 沿用旧值否则 hostname、shell 只在有时保留", () => {
  const fresh = buildDaemonSettings(null, { serverUrl: "wss://api.coflux.dev/daemon", hostname: "mbp.local" });
  assert.deepEqual(fresh, { serverUrl: "wss://api.coflux.dev/daemon", deviceName: "mbp.local" });
  const kept = buildDaemonSettings(
    { serverUrl: "wss://old.example/daemon", deviceName: "家里的 MBP", shell: "/bin/zsh", junk: 1 },
    { serverUrl: "wss://api.coflux.dev/daemon", hostname: "mbp.local" },
  );
  assert.deepEqual(kept, { serverUrl: "wss://api.coflux.dev/daemon", deviceName: "家里的 MBP", shell: "/bin/zsh" });
  assert.equal(buildDaemonSettings({ deviceName: "  " }, { serverUrl: "x", hostname: "h" }).deviceName, "h");
  assert.equal(daemonSettingsJson(fresh), `{\n  "serverUrl": "wss://api.coflux.dev/daemon",\n  "deviceName": "mbp.local"\n}\n`);
});

test("pending-auth.json → 只取授权链接里的 token（encodeURIComponent 还原）与过期时刻", () => {
  assert.equal(authorizeTokenFromUrl("https://api.coflux.dev/authorize/abc.DEF-123"), "abc.DEF-123");
  assert.equal(authorizeTokenFromUrl("https://api.coflux.dev/authorize/a%2Fb"), "a/b");
  assert.equal(authorizeTokenFromUrl("https://api.coflux.dev/authorize/tok/"), "tok");
  assert.equal(authorizeTokenFromUrl("https://api.coflux.dev/authorize/"), null);
  assert.equal(authorizeTokenFromUrl("https://api.coflux.dev/other/tok"), null);
  assert.equal(authorizeTokenFromUrl("not a url"), null);

  assert.deepEqual(parsePendingAuth(JSON.stringify({ url: "https://api.coflux.dev/authorize/tok", expiresAt: 1_700_000_000_000 })), {
    token: "tok",
    expiresAt: 1_700_000_000_000,
  });
  assert.deepEqual(parsePendingAuth(JSON.stringify({ url: "https://api.coflux.dev/authorize/tok" })), { token: "tok" });
  assert.equal(parsePendingAuth(JSON.stringify({ url: "https://api.coflux.dev/", expiresAt: 1 })), null);
  assert.equal(parsePendingAuth(JSON.stringify({ expiresAt: 1 })), null);
  assert.equal(parsePendingAuth("{not json"), null);
  assert.equal(parsePendingAuth(null), null);
  assert.equal(parsePendingAuth("[]"), null);
});

test("credentials.json 只取 daemonId，deviceToken 不出函数", () => {
  const text = JSON.stringify({ serverUrl: "wss://api.coflux.dev/daemon", daemonId: "d-1", deviceToken: "secret" });
  assert.equal(parseCredentialsDaemonId(text), "d-1");
  assert.equal(parseCredentialsDaemonId(JSON.stringify({ deviceToken: "secret" })), null);
  assert.equal(parseCredentialsDaemonId("garbage"), null);
  assert.equal(parseCredentialsDaemonId(null), null);
});

