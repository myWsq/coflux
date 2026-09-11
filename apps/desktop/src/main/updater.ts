import { setInterval, setTimeout } from "node:timers";
import electronUpdater from "electron-updater";

import type { DesktopUpdateState } from "../../../web/src/desktop-bridge";
import { INITIAL_UPDATE_STATE, reduceUpdateState, type UpdaterEvent } from "./update-state";

// electron-updater 是 CommonJS（autoUpdater 经 getter 惰性导出）：从 ESM 主进程用默认导入再解构最稳。
const { autoUpdater } = electronUpdater;

/** 周期检查间隔；另在启动后延迟一次。版本准入被拒时渲染层还会主动触发一次。 */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 15_000;

export type Updater = {
  checkForUpdates: () => void;
  installUpdate: () => void;
  getState: () => DesktopUpdateState;
  onChange: (listener: (state: DesktopUpdateState) => void) => () => void;
};

export type UpdaterOptions = {
  /** 打包版才真的检查（electron-updater 对未打包应用直接跳过、不发事件） */
  enabled: boolean;
  /** quitAndInstall 会先关所有窗口：调用方在这里把「正在退出」置位，让窗口的 close 钩子放行 */
  beforeInstall: () => void;
};

/**
 * 自动更新（plan 103）：electron-updater generic provider 读仓库 `desktop-updates` 分支上的 latest-mac.yml
 * （raw.githubusercontent.com，publish.url 写死在 electron-builder.yml；安装包在 GitHub Release，清单里是绝对下载地址）。发现即下载、退出时自动安装；渲染层可显式
 * 触发检查（版本准入被拒时）并请求立即重启安装。
 */
export function createUpdater(options: UpdaterOptions): Updater {
  let state: DesktopUpdateState = INITIAL_UPDATE_STATE;
  const listeners = new Set<(state: DesktopUpdateState) => void>();

  function dispatch(event: UpdaterEvent): void {
    const next = reduceUpdateState(state, event);
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener(state);
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.on("checking-for-update", () => dispatch({ type: "checking" }));
  autoUpdater.on("update-available", (info) => dispatch({ type: "available", version: info.version }));
  autoUpdater.on("download-progress", (progress) => dispatch({ type: "progress", percent: progress.percent }));
  autoUpdater.on("update-downloaded", (info) => dispatch({ type: "downloaded", version: info.version }));
  autoUpdater.on("update-not-available", () => dispatch({ type: "not-available" }));
  autoUpdater.on("error", (error) => dispatch({ type: "error", message: error?.message || String(error) }));

  function checkForUpdates(): void {
    if (!options.enabled) {
      dispatch({ type: "error", message: "开发版不检查更新" });
      return;
    }
    // 事件会驱动状态；这里吞掉 promise 拒绝（error 事件已经转成状态）
    autoUpdater.checkForUpdates().catch(() => undefined);
  }

  if (options.enabled) {
    setTimeout(checkForUpdates, STARTUP_DELAY_MS).unref();
    setInterval(checkForUpdates, CHECK_INTERVAL_MS).unref();
  }

  return {
    checkForUpdates,
    installUpdate: () => {
      if (state.status !== "downloaded") return;
      options.beforeInstall();
      autoUpdater.quitAndInstall();
    },
    getState: () => state,
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
