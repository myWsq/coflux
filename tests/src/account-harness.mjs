/** 账号 API 黑盒适配：仅 HTTP，不 import 应用实现。保持既有终端行为断言的视图结构。 */
export async function loginAccount(base, username = "admin", password = "admin") {
  const response = await fetch(`${base}/api/client/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ protocolVersion: 1, username, password }) });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`账号登录失败: ${JSON.stringify(result)}`);
  return result.value.token;
}
const statusName = status => status === 2 ? "running" : status === 3 ? "exited" : "idle";
const terminal = task => ({ ...task, deviceId: task.daemonId, status: statusName(task.status), exitCode: task.exitCode ?? null });
export async function callOperation(base, token, name, args = {}) {
  const names = { create_workspace: "workspace.new", rename_workspace: "workspace.rename", remove_workspace: "workspace.remove", create_terminal: "terminal.new", run_terminal: "terminal.run", read_terminal: "terminal.read", send_terminal_input: "terminal.send", wait_terminal: "terminal.wait", stop_terminal: "terminal.stop", remove_terminal: "terminal.remove" };
  let command = { op: names[name], ...args };
  if (name.startsWith("list_")) command = { op: "snapshot" };
  if (name === "send_terminal_input") command.enter = args.enter ?? true;
  if (name === "wait_terminal") { command.timeout = args.timeoutSeconds ?? 30; delete command.timeoutSeconds; }
  const response = await fetch(`${base}/api/client/command`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ protocolVersion: 1, command }) });
  const json = await response.json();
  if (!json.ok) return { status: response.status, json, result: { isError: true, content: [{ text: json.error }] } };
  let value = json.value;
  if (name.startsWith("list_")) {
    const key = name.slice(5);
    value = { [key]: value[key].filter(row => (!args.workspaceId || row.workspaceId === args.workspaceId) && (!args.projectId || row.projectId === args.projectId)).map(row => key === "devices" ? { ...row, id: row.daemonId } : key === "terminals" ? terminal(row) : row) };
  } else if (name === "create_workspace" || name === "rename_workspace") value = { workspace: value };
  else if (name === "create_terminal") value = { terminal: terminal(value) };
  else if (name === "read_terminal") value = { ...value, terminalId: value.task.id, status: statusName(value.task.status), exitCode: value.task.exitCode ?? null, snapshotAvailable: value.source !== "none" };
  // wait_terminal answers with the command's exit code (`finished`) or the shell's (`exited`); stop_terminal only knows the task.
  else if (name === "wait_terminal") value = { ...value, terminal: terminal(value.task), exitCode: value.exitCode ?? null };
  else if (name === "stop_terminal") value = { ...value, terminal: terminal(value.task), exitCode: value.exited ? value.task.exitCode ?? null : null };
  else if (name === "send_terminal_input") value = { ...value, terminalId: args.terminalId };
  else if (name === "remove_terminal") value = { terminalId: value };
  return { status: response.status, json, result: { structuredContent: value } };
}
