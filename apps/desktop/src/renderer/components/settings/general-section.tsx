import { useStore } from "zustand";
import { Button } from "@astryxdesign/core/Button";
import { VStack } from "@astryxdesign/core/Layout";
import type { CofluxClient } from "@coflux/client";

import { SettingsGroup, SettingsRow } from "@/components/settings/settings-group";
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
      <SettingsGroup title="账号">
        <SettingsRow label={identity.label} description="当前登录的账号" />
        <SettingsRow
          label={serverHostLabel(SERVER_URL)}
          description="所连服务器。切换会退出当前登录。"
          control={<Button label="修改…" variant="secondary" size="sm" onClick={() => desktop.showServerInfo()} />}
        />
      </SettingsGroup>

      <SettingsGroup title="更新">
        <SettingsRow
          label={desktop.version ? `Coflux v${desktop.version}` : "Coflux 开发版"}
          description={view.updateItem.detail || view.updateItem.label}
          control={
            <Button
              label={view.updateItem.action === "install" ? "重启并更新" : "检查更新"}
              variant={view.updateItem.action === "install" ? "primary" : "secondary"}
              size="sm"
              isDisabled={view.updateItem.isDisabled}
              onClick={() => (view.updateItem.action === "install" ? desktop.installUpdate() : desktop.checkForUpdates())}
            />
          }
        />
      </SettingsGroup>
    </VStack>
  );
}
