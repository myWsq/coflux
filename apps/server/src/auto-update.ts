/**
 * daemon worker 自动热更新编排（plan 015）。
 *
 * server 轮询 GitHub `/releases/latest`（天然排除 prerelease/draft）取最新 stable 版本号 +
 * 该 release 的 manifest.json 资产（每 target 的 url/sha256/signature，见 scripts/release-sign.mjs）。
 * 对每台在线 daemon：握手上报的 (workerVersion, platform, arch) 不等于最新版本、且非空、且能映射到
 * manifest 里的某个 target 时，复用 hub 现有 workerUpgrade 下发路径推送升级——不做 semver 比较（见
 * plans/015 决策：不等即推）。supervisor 侧的下载/验签/probation/回滚语义不变，本模块只负责"推不推"。
 *
 * 触发时机：daemon 握手完成时对该台 daemon 比对一次；每次轮询到 release 数据后对全部在线 daemon
 * sweep 一次。失败退避：按 (daemonId, version) 记录推送次数，超过 maxAttempts 后进入冷却，冷却期满
 * 重新计数——纯内存态，server 重启清零（可接受，见决策）。
 */
import { createLogger } from "@coflux/core";
import { config } from "./config.js";
import type { Hub } from "./hub.js";

const log = createLogger("auto-update");

interface ManifestWorkerEntry {
  url: string;
  sha256: string;
  signature: string;
}
interface LatestRelease {
  version: string;
  workers: Record<string, ManifestWorkerEntry>;
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
  private attempts = new Map<string, { count: number; lastAt: number }>();
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
      const workers = manifest && typeof manifest === "object" ? manifest.worker : undefined;
      if (!workers || typeof workers !== "object") {
        log.warn("manifest.json 缺少 worker 字段", { tag });
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
    const now = Date.now();
    const rec = this.attempts.get(key);
    if (rec) {
      if (now - rec.lastAt > config.autoUpdateCooldownMs) {
        rec.count = 0;
      } else if (rec.count >= config.autoUpdateMaxAttempts) {
        return;
      }
    }
    const next = rec ?? { count: 0, lastAt: 0 };
    next.count += 1;
    next.lastAt = now;
    this.attempts.set(key, next);
    const ok = this.hub.sendWorkerUpgrade(d.daemonId, { version: latest.version, url: entry.url, sha256: entry.sha256, signature: entry.signature });
    if (ok) log.info("auto upgrade dispatched", { daemonId: d.daemonId, version: latest.version, attempt: next.count });
  }
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { "user-agent": "coflux-server", accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}
