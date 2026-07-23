import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { LoaderCircle } from "lucide-react";
import { createCofluxClient } from "@coflux/client";

import { AuthScreen } from "@/components/auth-screen";
import { WorkspaceList } from "@/components/workspace-list";
import { WorkspaceDetail } from "@/components/workspace-detail";
import { SERVER_URL, TOKEN_KEY, USE_SUPABASE } from "@/config";
import { loginWithSupabase } from "@/lib/auth";
import { useRoute } from "@/lib/use-route";
import { useViewportHeight } from "@/lib/use-viewport-height";

const ROOT_HEIGHT_STYLE = { height: "var(--app-vh, 100dvh)" } as const;

export function App() {
  useViewportHeight();

  // 一次性初始化：createCofluxClient 内部含 WS 连接等副作用/命令式资源，必须用
  // useState 惰性初始化保证只创建一次（同 apps/web MainPage 决策）。
  const [client] = useState(() =>
    createCofluxClient({
      serverUrl: SERVER_URL,
      tokenStorageKey: TOKEN_KEY,
      loginProvider: USE_SUPABASE ? loginWithSupabase : undefined,
    }),
  );
  useEffect(() => () => client.disconnect(), [client]);

  const authState = useStore(client.store, (state) => state.authState);
  const workspaces = useStore(client.store, (state) => state.workspaces);
  const snapshotRevision = useStore(client.store, (state) => state.snapshotRevision);
  const { route, openWorkspace, closeWorkspace } = useRoute();

  // 工作区在他端被删除 / 快照校准后不存在：自动回落列表页，避免详情页悬空。
  useEffect(() => {
    if (route.screen !== "detail" || snapshotRevision === 0) return;
    if (!workspaces.some((workspace) => workspace.id === route.workspaceId)) closeWorkspace();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, workspaces, snapshotRevision]);

  if (authState === "authenticating") {
    return (
      <div
        className="flex items-center justify-center bg-background text-muted-foreground"
        style={ROOT_HEIGHT_STYLE}
      >
        <LoaderCircle className="size-5 animate-spin" />
      </div>
    );
  }

  if (authState !== "authed") {
    return (
      <div style={ROOT_HEIGHT_STYLE}>
        <AuthScreen client={client} />
      </div>
    );
  }

  return (
    <div style={ROOT_HEIGHT_STYLE}>
      {route.screen === "detail" ? (
        <WorkspaceDetail client={client} workspaceId={route.workspaceId} onBack={closeWorkspace} />
      ) : (
        <WorkspaceList client={client} onSelectWorkspace={openWorkspace} />
      )}
    </div>
  );
}
