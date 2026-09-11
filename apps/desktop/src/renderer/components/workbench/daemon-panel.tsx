import { useState } from "react";
import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { Dialog as AstryxDialog, DialogHeader as AstryxDialogHeader } from "@astryxdesign/core/Dialog";
import { HStack, Layout, LayoutContent, LayoutFooter, VStack } from "@astryxdesign/core/Layout";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";

import { daemonStatusLine, resolveDaemonActions, type DaemonAction } from "@/components/workbench/daemon-view";
import { ConfirmActionDialog, type ConfirmAction } from "@/components/workbench/dialogs";
import type { DesktopBridge, DesktopDaemonState } from "@/desktop-bridge";

type DaemonPanelDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: DesktopDaemonState;
  /** 本机运行中终端数（按 credentials.json 的 daemonId 匹配） */
  runningTerminals: number;
  bridge: DesktopBridge;
  /** 接入 / 授权 / FDA 引导都走接入引导对话框 */
  onOpenOnboarding: () => void;
};

/**
 * 账号菜单「本机 daemon」一行点开的面板（plan 113）：状态 + 版本 + ~/.coflux/bin 路径提示 + 动作。
 * 动作与确认文案由 daemon-view.ts 纯派生；二次确认沿用 ConfirmActionDialog。
 */
export function DaemonPanelDialog(props: DaemonPanelDialogProps) {
  const { state, bridge } = props;
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const line = daemonStatusLine(state);
  const actions = resolveDaemonActions(state, props.runningTerminals);

  function close() {
    bridge.daemonDismissError();
    props.onOpenChange(false);
  }

  function execute(action: DaemonAction) {
    switch (action.id) {
      case "enroll":
      case "authorize":
      case "fda":
        props.onOpenChange(false);
        props.onOpenOnboarding();
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

  function trigger(action: DaemonAction) {
    if (!action.confirm) {
      execute(action);
      return;
    }
    setConfirm({ ...action.confirm, onConfirm: () => execute(action) });
  }

  return (
    <>
      <AstryxDialog isOpen={props.open} onOpenChange={(next) => !next && close()} width={440}>
        <Layout
          header={<AstryxDialogHeader title="本机 daemon" onOpenChange={(next) => !next && close()} hasDivider={false} />}
          content={
            <LayoutContent>
              <VStack gap={3} hAlign="stretch">
                <HStack gap={2} vAlign="center">
                  <StatusDot variant={line.tone} label={line.label} isPulsing={line.pulsing} />
                  <Text type="body">{line.label}</Text>
                  {line.detail ? (
                    <Text type="supporting" color={line.tone === "error" ? undefined : "secondary"}>
                      {line.detail}
                    </Text>
                  ) : null}
                </HStack>
                <VStack gap={1} hAlign="stretch">
                  <Text type="supporting">
                    二进制目录 <Text type="code">{state.binDir}</Text>
                  </Text>
                  <Text type="supporting">想在自己的终端里直接用 cofluxd 就把它加进 PATH；coflux 里开的终端已自动带上，不改你的 shell 配置。</Text>
                  {state.runningVersion ? <Text type="supporting">在跑 supervisor：{state.runningVersion}</Text> : null}
                  {state.bundledVersion ? <Text type="supporting">app 内置：{state.bundledVersion}</Text> : null}
                  {!state.bundled ? <Text type="supporting">本构建不带内置 daemon：只能查看状态，接入 / 更新走 npm i -g cofluxd。</Text> : null}
                </VStack>
              </VStack>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider={false}>
              <HStack gap={2} hAlign="end">
                {actions.length === 0 && state.busy ? <Text type="supporting">{line.label}</Text> : null}
                {actions.map((action) => (
                  <AstryxButton key={action.id} label={action.label} variant={action.kind} onClick={() => trigger(action)} />
                ))}
              </HStack>
            </LayoutFooter>
          }
        />
      </AstryxDialog>
      <ConfirmActionDialog action={confirm} onCancel={() => setConfirm(null)} />
    </>
  );
}
