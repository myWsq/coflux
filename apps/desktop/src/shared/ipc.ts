/** 主进程 ↔ preload 的 IPC 通道名；渲染层只见 preload 暴露的桥接方法，见不到这些字符串。 */
export const IPC = {
  /** preload 启动时同步取一次的引导数据（serverUrl / origin / version / platform） */
  bootstrap: "desktop:bootstrap",
  tailcatOpen: "desktop:tailcat-open",
  tailcatSend: "desktop:tailcat-send",
  tailcatAck: "desktop:tailcat-ack",
  tailcatClose: "desktop:tailcat-close",
  tailcatControl: "desktop:tailcat-control",
  tailcatEvent: "desktop:tailcat-event",
  connectLocal: "desktop:connect-local",
  logoutLocal: "desktop:logout-local",
  notify: "desktop:notify",
  setBadge: "desktop:set-badge",
  /** 「服务器地址…」原生对话框（plan 110）：settings.json 路径与「打开设置文件」只有主进程有 */
  showServerInfo: "desktop:show-server-info",
  checkForUpdates: "desktop:check-for-updates",
  installUpdate: "desktop:install-update",
  getUpdateState: "desktop:get-update-state",
  /** 会话 token（plan 106）：主进程 safeStorage 加密落盘 */
  getSessionToken: "desktop:get-session-token",
  setSessionToken: "desktop:set-session-token",
  clearSessionToken: "desktop:clear-session-token",
  /** 本机 daemon（plan 113）：状态拉取 + 无参窄动词 */
  daemonGetState: "desktop:daemon-get-state",
  daemonEnroll: "desktop:daemon-enroll",
  daemonRestart: "desktop:daemon-restart",
  daemonStop: "desktop:daemon-stop",
  daemonRemove: "desktop:daemon-remove",
  daemonOpenFdaGuide: "desktop:daemon-open-fda-guide",
  daemonDismissError: "desktop:daemon-dismiss-error",
  /** 主进程 → 渲染层 */
  focusWorkspace: "desktop:focus-workspace",
  command: "desktop:command",
  updateState: "desktop:update-state",
  daemonState: "desktop:daemon-state",
} as const;

export type Bootstrap = {
  tailcat?: boolean;
  platform: string;
  version: string;
  serverUrl: string;
  origin: string;
};
