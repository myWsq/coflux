import { useEffect, useState } from "react";

import { Workbench } from "@/components/workbench/workbench";
import { requestWorkbenchExitConfirmation } from "@/components/workbench/workbench-state";
import { createCofluxClient } from "@coflux/client";
import { BUILD_ID, SERVER_URL, TOKEN_KEY } from "@/config";
import { getDesktopBridge } from "@/desktop-bridge";

export function MainPage() {
  // 桌面 app（plan 103）：自报 origin 用主进程改写握手头时写入的同一个稳定 https Origin，
  // 而不是自定义 scheme 的 location.origin（server/daemon 只接受 http/https，零放宽）。
  const desktop = getDesktopBridge();
  // 一次性初始化（组件体每次渲染都跑，createCofluxClient 内部含副作用/命令式资源，
  // 必须用 useState 惰性初始化保证只创建一次）。
  const [client] = useState(() =>
    createCofluxClient({
      serverUrl: SERVER_URL,
      tokenStorageKey: TOKEN_KEY,
      buildId: BUILD_ID,
      // 桌面渲染层随 app 打包，reload 拿不到新 bundle：版本失配直接进 outdated 状态页，由 app 触发更新检查。
      reloadOnOutdated: desktop === null,
      deviceTransport: {
        enableLocalTransport: true,
        identityDatabaseName: "coflux-web-device-v1",
        origin: desktop?.origin ?? window.location.origin,
      },
    }),
  );
  useEffect(() => () => client.disconnect(), [client]);

  // 关标签/刷新/关窗前弹浏览器原生确认框，防止 cmd+w 等误操作退出工作台。
  // 浏览器只允许原生文案，无法自定义；preventDefault 是现代标准，returnValue 兼容旧内核。
  // 桌面 app 不挂：Electron 对 beforeunload 的 preventDefault 不弹框而是直接取消关闭，会让窗口关不掉；
  // ⌘W 在桌面下由页面处理为关闭终端 Tab，关窗是 ⇧⌘W / 红灯，无误触问题。
  useEffect(() => {
    if (desktop) return;
    window.addEventListener("beforeunload", requestWorkbenchExitConfirmation);
    return () => window.removeEventListener("beforeunload", requestWorkbenchExitConfirmation);
  }, [desktop]);

  return <Workbench client={client} />;
}
