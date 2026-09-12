import { test } from "node:test";
import assert from "node:assert/strict";
import { create, AccountNotificationSchema, NotificationPageSchema, NotificationChangedSchema } from "@coflux/protocol";
import { emptyNotificationInbox, applyNotificationPage, applyNotificationChange } from "./notifications";
const item = (sequence: number, readAt = 0) => create(AccountNotificationSchema, { id: String(sequence), sequence, readAt, message: `Message ${sequence}` });
const page = (items: ReturnType<typeof item>[], revision: number, unreadCount: number, requestId = "page") => create(NotificationPageSchema, { notifications: items, revision, unreadCount, latestSequence: 100, requestId });

test("a delayed page cannot undo read changes or regress unread count", () => {
  let state = applyNotificationPage(emptyNotificationInbox(), page([item(10)], 1, 1));
  state = applyNotificationChange(state, create(NotificationChangedSchema, { notification: item(10, 123), revision: 3, unreadCount: 0 }));
  state = applyNotificationPage(state, page([item(10)], 2, 1));
  assert.equal(state.items[0].readAt, 123);
  assert.equal(state.unreadCount, 0);
});
test("mark-all uses a cutoff and also applies to an older page arriving later", () => {
  let state = applyNotificationPage(emptyNotificationInbox(), page([item(10), item(11)], 1, 3));
  state = applyNotificationChange(state, create(NotificationChangedSchema, { readThroughSequence: 10, readAt: 123, revision: 3, unreadCount: 1 }));
  state = applyNotificationPage(state, page([item(5)], 2, 3));
  assert.equal(state.items.find((entry) => entry.id === "5")!.readAt, 123);
  assert.equal(state.items.find((entry) => entry.id === "11")!.readAt, 0);
  assert.equal(state.unreadCount, 1);
});
test("reconnect discards stale unloaded history and keeps first page authoritative", () => {
  let state = applyNotificationPage(emptyNotificationInbox(), page([item(1), item(100)], 1, 2));
  state = applyNotificationPage(state, page([item(100, 123)], 4, 0, "initial"));
  assert.deepEqual(state.items.map((entry) => entry.id), ["100"]);
  assert.equal(state.unreadCount, 0);
});
