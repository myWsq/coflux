/**
 * 内置 supervisor 与在跑 supervisor 的版本比较（plan 113）。纯函数，无 Electron 依赖。
 *
 * 版本原文形如 `v0.32.0` / `v0.0.0-desktop.0.1.7` / `dev`，与 crates/supervisor/src/upgrade.rs 的
 * ReleaseVersion::parse 同一套接受域：`v` 前缀 + 严格 SemVer（允许 prerelease 与 build metadata），
 * 比较按 SemVer 11 的 precedence（build metadata 不参与）。
 */

export type ReleaseVersion = {
  major: number;
  minor: number;
  patch: number;
  /** prerelease 标识符列表；正式版为空数组 */
  prerelease: string[];
};

const RELEASE_VERSION_RE =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

/** 解析不了（`dev` / 空 / 无 v 前缀 / 前导零）返回 null。 */
export function parseReleaseVersion(raw: string | null | undefined): ReleaseVersion | null {
  if (!raw) return null;
  const match = RELEASE_VERSION_RE.exec(raw.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  // 数字标识符永远低于字母数字标识符
  if (leftNumeric && !rightNumeric) return -1;
  if (!leftNumeric && rightNumeric) return 1;
  if (leftNumeric && rightNumeric) {
    const delta = Number(left) - Number(right);
    return delta < 0 ? -1 : delta > 0 ? 1 : 0;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

/** SemVer precedence：<0 左旧，0 同级，>0 左新。 */
export function compareReleaseVersions(left: ReleaseVersion, right: ReleaseVersion): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  // 有 prerelease 的低于没有的
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.min(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const delta = compareIdentifier(left.prerelease[index], right.prerelease[index]);
    if (delta !== 0) return delta;
  }
  // 前缀相同时标识符更多的更新
  return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length < right.prerelease.length ? -1 : 1;
}

/**
 * 「有更新待重启」的判定（plan 113 决策）：
 * - 两者都能解析且内置严格更新 → true
 * - 在跑的解析不了（dev）或缺失（112 之前的老 supervisor 没写文件）→ 视为比内置旧 → true
 * - 内置解析不了（本机 pack 落 dev）→ 永不提示 → false
 */
export function bundledSupervisorIsNewer(bundledRaw: string | null | undefined, runningRaw: string | null | undefined): boolean {
  const bundled = parseReleaseVersion(bundledRaw);
  if (!bundled) return false;
  const running = parseReleaseVersion(runningRaw);
  if (!running) return true;
  return compareReleaseVersions(bundled, running) > 0;
}
