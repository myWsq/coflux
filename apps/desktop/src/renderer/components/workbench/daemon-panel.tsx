import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { Dialog as AstryxDialog, DialogHeader as AstryxDialogHeader } from "@astryxdesign/core/Dialog";
import { HStack, Layout, LayoutContent, LayoutFooter, VStack } from "@astryxdesign/core/Layout";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";

import { daemonStatusLine, resolveDaemonActions, type DaemonAction } from "@/components/workbench/daemon-view";
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

  return (
    <>
      <AstryxDialog isOpen={props.open} onOpenChange={(next) => !next && close()} width={440}>
        <Layout
          header={<AstryxDialogHeader title="这台 Mac" onOpenChange={(next) => !next && close()} hasDivider={false} />}
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
                  <Text type="supporting">关闭窗口后继续在线；退出 Coflux 会结束本机终端。</Text>
                  <Text type="supporting">正在运行的终端：{state.runningTerminals ?? props.runningTerminals}</Text>
                  {state.status === "update-ready" ? <Text type="supporting">本机终端更新已就绪，可以等当前任务结束后再安装。</Text> : null}
                  {!state.bundled ? <Text type="supporting">此构建缺少本机运行组件，请安装完整的 Coflux 应用。</Text> : null}
                </VStack>
              </VStack>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider={false}>
              <HStack gap={2} hAlign="end">
                {actions.length === 0 && state.busy ? <Text type="supporting">{line.label}</Text> : null}
                {actions.map((action) => (
                  <AstryxButton key={action.id} label={action.label} variant={action.kind} onClick={() => execute(action)} />
                ))}
              </HStack>
            </LayoutFooter>
          }
        />
      </AstryxDialog>
    </>
  );
}
