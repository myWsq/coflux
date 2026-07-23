import { useEffect, useState } from "react";

import { Workbench } from "@/components/workbench/workbench";
import { createCofluxClient } from "@coflux/client";
import { SERVER_URL, TOKEN_KEY, USE_SUPABASE } from "@/config";
import { loginWithSupabase } from "@/lib/auth";

export function MainPage() {
  // 一次性初始化（组件体每次渲染都跑，createCofluxClient 内部含副作用/命令式资源，
  // 必须用 useState 惰性初始化保证只创建一次）。
  const [client] = useState(() =>
    createCofluxClient({
      serverUrl: SERVER_URL,
      tokenStorageKey: TOKEN_KEY,
      loginProvider: USE_SUPABASE ? loginWithSupabase : undefined,
    }),
  );
  useEffect(() => () => client.disconnect(), [client]);

  // 关标签/刷新/关窗前弹浏览器原生确认框，防止 cmd+w 等误操作退出工作台。
  // 浏览器只允许原生文案，无法自定义；preventDefault 是现代标准，returnValue 兼容旧内核。
  useEffect(() => {
    const confirmExit = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", confirmExit);
    return () => window.removeEventListener("beforeunload", confirmExit);
  }, []);

  return <Workbench client={client} />;
}
