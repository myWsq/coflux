import { useEffect, useState } from "react";

import { Workbench } from "@/components/workbench/workbench";
import { createCofluxClient } from "@coflux/client";
import { BUILD_ID, SERVER_URL, desktop } from "@/config";
import { createNativeRemoteTransport } from "@/native-transport";
import { createBridgeTokenStorage } from "@/session-token";

export function MainPage({ initialToken }: { initialToken: string }) {
  // 一次性初始化（组件体每次渲染都跑，createCofluxClient 内部含副作用/命令式资源，
  // 必须用 useState 惰性初始化保证只创建一次）。
  const [client] = useState(() =>
    createCofluxClient({
      serverUrl: SERVER_URL,
      onAuthenticated: () => { void desktop.connectLocal().catch((error) => console.error("本机接入失败", error)); },
      // 会话 token 的真相在主进程 safeStorage（plan 106）：启动时已经取回，这里只在内存持有并把变化转发回去。
      tokenStorage: createBridgeTokenStorage(desktop, initialToken),
      buildId: BUILD_ID,
      // 桌面按控制面协议版本准入（plan 105），build-id 只作标识。
      clientKind: "desktop",
      // 中心离线也能冷启动看本机终端（plan 103）：最近一次目录快照落 localStorage（按服务器地址分 key），
      // 首连拿不到 authOk 时装载缓存进工作台，RUNNING 终端经缓存的 loopback grant attach。
      offlineCatalog: { storage: localStorage, key: `coflux_offline_catalog:${SERVER_URL}` },
      deviceTransport: {
        nativeRemote: desktop.nativeTransport ? createNativeRemoteTransport(desktop.nativeTransport) : undefined,
        enableLocalTransport: true,
        identityDatabaseName: "coflux-web-device-v1",
        // 自报 origin 用主进程改写握手头时写入的同一个稳定 https Origin（server/daemon 只接受 http/https，零放宽）。
        origin: desktop.origin,
      },
    }),
  );
  useEffect(() => () => client.disconnect(), [client]);

  // 不挂 beforeunload：Electron 对它的 preventDefault 不弹框而是直接取消关闭，会让窗口关不掉；
  // ⌘W 由页面处理为关闭终端 Tab，关窗是 ⇧⌘W / 红灯，没有误触问题。
  return <Workbench client={client} />;
}
