import { useStore } from "zustand";
import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import type { CofluxClient } from "@coflux/client";

import { accountIdentity, resolveAccountFooter, serverHostLabel } from "@/components/workbench/account-footer-view";
import { useDesktopUpdateState } from "@/components/workbench/use-desktop-update";
import { SERVER_URL, desktop } from "@/config";

/**
 * 设置页的「通用」分区：当前账号身份、所连服务器、桌面版本与更新。
 *
 * 服务器地址这一行原来是账号菜单的「服务器地址…」，改地址仍然走主进程的原生对话框
 * （它会重启到登录态，不是渲染层能就地改的东西），这里只把当前值显示出来并提供入口。
 * 更新一行复用账号脚部那套状态映射（resolveAccountFooter），文案与脚部、菜单保持同一口径。
 */
export function GeneralSection({ client }: { client: CofluxClient }) {
  const loginName = useStore(client.store, (state) => state.loginName);
  const update = useDesktopUpdateState(desktop);

  const identity = accountIdentity(loginName);
  const view = resolveAccountFooter(update, desktop.version);

  return (
    <VStack gap={5} hAlign="stretch">
      <VStack gap={1} hAlign="stretch">
        <Text type="label">账号</Text>
        <Text type="body">{identity.label}</Text>
      </VStack>

      <VStack gap={1} hAlign="stretch">
        <Text type="label">服务器</Text>
        <HStack gap={2} vAlign="center">
          <Text type="body">{serverHostLabel(SERVER_URL)}</Text>
          <AstryxButton label="修改…" variant="ghost" size="sm" onClick={() => desktop.showServerInfo()} />
        </HStack>
        <Text type="supporting">切换服务器会退出当前登录。</Text>
      </VStack>

      <VStack gap={1} hAlign="stretch">
        <Text type="label">版本</Text>
        <HStack gap={2} vAlign="center">
          <Text type="body">{desktop.version ? `v${desktop.version}` : "开发版"}</Text>
          <AstryxButton
            label={view.updateItem.label}
            variant={view.updateItem.action === "install" ? "primary" : "ghost"}
            size="sm"
            isDisabled={view.updateItem.isDisabled}
            onClick={() => (view.updateItem.action === "install" ? desktop.installUpdate() : desktop.checkForUpdates())}
          />
        </HStack>
        {view.updateItem.detail ? <Text type="supporting">{view.updateItem.detail}</Text> : null}
      </VStack>
    </VStack>
  );
}
