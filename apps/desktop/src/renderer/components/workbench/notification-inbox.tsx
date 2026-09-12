import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { Bell, CheckCheck, X } from "lucide-react";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import type { CofluxClient } from "@coflux/client";
import type { AccountNotification } from "@coflux/protocol";
import { desktop } from "@/config";

export function NotificationButton({ client, onOpen }: { client: CofluxClient; onOpen: () => void }) {
  const count = useStore(client.store, (state) => state.notificationInbox.unreadCount);
  return <Tooltip content="通知中心"><button type="button" onClick={onOpen} className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-sm hover:bg-accent" aria-label={`通知中心，${count} 条未读`}>
    <Bell className="size-4" /><span>通知</span>{count > 0 && <span className="ml-auto rounded-full bg-primary px-2 text-xs text-primary-foreground">{count > 99 ? "99+" : count}</span>}
  </button></Tooltip>;
}

export function NotificationInbox({ client, open, onClose, onOpen, onNavigate }: {
  client: CofluxClient; open: boolean; onClose: () => void; onOpen: () => void;
  onNavigate: (taskId: string) => boolean;
}) {
  const inbox = useStore(client.store, (state) => state.notificationInbox);
  const connected = useStore(client.store, (state) => state.status === "connected");
  const tasks = useStore(client.store, (state) => state.tasks);
  const workspaces = useStore(client.store, (state) => state.workspaces);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [hints, setHints] = useState<AccountNotification[]>([]);
  const [targetError, setTargetError] = useState("");
  function view(item: AccountNotification) {
    client.markNotificationRead(item.id);
    setHints((items) => items.filter((hint) => hint.id !== item.id));
    if (onNavigate(item.taskId)) { setTargetError(""); onClose(); }
    else { setTargetError("来源终端或工作区已删除，通知内容仍保留在历史中。"); onOpen(); }
  }
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [open]);
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
  useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [open, onClose]);
  return <>
    <div className="fixed right-4 top-10 z-50 flex w-80 flex-col gap-2" aria-live="polite">
      {hints.map((item) => <div key={item.id} className="flex rounded-lg border border-border bg-popover p-3 shadow-lg">
        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => view(item)}>
          <div className="text-xs text-muted-foreground">{item.workspaceName} · {item.terminalTitle}</div>
          <div className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-sm">{item.message}</div>
        </button><Tooltip content="关闭提示"><button type="button" aria-label="关闭提示" className="self-start p-1" onClick={() => setHints((items) => items.filter((hint) => hint.id !== item.id))}><X className="size-4" /></button></Tooltip>
      </div>)}
    </div>
    {open && <section onKeyDown={(event) => event.stopPropagation()} role="dialog" aria-modal="false" aria-label="通知中心" className="fixed bottom-14 left-3 z-40 flex max-h-[75vh] w-[420px] max-w-[calc(100vw-24px)] flex-col rounded-xl border border-border bg-popover text-popover-foreground shadow-xl">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3"><Bell className="size-4" /><h2 className="flex-1 font-medium">通知中心</h2>
        <Tooltip content="全部标为已读"><button type="button" aria-label="全部标为已读" disabled={!connected || !inbox.unreadCount} className="p-1 disabled:opacity-40" onClick={() => client.markNotificationRead()}><CheckCheck className="size-4" /></button></Tooltip>
        <Tooltip content="关闭通知中心"><button type="button" aria-label="关闭通知中心" ref={closeRef} className="p-1" onClick={onClose}><X className="size-4" /></button></Tooltip>
      </div>
      {!connected && <p className="px-4 py-2 text-xs text-muted-foreground">连接已断开，重连后同步通知。</p>}
      {(inbox.error || targetError) && <div role="status" className="px-4 py-2 text-sm text-destructive">{inbox.error || targetError}{inbox.error && <button type="button" disabled={!connected || inbox.loading} className="ml-2 underline" onClick={() => client.loadNotifications()}>重试</button>}</div>}
      <div className="min-h-0 overflow-y-auto">
        {inbox.items.map((item) => {
          const task = tasks.find((entry) => entry.id === item.taskId);
          const available = task && workspaces.some((entry) => entry.id === task.workspaceId);
          return <button type="button" key={item.id} className="flex w-full gap-3 border-b border-border px-4 py-3 text-left hover:bg-accent" onClick={() => view(item)}>
            <span className={`mt-1.5 size-2 shrink-0 rounded-full ${item.readAt ? "bg-transparent" : "bg-primary"}`} aria-label={item.readAt ? "已读" : "未读"} />
            <span className="min-w-0 flex-1"><span className="block whitespace-pre-wrap break-words text-sm">{item.message}</span>
              <span className="mt-2 block break-words text-xs text-muted-foreground">{item.deviceName} / {item.workspaceName} / {item.terminalTitle}</span>
              <time className="block text-xs text-muted-foreground" dateTime={new Date(item.createdAt).toISOString()}>{new Date(item.createdAt).toLocaleString()}</time>
              {!available && <span className="mt-1 block text-xs text-muted-foreground">来源已删除，无法跳转</span>}
            </span>
          </button>;
        })}
        {!inbox.items.length && !inbox.loading && !inbox.error && <p className="p-8 text-center text-sm text-muted-foreground">暂无通知</p>}
        {inbox.loading && <p role="status" className="p-4 text-center text-sm text-muted-foreground">正在加载通知…</p>}
        {inbox.nextBeforeSequence > 0 && <button type="button" disabled={inbox.loading || !connected} className="w-full p-3 text-sm text-muted-foreground" onClick={() => client.loadNotifications(true)}>加载更早通知</button>}
      </div>
    </section>}
  </>;
}
