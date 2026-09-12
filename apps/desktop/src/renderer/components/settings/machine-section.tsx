import { useEffect } from "react";
import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";

import { SettingsGroup, SettingsRow } from "@/components/settings/settings-group";
import { daemonStatusLine, resolveDaemonActions, type DaemonAction } from "@/components/workbench/daemon-view";
import type { DesktopBridge, DesktopDaemonState } from "@/desktop-bridge";

type MachineSectionProps = {
  state: DesktopDaemonState;
  /** 本机运行中终端数（按 credentials.json 的 daemonId 匹配） */
  runningTerminals: number;
  bridge: DesktopBridge;
  /** 接入 / 授权 / FDA 引导都走接入引导对话框（由上层先收起设置页再打开） */
  onOpenOnboarding: () => void;
};

/**
 * 设置页的「这台 Mac」分区（原先是账号菜单里点开的 daemon 面板对话框，plan 113）：
 * 状态 + 正在运行的终端 + 动作。动作与二次确认文案仍由 daemon-view.ts 纯派生。
 *
 * 离开这个分区时清掉一次性的错误提示，和原来关闭面板时的语义一致——错误横幅不该跟着用户
 * 一路留在设置页上。
 */
export function MachineSection({ state, runningTerminals, bridge, onOpenOnboarding }: MachineSectionProps) {
  const line = daemonStatusLine(state);
  const actions = resolveDaemonActions(state, runningTerminals);

  useEffect(() => () => bridge.daemonDismissError(), [bridge]);

  function execute(action: DaemonAction) {
    switch (action.id) {
      case "enroll":
      case "authorize":
      case "fda":
        onOpenOnboarding();
        return;
      case "start":
      case "restart":
      case "update":
        bridge.daemonRestart();
        return;
      case "stop":
        bridge.daemonStop();
        return;
      case "remove":
        bridge.daemonRemove();
        return;
    }
  }

  return (
    <VStack gap={5} hAlign="stretch">
      <SettingsGroup title="状态">
        <SettingsRow
          label={line.label}
          description={line.detail || "关闭窗口后继续在线；退出 Coflux 会结束本机终端。"}
          control={<StatusDot variant={line.tone} label={line.label} isPulsing={line.pulsing} />}
        />
        <SettingsRow
          label="正在运行的终端"
          description={state.status === "update-ready" ? "本机终端更新已就绪，可以等当前任务结束后再安装。" : undefined}
          control={<Text type="body">{state.runningTerminals ?? runningTerminals}</Text>}
        />
        {!state.bundled ? (
          <SettingsRow label="缺少本机运行组件" description="此构建不含 daemon，请安装完整的 Coflux 应用。" />
        ) : null}
      </SettingsGroup>

      {actions.length > 0 || state.busy ? (
        <HStack gap={2} vAlign="center">
          {actions.map((action) => (
            <Button key={action.id} label={action.label} variant={action.kind} size="sm" onClick={() => execute(action)} />
          ))}
          {actions.length === 0 && state.busy ? <Text type="supporting">{line.label}</Text> : null}
        </HStack>
      ) : null}
    </VStack>
  );
}
