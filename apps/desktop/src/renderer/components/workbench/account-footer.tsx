import { useStore } from "zustand";
import { Avatar } from "@astryxdesign/core/Avatar";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { ArrowUp, Bot, Cog, LogOut, Monitor, RefreshCw, Server } from "lucide-react";
import type { CofluxClient } from "@coflux/client";

import { accountIdentity, resolveAccountFooter, serverHostLabel } from "@/components/workbench/account-footer-view";
import { daemonStatusLine } from "@/components/workbench/daemon-view";
import { useDesktopUpdateState } from "@/components/workbench/use-desktop-update";
import { SERVER_URL, desktop } from "@/config";
import type { DesktopDaemonState } from "@/desktop-bridge";

/**
 * 侧栏底部的账号脚部（plan 110，Cursor 左下角那一行）：头像 + 登录身份 + 所连服务器 host + 尾部按钮。
 *
 * 整行本身就是下拉菜单的触发按钮（齿轮画在按钮内部，因此「点整行」与「点齿轮」天然是同一个菜单，
 * 也不会出现 button 套 button）。菜单三项：检查更新（文案随更新状态变）/ 服务器地址…（主进程原生
 * 对话框）/ 登出（本机有活终端时先确认，停止并清理成功后回登录页）。
 *
 * 只有「新版本已下载」时尾部齿轮换成强调色「更新」按钮，此时它作为触发按钮的兄弟节点渲染，整行
 * 仍能打开菜单。脚部**不**触发更新检查（见 use-desktop-update.ts）。
 *
 * 「本机 daemon」一行（plan 113）：状态点 + 状态短语 + 副文案，点开面板看路径提示与动作；状态对象由
 * Workbench 订阅后传下来（同一份也驱动接入引导的自动弹出）。
 */
export function AccountFooter({
  client,
  daemonState,
  onOpenDaemonPanel,
  onOpenExecutorSettings,
}: {
  client: CofluxClient;
  /** null = 还没拿到第一份状态 */
  daemonState: DesktopDaemonState | null;
  onOpenDaemonPanel: () => void;
  onOpenExecutorSettings: () => void;
}) {
  const loginName = useStore(client.store, (state) => state.loginName);
  const update = useDesktopUpdateState(desktop);

  const identity = accountIdentity(loginName);
  const host = serverHostLabel(SERVER_URL);
  const view = resolveAccountFooter(update, desktop.version);
  const daemonLine = daemonState ? daemonStatusLine(daemonState) : null;

  return (
    <div className="flex shrink-0 items-center gap-1 border-t border-border px-2 py-2">
      <DropdownMenu
        placement="above"
        menuWidth={240}
        hasChevron={false}
        button={{
          // children 覆盖可见内容，label 仍是无障碍名
          label: "账号菜单",
          variant: "ghost",
          className: "h-auto min-w-0 flex-1 justify-between rounded-md px-1.5 py-1 text-left",
          endContent: view.tail === "gear" ? <Cog className="size-3.5 text-muted-foreground" /> : undefined,
          children: (
            <span className="flex min-w-0 items-center gap-2">
              <Avatar name={identity.avatarName} size="xsmall" />
              <span className="flex min-w-0 flex-col items-start">
                <span
                  className={identity.isPlaceholder ? "max-w-full truncate text-base text-muted-foreground" : "max-w-full truncate text-base text-foreground"}
                  title={identity.label}
                >
                  {identity.label}
                </span>
                <span className="max-w-full truncate text-xs text-muted-foreground" title={host}>
                  {host}
                </span>
              </span>
            </span>
          ),
        }}
      >
        <DropdownMenuItem
          icon={<RefreshCw className="size-3.5" />}
          label={view.updateItem.label}
          description={view.updateItem.detail || undefined}
          isDisabled={view.updateItem.isDisabled}
          onClick={() => (view.updateItem.action === "install" ? desktop.installUpdate() : desktop.checkForUpdates())}
        />
        <DropdownMenuItem icon={<Server className="size-3.5" />} label="服务器地址…" onClick={() => desktop.showServerInfo()} />
        <DropdownMenuItem
          icon={<Monitor className="size-3.5" />}
          label="这台 Mac"
          description={daemonLine ? (daemonLine.detail ? `${daemonLine.label} · ${daemonLine.detail}` : daemonLine.label) : "正在读取状态…"}
          endContent={daemonLine ? <StatusDot variant={daemonLine.tone} label={daemonLine.label} isPulsing={daemonLine.pulsing} /> : undefined}
          isDisabled={!daemonState}
          onClick={onOpenDaemonPanel}
        />
        <DropdownMenuItem
          icon={<Bot className="size-3.5" />}
          label="Executor 设置…"
          description="agent 甩给 coflux 执行的任务用哪个模型"
          onClick={onOpenExecutorSettings}
        />
        <Divider />
        <DropdownMenuItem icon={<LogOut className="size-3.5" />} label="登出" onClick={() => { void desktop.logoutLocal().then((confirmed) => { if (confirmed) client.logout(false); }); }} />
      </DropdownMenu>

      {view.tail === "install" ? (
        <Button
          className="shrink-0"
          label="更新"
          tooltip={view.installHint}
          variant="primary"
          size="sm"
          icon={<ArrowUp className="size-3.5" />}
          onClick={() => desktop.installUpdate()}
        />
      ) : null}
    </div>
  );
}
