/**
 * daemon worker 自动热更新编排（plan 015）。
 *
 * server 轮询 GitHub `/releases/latest`（天然排除 prerelease/draft）取最新 stable 版本号 +
 * 该 release 的 manifest.json 资产（每 target 同时带 legacy raw signature 与绑定
 * version/target/sha256/size 的 release signature，见 scripts/release-sign.mjs）。
 * 对每台在线 daemon：握手上报的 (workerVersion, platform, arch) 不等于最新版本、且非空、且能映射到
 * manifest 里的某个 target 时，复用 hub 现有 workerUpgrade 下发路径推送升级——不做 semver 比较（见
 * plans/015 决策：不等即推）。supervisor 侧的下载/验签/probation/回滚语义不变，本模块只负责"推不推"。
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
  signature: string;
  target: string;
  size: number;
  releaseSignature: string;
}
interface LatestRelease {
  version: string;
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

export function parseManifestWorkers(manifest: unknown, tag: string): Record<string, ManifestWorkerEntry> | undefined {
  if (!isStrictReleaseVersion(tag)) return undefined;
  if (!manifest || typeof manifest !== "object") return undefined;
  const value = manifest as { schemaVersion?: unknown; version?: unknown; worker?: unknown };
  if (
    value.schemaVersion !== 2 ||
    value.version !== tag ||
    !value.worker ||
    typeof value.worker !== "object" ||
    Array.isArray(value.worker)
  ) {
    return undefined;
  }
  const parsed: Record<string, ManifestWorkerEntry> = {};
  for (const [target, raw] of Object.entries(value.worker)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const entry = raw as Record<string, unknown>;
    if (
      entry.target !== target ||
      typeof entry.url !== "string" ||
      !(entry.url.startsWith("https://") || entry.url.startsWith("http://")) ||
      typeof entry.sha256 !== "string" ||
      !SHA256_HEX.test(entry.sha256) ||
      typeof entry.signature !== "string" ||
      !ED25519_SIGNATURE_HEX.test(entry.signature) ||
      typeof entry.releaseSignature !== "string" ||
      !ED25519_SIGNATURE_HEX.test(entry.releaseSignature) ||
      typeof entry.size !== "number" ||
      !Number.isSafeInteger(entry.size) ||
      entry.size <= 0 ||
      entry.size > MAX_WORKER_BYTES
    ) {
      return undefined;
    }
    parsed[target] = {
      target,
      url: entry.url,
      sha256: entry.sha256.toLowerCase(),
      signature: entry.signature.toLowerCase(),
      size: entry.size,
      releaseSignature: entry.releaseSignature.toLowerCase(),
    };
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined;
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

  private async pollOnce(): Promise<void> {
    try {
      const release = await fetchJson(`${config.autoUpdateApiBase}/repos/${config.autoUpdateRepo}/releases/latest`);
      const tag = typeof release?.tag_name === "string" ? release.tag_name : null;
      if (!tag) return;
      const assets: { name: string; browser_download_url: string }[] = Array.isArray(release.assets) ? release.assets : [];
      const manifestAsset = assets.find((a) => a.name === "manifest.json");
      if (!manifestAsset) {
        log.warn("release 缺少 manifest.json 资产", { tag });
        return;
      }
      const manifest = await fetchJson(manifestAsset.browser_download_url);
      const workers = parseManifestWorkers(manifest, tag);
      if (!workers) {
        log.warn("manifest.json release statement 字段缺失或与 release tag 不一致", { tag });
        return;
      }
      this.latest = { version: tag, workers };
      log.info("latest release polled", { version: tag, targets: Object.keys(workers) });
    } catch (err) {
      log.warn("轮询 GitHub release 失败", { err: err instanceof Error ? err.message : String(err) });
      return;
    }
    this.sweep();
  }

  private sweep(): void {
    if (!this.latest) return;
    for (const d of this.hub.listOnlineDaemonsForUpdate()) this.maybeUpgrade(d);
  }

  private maybeUpgrade(d: { daemonId: string; workerVersion: string; platform: string; arch: string }): void {
    const latest = this.latest;
    if (!latest) return;
    if (!d.workerVersion) return;
    if (d.workerVersion === latest.version) return;
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
    });
    if (!ok) return;
    const next = rec ?? { count: 0, gaveUp: false };
    next.count += 1;
    this.attempts.set(key, next);
    log.info("auto upgrade dispatched", { daemonId: d.daemonId, version: latest.version, attempt: next.count });
  }
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { "user-agent": "coflux-server", accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}
