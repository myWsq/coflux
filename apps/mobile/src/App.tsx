import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { VStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import { createCofluxClient } from "@coflux/client";

import { AuthScreen } from "@/components/auth-screen";
import { WorkspaceList } from "@/components/workspace-list";
import { WorkspaceDetail } from "@/components/workspace-detail";
import { BUILD_ID, SERVER_URL, TOKEN_KEY, USE_SUPABASE } from "@/config";
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
      buildId: BUILD_ID,
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

  // 版本失配、reload 一次仍未拿到新 bundle（plan 033）：不是认证失败，独立展示面
  // （mobile 冻结范围内的共享层状态最小配套 UI，就地内联，不新建组件文件）。
  if (authState === "outdated") {
    return (
      <div style={ROOT_HEIGHT_STYLE}>
        <Center axis="both" minHeight="100%" style={{ backgroundColor: "var(--color-background)", padding: "var(--spacing-4, 16px)" }}>
          <VStack gap={4} hAlign="center" style={{ width: "100%", maxWidth: 380 }}>
            <Text type="body" weight="bold" size="lg">
              coflux
            </Text>
            <Card padding={8} width="100%">
              <VStack gap={2} hAlign="center">
                <RefreshCw className="size-5 text-primary" />
                <Heading level={2}>客户端已更新</Heading>
                <Text type="body" color="secondary" size="sm">
                  服务器已部署新版本，请刷新页面获取；若刷新后仍看到此页，请强制刷新（忽略缓存）后重试。
                </Text>
                <Button className="mt-2 w-full" label="刷新页面" variant="primary" onClick={() => location.reload()} />
              </VStack>
            </Card>
          </VStack>
        </Center>
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
