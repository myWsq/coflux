import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu";
import { Text } from "@astryxdesign/core/Text";
import { useStore } from "zustand";
import { Bell, X } from "lucide-react";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import type { CofluxClient } from "@coflux/client";
import type { AccountNotification } from "@coflux/protocol";
import { desktop } from "@/config";

export function NotificationInbox({ client, open, onClose, onOpen, onNavigate }: {
  client: CofluxClient; open: boolean; onClose: () => void; onOpen: () => void;
  onNavigate: (taskId: string) => boolean;
}) {
  const inbox = useStore(client.store, (state) => state.notificationInbox);
  const connected = useStore(client.store, (state) => state.status === "connected");
  const tasks = useStore(client.store, (state) => state.tasks);
  const projects = useStore(client.store, (state) => state.projects);
  const workspaces = useStore(client.store, (state) => state.workspaces);
  const [hints, setHints] = useState<AccountNotification[]>([]);
  const [targetError, setTargetError] = useState("");
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  function view(item: AccountNotification) {
    client.markNotificationRead(item.id);
    setHints((items) => items.filter((hint) => hint.id !== item.id));
    if (onNavigate(item.taskId)) { setTargetError(""); onClose(); }
    else { setTargetError("来源终端或工作区已删除，通知内容仍保留在历史中。"); queueMicrotask(onOpen); }
  }
  useEffect(() => client.onNotification((item) => {
    if (document.hasFocus() && document.visibilityState === "visible") setHints((items) => [...items.slice(-3), item]);
    // The main process independently checks actual window focus/visibility.
    desktop.notify({ notificationId: item.id, taskId: item.taskId, workspaceId: item.workspaceId,
      title: `${item.workspaceName} · ${item.terminalTitle}`, body: item.message });
  }), [client]);
  useEffect(() => desktop.onFocusNotification((target) => {
    const item = client.store.getState().notificationInbox.items.find((entry) => entry.id === target.notificationId);
    if (item) view(item);
    else {
      if (target.notificationId) client.markNotificationRead(target.notificationId);
      if (!target.taskId || !onNavigate(target.taskId)) { setTargetError("来源终端已不存在，可在通知历史中查看留言。"); onOpen(); }
    }
  }));
  useEffect(() => {
    if (!hints.length) return;
    const timer = setTimeout(() => setHints((items) => items.slice(1)), 10000);
    return () => clearTimeout(timer);
  }, [hints]);
  return <>
    {createPortal(<div className="fixed right-4 top-10 z-50 flex w-80 flex-col gap-2" aria-live="polite">
      {hints.map((item) => <div key={item.id} className="flex rounded-lg border border-border bg-popover p-3 shadow-lg">
        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => view(item)}>
          <div className="text-xs text-muted-foreground">{item.workspaceName} · {item.terminalTitle}</div>
          <div className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-sm">{item.message}</div>
        </button><Tooltip content="关闭提示"><button type="button" aria-label="关闭提示" className="self-start p-1" onClick={() => setHints((items) => items.filter((hint) => hint.id !== item.id))}><X className="size-4" /></button></Tooltip>
      </div>)}
    </div>, document.body)}
    <DropdownMenu
      isMenuOpen={open}
      onOpenChange={(next) => next ? onOpen() : onClose()}
      menuWidth={320}
      hasChevron={false}
      placement="below"
      button={{
        ref: anchorRef,
        label: `通知中心，${inbox.unreadCount} 条未读`,
        icon: <span className="relative flex"><Bell className="size-3.5" />{inbox.unreadCount > 0 && <span aria-hidden className="absolute -right-0.5 -top-0.5 size-1 rounded-full bg-primary" />}</span>,
        isIconOnly: true,
        variant: "ghost",
        size: "sm",
        style: { color: "var(--muted-foreground)", height: 24, width: 24, minWidth: 24, paddingInline: 0 },
      }}
    >
      {open && <div className="flex w-full flex-col">
        {!connected && <div className="px-2 py-1.5"><Text type="supporting">连接已断开，重连后同步通知。</Text></div>}
        {(inbox.error || targetError) && <div role="status" className="px-2 py-1.5"><Text type="supporting">{inbox.error || targetError}</Text></div>}
        {inbox.error && <DropdownMenuItem label="重试" isDisabled={!connected || inbox.loading} onClick={() => client.loadNotifications()} />}
        <div className="-mr-1 max-h-80 overflow-y-auto pr-1" onScroll={(event) => {
          const list = event.currentTarget;
          if (list.scrollHeight - list.scrollTop - list.clientHeight < 48 && inbox.nextBeforeSequence > 0 && !inbox.loading && !inbox.error && connected) client.loadNotifications(true);
        }}>
          {inbox.items.map((item) => {
            const task = tasks.find((entry) => entry.id === item.taskId);
            const workspace = workspaces.find((entry) => entry.id === item.workspaceId);
            const project = projects.find((entry) => entry.id === workspace?.projectId);
            const available = task && workspace;
            return <DropdownMenuItem
              key={item.id}
              label={<span className="line-clamp-2 whitespace-pre-wrap break-words">{item.message}</span>}
              description={<span className="block whitespace-normal break-words">
                {[project?.name, item.workspaceName, item.terminalTitle, item.deviceName].filter(Boolean).join(" / ")}
                {!available && <span className="block">来源已删除，无法跳转</span>}
              </span>}
              onClick={() => view(item)}
            />;
          })}
          {!inbox.items.length && !inbox.loading && !inbox.error && <div className="px-2 py-1.5"><Text type="supporting">暂无通知</Text></div>}
          {inbox.loading && <div role="status" className="px-2 py-1.5"><Text type="supporting">正在加载通知…</Text></div>}
        </div>
      </div>}
    </DropdownMenu>
    {/* 不能用 DropdownMenu 的 button.tooltip：菜单打开时它把 tooltip 丢掉（DropdownMenu.js:307），
        Button 于是在 tooltip 正显示时卸载它的 popover 节点，而移除 popover 不触发 toggle，
        useLayer 的 open 标志滞留为真，之后 show() 一直被守卫吞掉——表现为点过菜单后 tooltip 不再出现。
        sibling Tooltip 的节点不会被卸载，受控 isOpen 走正常的 hide 复位。渲染在菜单之后，
        这样首挂时 Button 的 ref 已经附上。见 docs/design-guidelines.md。 */}
    <Tooltip anchorRef={anchorRef} isOpen={open ? false : undefined} content={inbox.unreadCount > 0 ? `通知中心 · ${inbox.unreadCount} 条未读` : "通知中心"} />
  </>;
}
