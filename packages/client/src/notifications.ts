import type { AccountNotification, NotificationChanged, NotificationPage } from "@coflux/protocol";

export type NotificationInbox = {
  items: AccountNotification[];
  unreadCount: number;
  revision: number;
  latestSequence: number;
  nextBeforeSequence: number;
  readThroughSequence: number;
  readThroughAt: number;
  ready: boolean;
  loading: boolean;
  error: string;
};
export function emptyNotificationInbox(): NotificationInbox {
  return { items: [], unreadCount: 0, revision: 0, latestSequence: 0, nextBeforeSequence: 0,
    readThroughSequence: 0, readThroughAt: 0, ready: false, loading: false, error: "" };
}
function mergeItems(state: NotificationInbox, incoming: AccountNotification[]): AccountNotification[] {
  const entries = new Map(state.items.map((item) => [item.id, item]));
  for (const item of incoming) {
    const readAt = Math.max(item.readAt, entries.get(item.id)?.readAt ?? 0,
      item.sequence <= state.readThroughSequence ? state.readThroughAt : 0);
    entries.set(item.id, { ...item, readAt });
  }
  return [...entries.values()].sort((a, b) => b.sequence - a.sequence);
}
function summary(state: NotificationInbox, update: NotificationPage | NotificationChanged) {
  return update.revision >= state.revision
    ? { unreadCount: update.unreadCount, revision: update.revision, latestSequence: Math.max(state.latestSequence, update.latestSequence) }
    : {};
}
export function applyNotificationPage(state: NotificationInbox, page: NotificationPage): NotificationInbox {
  if (page.error) return { ...state, loading: false, error: page.error };
  return { ...state, ...summary(state, page), items: mergeItems(page.requestId === "initial" ? { ...state, items: state.items.filter((item) => page.notifications.some((entry) => entry.id === item.id)) } : state, page.notifications),
    nextBeforeSequence: page.nextBeforeSequence, ready: true, loading: false, error: "" };
}
export function applyNotificationChange(state: NotificationInbox, change: NotificationChanged): NotificationInbox {
  if (change.error) return { ...state, error: change.error };
  const next = { ...state, ...summary(state, change), error: "" };
  if (change.readThroughSequence > 0) {
    next.readThroughSequence = Math.max(state.readThroughSequence, change.readThroughSequence);
    next.readThroughAt = Math.max(state.readThroughAt, change.readAt);
    next.items = state.items.map((item) => item.sequence <= change.readThroughSequence ? { ...item, readAt: Math.max(item.readAt, change.readAt) } : item);
  }
  if (change.notification) next.items = mergeItems(next, [change.notification]);
  return next;
}
