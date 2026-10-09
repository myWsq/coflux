/**
 * daemon 自动热更新编排（plan 015；plan 20261002-runtime-launcher-merge）。
 *
 * server 轮询 GitHub `/releases/latest`（天然排除 prerelease/draft）取最新 stable 版本号 +
 * 该 release 的 manifest.json 资产。两种 schema 都认：schema 3 带 `runtime` 组件（无 raw
 * signature），只推给宣告 launcher 能力的 daemon；schema 2 带 `worker` 组件（含 legacy raw
 * signature），只推给**没有** launcher 能力的 daemon——否则回退到 schema 2 的 latest 会把 worker
 * 产物砸向 launcher daemon 直到尝试上限。桌面托管的 daemon 两者都不推。
 * 对每台在线 daemon：握手上报的 (workerVersion, platform, arch) 不等于最新版本、且非空、且能映射到
 * manifest 里的某个 target 时，复用 hub 现有 workerUpgrade 下发路径推送升级——不做 semver 比较（见
 * plans/015 决策：不等即推）。daemon 侧的下载/验签/probation/回滚语义由 runtime/launcher 负责。
 *
 * 触发时机：daemon 握手完成时对该台 daemon 比对一次；每次轮询到 release 数据后对全部在线 daemon
 * sweep 一次。失败退避：按 (daemonId, version) 累计推送次数，达到 maxAttempts 后永久封顶；目标
 * 版本变化或 server 重启才会重新获得配额（纯内存态，见 plan 079）。
 */
import { createLogger } from "@coflux/core";
import { config } from "./config.js";
import type { Hub } from "./hub.js";

const log = createLogger("auto-update");

interface ManifestWorkerEntry {
  url: string;
  sha256: string;
  /** Legacy raw-binary signature: present for schema 2 workers only; empty for a runtime. */
  signature: string;
  target: string;
  size: number;
  releaseSignature: string;
  transport?: { url: string; sha256: string; size: bigint; releaseSignature: string };
}
/** Which daemons a parsed manifest may be pushed to. */
export type ReleaseComponent = "worker" | "runtime";
interface LatestRelease {
  version: string;
  component: ReleaseComponent;
  workers: Record<string, ManifestWorkerEntry>;
}

const STRICT_RELEASE_VERSION = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const SHA256_HEX = /^[0-9a-f]{64}$/i;
const ED25519_SIGNATURE_HEX = /^[0-9a-f]{128}$/i;
const MAX_WORKER_BYTES = 128 * 1024 * 1024;

function isStrictReleaseVersion(version: string): boolean {
  const match = STRICT_RELEASE_VERSION.exec(version);
  if (!match) return false;
  return !(match[4] ?? "").split(".").some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"));
}

/**
 * Parse the pushable component of a manifest: schema 2 → `worker` (raw signature required),
 * schema 3 → `runtime` (no raw signature). Anything else is not a release the centre pushes.
 */
export function parseManifestRelease(manifest: unknown, tag: string): { component: ReleaseComponent; entries: Record<string, ManifestWorkerEntry> } | undefined {
  if (!isStrictReleaseVersion(tag)) return undefined;
  if (!manifest || typeof manifest !== "object") return undefined;
  const value = manifest as { schemaVersion?: unknown; version?: unknown; worker?: unknown; runtime?: unknown; transport?: unknown };
  if (value.version !== tag) return undefined;
  let component: ReleaseComponent;
  let entries: unknown;
  if (value.schemaVersion === 2) {
    component = "worker";
    entries = value.worker;
  } else if (value.schemaVersion === 3) {
    if (value.worker !== undefined) return undefined;
    component = "runtime";
    entries = value.runtime;
  } else {
    return undefined;
  }
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) return undefined;
  const parsed: Record<string, ManifestWorkerEntry> = {};
  for (const [target, raw] of Object.entries(entries)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const entry = raw as Record<string, unknown>;
    const rawSignatureOk = component === "worker"
      ? typeof entry.signature === "string" && ED25519_SIGNATURE_HEX.test(entry.signature)
      : entry.signature === undefined;
    if (
      entry.target !== target ||
      typeof entry.url !== "string" ||
      !(entry.url.startsWith("https://") || entry.url.startsWith("http://")) ||
      typeof entry.sha256 !== "string" ||
      !SHA256_HEX.test(entry.sha256) ||
      !rawSignatureOk ||
      typeof entry.releaseSignature !== "string" ||
      !ED25519_SIGNATURE_HEX.test(entry.releaseSignature) ||
      typeof entry.size !== "number" ||
      !Number.isSafeInteger(entry.size) ||
      entry.size <= 0 ||
      entry.size > MAX_WORKER_BYTES
    ) {
      return undefined;
    }
    let transport: ManifestWorkerEntry["transport"];
    if (value.transport !== undefined) {
      if (!value.transport || typeof value.transport !== "object" || Array.isArray(value.transport)) return undefined;
      const helper = (value.transport as Record<string, Record<string, unknown>>)[target];
      if (!helper || helper.target !== target || typeof helper.url !== "string" || !/^https?:\/\//.test(helper.url) || typeof helper.sha256 !== "string" || !SHA256_HEX.test(helper.sha256) || typeof helper.releaseSignature !== "string" || !ED25519_SIGNATURE_HEX.test(helper.releaseSignature) || typeof helper.size !== "number" || !Number.isSafeInteger(helper.size) || helper.size <= 0 || helper.size > MAX_WORKER_BYTES) return undefined;
      transport = { url: helper.url, sha256: helper.sha256.toLowerCase(), size: BigInt(helper.size), releaseSignature: helper.releaseSignature.toLowerCase() };
    }
    parsed[target] = {
      target,
      ...(transport ? { transport } : {}),
      url: entry.url,
      sha256: entry.sha256.toLowerCase(),
      signature: component === "worker" ? (entry.signature as string).toLowerCase() : "",
      size: entry.size,
      releaseSignature: entry.releaseSignature.toLowerCase(),
    };
  }
  return Object.keys(parsed).length > 0 ? { component, entries: parsed } : undefined;
}


/** cofluxd.mjs 的 rustTarget() 用 Node os.platform()/arch() 命名；这里收到的是 daemon 侧
 * Rust `std::env::consts::OS/ARCH`，命名不同（macos vs darwin），需单独映射，语义保持一致。
 * 新增受支持平台时两处都要加（见 plans/015 维护提示）。*/
function rustTarget(platform: string, arch: string): string | undefined {
  if (platform === "macos") {
    if (arch === "aarch64") return "aarch64-apple-darwin";
    if (arch === "x86_64") return "x86_64-apple-darwin";
  } else if (platform === "linux") {
    if (arch === "aarch64") return "aarch64-unknown-linux-musl";
    if (arch === "x86_64") return "x86_64-unknown-linux-musl";
  }
  return undefined;
}

export class AutoUpdater {
  private latest: LatestRelease | null = null;
  /** 每个「daemonId:version」的累计派发次数；时间流逝不会回补已经用掉的配额。 */
  private attempts = new Map<string, { count: number; gaveUp: boolean }>();
  /** 「daemonId:version」 pairs already logged as skipped for being desktop-managed: the skip is
   * the observable outcome, but every sweep hits the same daemons, so say it once per version. */
  private skippedDesktopManaged = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(private hub: Hub) {}

  get enabled(): boolean {
    return config.autoUpdateRepo !== "";
  }

  start(): void {
    if (!this.enabled) return;
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), config.autoUpdatePollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** 握手完成时机（plan 015）：给自动更新编排一个立即比对本台 daemon 的机会，不必等下一次轮询。 */
  checkDaemon(daemonId: string): void {
    if (!this.enabled || !this.latest) return;
    const d = this.hub.listOnlineDaemonsForUpdate().find((x) => x.daemonId === daemonId);
    if (d) this.maybeUpgrade(d);
  }

  /** The latest stable tag and its manifest, from the release mirror when configured, else GitHub. */
  private async latestManifest(): Promise<{ tag: string; manifest: unknown } | undefined> {
    const mirror = config.autoUpdateMirrorBase;
    if (mirror) {
      const pointer = await fetchJson(`${mirror}/releases/latest.json`);
      const tag = typeof pointer?.version === "string" ? pointer.version : null;
      if (!tag) return undefined;
      return { tag, manifest: await fetchJson(`${mirror}/releases/${encodeURIComponent(tag)}/manifest.json`) };
    }
    const github = await fetchJson(`${config.autoUpdateApiBase}/repos/${config.autoUpdateRepo}/releases/latest`);
    const tag = typeof github?.tag_name === "string" ? github.tag_name : null;
    if (!tag) return undefined;
    const assets: { name: string; browser_download_url: string }[] = Array.isArray(github.assets) ? github.assets : [];
    const manifestAsset = assets.find((a) => a.name === "manifest.json");
    if (!manifestAsset) {
      log.warn("release 缺少 manifest.json 资产", { tag });
      return undefined;
    }
    return { tag, manifest: await fetchJson(manifestAsset.browser_download_url) };
  }

  private async pollOnce(): Promise<void> {
    try {
      const latest = await this.latestManifest();
      if (!latest) return;
      const { tag, manifest } = latest;
      const release = parseManifestRelease(manifest, tag);
      if (!release) {
        log.warn("manifest.json release statement 字段缺失或与 release tag 不一致", { tag });
        return;
      }
      this.latest = { version: tag, component: release.component, workers: release.entries };
      log.info("latest release polled", { version: tag, component: release.component, targets: Object.keys(release.entries) });
    } catch (err) {
      log.warn("轮询最新 release 失败", { source: config.autoUpdateMirrorBase || "github", err: err instanceof Error ? err.message : String(err) });
      return;
    }
    this.sweep();
  }

  private sweep(): void {
    if (!this.latest) return;
    for (const d of this.hub.listOnlineDaemonsForUpdate()) this.maybeUpgrade(d);
  }

  private maybeUpgrade(d: { daemonId: string; workerVersion: string; platform: string; arch: string; desktopManaged: boolean; launcher: boolean }): void {
    const latest = this.latest;
    if (!latest) return;
    if (!d.workerVersion) return;
    if (d.workerVersion === latest.version) return;
    // A runtime release goes only to launcher daemons (nothing else can roll it back); a worker
    // release only to pre-launcher daemons (a launcher daemon cannot run a worker). Silent in
    // both cases: the sweep hits the same daemons every poll.
    if ((latest.component === "runtime") !== d.launcher) return;
    // A desktop-hosted daemon's version is the app's bundled one (plan 20261002-runtime-follows-app):
    // pushing GitHub's latest into it would race the app's own replacement — and the comparison
    // above is "not equal", so a lagging app would be pushed forward only to be moved back.
    if (d.desktopManaged) {
      const key = `${d.daemonId}:${latest.version}`;
      if (!this.skippedDesktopManaged.has(key)) {
        this.skippedDesktopManaged.add(key);
        log.info("auto upgrade skipped: daemon is desktop-managed", { daemonId: d.daemonId, version: latest.version, workerVersion: d.workerVersion });
      }
      return;
    }
    const target = rustTarget(d.platform, d.arch);
    if (!target) return;
    const entry = latest.workers[target];
    if (!entry) {
      log.warn("manifest 缺少 target 对应条目，跳过", { daemonId: d.daemonId, target });
      return;
    }
    const key = `${d.daemonId}:${latest.version}`;
    const rec = this.attempts.get(key);
    if (rec && rec.count >= config.autoUpdateMaxAttempts) {
      if (!rec.gaveUp) {
        rec.gaveUp = true;
        log.warn("auto upgrade 已达重试上限，停止推送该版本", {
          daemonId: d.daemonId,
          version: latest.version,
          attempts: rec.count,
          workerVersion: d.workerVersion,
        });
      }
      return;
    }
    const ok = this.hub.sendWorkerUpgrade(d.daemonId, {
      version: latest.version,
      url: entry.url,
      sha256: entry.sha256,
      signature: entry.signature,
      target: entry.target,
      artifactSize: BigInt(entry.size),
      releaseSignature: entry.releaseSignature,
      transport: entry.transport,
    });
    if (!ok) return;
    const next = rec ?? { count: 0, gaveUp: false };
    next.count += 1;
    this.attempts.set(key, next);
    log.info("auto upgrade dispatched", { daemonId: d.daemonId, version: latest.version, attempt: next.count });
  }
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { "user-agent": "coflux-server", accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}
