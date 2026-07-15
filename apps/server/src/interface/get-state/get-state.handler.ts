import { withSchema } from "@raven.js/core";
import { create, toJson, StateSnapshotSchema } from "@coflux/protocol";
import { GetStateContract } from "./get-state.contract.js";
import { HubState } from "../../plugins/hub.plugin.js";
import { CurrentAccount } from "../../plugins/api-auth.plugin.js";

export const GetStateHandler = withSchema(GetStateContract.schemas, async () => {
  const accountId = CurrentAccount.getOrFailed();
  const snapshot = await HubState.getOrFailed().snapshot(accountId);
  // 经真实 proto 消息往返再出 protojson：与 WS stateSnapshot 完全同一形状来源，
  // 枚举输出名字（如 TASK_STATUS_RUNNING）而非数字，对脚本/运维可读。
  return Response.json(toJson(StateSnapshotSchema, create(StateSnapshotSchema, snapshot)));
});
