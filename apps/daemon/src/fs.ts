/**
 * fs 原语：在锚定的 root 内列目录 / 读文件。
 *
 * 安全：访问锚定在 root（工作区路径）内，解析后既做字符串包含校验、又用 realpath 解引用
 * 再校验一次（挡符号链接指向 root 外）。单用户自有机器信任模型下，这主要是防 UI/bug 误伤。
 */
import { readdir, lstat, stat, readFile, realpath } from "node:fs/promises";
import { resolve, sep, join } from "node:path";
import type { FsEntry } from "@coflux/protocol";

const MAX_READ_BYTES = 2 * 1024 * 1024;

/** 把 root + 相对路径解析为绝对真实路径，并保证不越出 root（含符号链接解引用）；越界/不存在返回 null */
async function safeResolve(root: string, rel: string): Promise<string | null> {
  const base = resolve(root);
  const target = resolve(base, rel && rel.length > 0 ? rel : ".");
  // 先做字符串包含快筛
  if (target !== base && !target.startsWith(base + sep)) return null;
  // 再 realpath 解引用，挡 root 内指向 root 外的符号链接
  try {
    const realBase = await realpath(base);
    const realTarget = await realpath(target);
    if (realTarget !== realBase && !realTarget.startsWith(realBase + sep)) return null;
    return realTarget;
  } catch {
    return null; // ENOENT 等
  }
}

export async function listDir(root: string, rel: string): Promise<{ ok: boolean; entries: FsEntry[]; error?: string }> {
  const target = await safeResolve(root, rel);
  if (!target) return { ok: false, entries: [], error: "路径越界或不存在" };
  try {
    const dirents = await readdir(target, { withFileTypes: true });
    const entries: FsEntry[] = [];
    for (const d of dirents) {
      // 用 dirent 类型 + lstat（不跟随符号链接），列表保持锚定在 root 内
      const type: FsEntry["type"] = d.isDirectory() ? "dir" : d.isFile() ? "file" : d.isSymbolicLink() ? "symlink" : "other";
      let size = 0;
      try {
        size = (await lstat(join(target, d.name))).size;
      } catch {
        /* ignore */
      }
      entries.push({ name: d.name, type, size });
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    return { ok: true, entries };
  } catch (err) {
    return { ok: false, entries: [], error: (err as Error).message };
  }
}

export async function readFileText(root: string, rel: string): Promise<{ ok: boolean; content: string; error?: string }> {
  const target = await safeResolve(root, rel);
  if (!target) return { ok: false, content: "", error: "路径越界或不存在" };
  try {
    const s = await stat(target);
    if (!s.isFile()) return { ok: false, content: "", error: "不是文件" };
    if (s.size > MAX_READ_BYTES) return { ok: false, content: "", error: "文件过大（>2MB）" };
    const buf = await readFile(target);
    return { ok: true, content: buf.toString("utf8") };
  } catch (err) {
    return { ok: false, content: "", error: (err as Error).message };
  }
}
