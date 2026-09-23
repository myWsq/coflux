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
  /** 终端里的 OSC 52：远端程序要写本机剪贴板，只能由主进程的 Electron clipboard 落地 */
  clipboardWrite: "desktop:clipboard-write",
  /** 「服务器地址…」原生对话框（plan 110）：settings.json 路径与「打开设置文件」只有主进程有 */
  showServerInfo: "desktop:show-server-info",
  checkForUpdates: "desktop:check-for-updates",
  installUpdate: "desktop:install-update",
  getUpdateState: "desktop:get-update-state",
  /** 会话 token（plan 106）：主进程 safeStorage 加密落盘 */
  getSessionToken: "desktop:get-session-token",
  setSessionToken: "desktop:set-session-token",
  clearSessionToken: "desktop:clear-session-token",
  /** Browser sign-in (plan 20260923): provider list, start / reopen / cancel */
  loginOptions: "desktop:login-options",
  loginStart: "desktop:login-start",
  loginReopen: "desktop:login-reopen",
  loginCancel: "desktop:login-cancel",
  /** 本机 daemon（plan 113）：状态拉取 + 无参窄动词 */
  daemonGetState: "desktop:daemon-get-state",
  daemonEnroll: "desktop:daemon-enroll",
  daemonRestart: "desktop:daemon-restart",
  daemonStop: "desktop:daemon-stop",
  daemonRemove: "desktop:daemon-remove",
  daemonOpenFdaGuide: "desktop:daemon-open-fda-guide",
  daemonDismissError: "desktop:daemon-dismiss-error",
  /**
   * executor（plan 116）。渲染层只做两件事：把 device 通道收到的工单转进来，把主进程要发的上行交出去。
   * 作业表与写锁的真相在主进程，渲染层不持有任何 run 状态。
   */
  executorGetSettings: "desktop:executor-get-settings",
  /** 内置 provider + 自定义端点 + 可搜索的模型清单（来自主进程常驻的 ModelRuntime） */
  executorGetCatalog: "desktop:executor-get-catalog",
  /** 保存：本机校验 → 写中心 → 等本机 daemon 取回。凭据只朝主进程走，回程一个字节都没有 */
  executorSave: "desktop:executor-save",
  /** 「测试连接」：真发一次最小请求 */
  executorTest: "desktop:executor-test",
  /** 渲染层 → 主进程：device 通道收到的 assign / cancel / registered / ack */
  executorInbound: "desktop:executor-inbound",
  /** 渲染层 → 主进程：本机 daemon 的 device 通道可用 / 断开，附本次连接的 generation */
  executorChannel: "desktop:executor-channel",
  /** 主进程 → 渲染层 */
  focusNotification: "desktop:focus-notification",
  focusWorkspace: "desktop:focus-workspace",
  command: "desktop:command",
  updateState: "desktop:update-state",
  daemonState: "desktop:daemon-state",
  executorSettings: "desktop:executor-settings",
  /** 主进程 → 渲染层：请把这条帧经 device 通道发给本机 daemon */
  executorOutbound: "desktop:executor-outbound",
} as const;

export type Bootstrap = {
  tailcat?: boolean;
  platform: string;
  version: string;
  serverUrl: string;
  origin: string;
};
