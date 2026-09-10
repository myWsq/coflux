/** 主进程 ↔ preload 的 IPC 通道名；渲染层只见 preload 暴露的桥接方法，见不到这些字符串。 */
export const IPC = {
  /** preload 启动时同步取一次的引导数据（serverUrl / origin / version / platform） */
  bootstrap: "desktop:bootstrap",
  notify: "desktop:notify",
  setBadge: "desktop:set-badge",
  checkForUpdates: "desktop:check-for-updates",
  installUpdate: "desktop:install-update",
  getUpdateState: "desktop:get-update-state",
  /** 主进程 → 渲染层 */
  focusWorkspace: "desktop:focus-workspace",
  command: "desktop:command",
  updateState: "desktop:update-state",
} as const;

export type Bootstrap = {
  platform: string;
  version: string;
  serverUrl: string;
  origin: string;
};
