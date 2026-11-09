import assert from "node:assert/strict";
import { test } from "node:test";

import {
  conversationTerms,
  createDictationContextSource,
  dictationTranscriptCommand,
  parseDictationOutput,
  recognitionItems,
  repositoryTerms,
  termSentence,
  workspaceSentence,
} from "./dictation-context";

const CLAUDE_ID = "6fd5b5f9-959b-4845-91b8-e2f6cefc1a51";

function jsonl(...records: unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

test("claude transcript: prompts, prose, reasoning and tool inputs; tool results and injections dropped", () => {
  const body = jsonl(
    { type: "user", message: { content: "<command-name>/clear</command-name>" } },
    { type: "user", message: { content: "把 store.ts 的 rebase 逻辑改一下" } },
    {
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "Need to read store.ts" },
          { type: "text", text: "我先看看。" },
          { type: "tool_use", name: "Read", input: { file_path: "/repo/src/store.ts", content: "not a name" } },
          { type: "tool_use", name: "Edit", input: { old_string: "a", new_string: "b" } },
        ],
      },
    },
    { type: "user", message: { content: [{ type: "tool_result", content: "file contents" }] } },
    { type: "user", isMeta: true, message: { content: "meta" } },
    { type: "user", message: { content: [{ type: "text", text: "<system-reminder>x</system-reminder>" }] } },
    { type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "subagent" }] } },
  );
  // A tail read starts mid-line: the fragment is skipped like any unparsable line.
  const entries = parseDictationOutput("claude", `coflux-transcript 1234 262144\nated":1}\n${body}`);
  assert.deepEqual(entries, [
    { speaker: "person", text: "把 store.ts 的 rebase 逻辑改一下" },
    { speaker: "agent", text: "Need to read store.ts" },
    { speaker: "agent", text: "我先看看。" },
    { speaker: "tool", text: "/repo/src/store.ts", tool: "Read" },
  ]);
});

test("codex transcript: user and assistant messages, reasoning, command first line; outputs and context dropped", () => {
  const body = jsonl(
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n<cwd>/x</cwd>\n</environment_context>" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "跑一下 pnpm test" }] } },
    { type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "Running the tests" }] } },
    {
      type: "response_item",
      payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "pnpm -C apps/desktop test\necho done"], workdir: "/repo" }) },
    },
    { type: "response_item", payload: { type: "function_call_output", output: "ok" } },
    { type: "event_msg", payload: { type: "agent_message", message: "duplicate" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "测试通过。" }] } },
    { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "instructions" }] } },
  );
  const entries = parseDictationOutput("codex", `coflux-transcript 99 262144\n${body}`);
  assert.deepEqual(entries, [
    { speaker: "person", text: "跑一下 pnpm test" },
    { speaker: "agent", text: "Running the tests" },
    { speaker: "tool", text: "pnpm -C apps/desktop test", tool: "shell" },
    { speaker: "agent", text: "测试通过。" },
  ]);
  assert.equal(parseDictationOutput("codex", body), null);
});

test("recognition budget keeps the newest text and cuts the crossing entry from its start", () => {
  const sentence = "当前项目 x。";
  const entries = [
    { speaker: "person" as const, text: "旧".repeat(1000) },
    { speaker: "tool" as const, text: "src/never.ts", tool: "Read" },
    { speaker: "agent" as const, text: "新".repeat(1000) },
  ];
  const { items, includesConversation } = recognitionItems(sentence, null, entries);
  assert.equal(includesConversation, true);
  assert.deepEqual(items, [sentence, `Agent：${"新".repeat(1000)}`, `我：…${"旧".repeat(488)}`]);
});

test("the transcript command passes the id and sizes as positional arguments only", () => {
  const { command, args } = dictationTranscriptCommand("claude", CLAUDE_ID, "correction");
  assert.equal(command, "sh");
  assert.equal(args[0], "-c");
  assert.equal(args[1]!.includes(CLAUDE_ID), false);
  assert.deepEqual(args.slice(2), ["sh", CLAUDE_ID, String(8 * 1024 * 1024), String(1024 * 1024)]);
  assert.ok(args[1]!.includes(`printf 'coflux-transcript %s %s\\n' "$size" "$limit"`));
});

test("terms: repository listing and conversation identifiers", () => {
  assert.deepEqual(repositoryTerms("apps/desktop/src/store.ts\napps/desktop/README.md\npackages/client/src/store.ts\ntrunc"), [
    "desktop",
    "packages",
    "client",
    "store",
    "store.ts",
    "README.md",
  ]);
  assert.deepEqual(conversationTerms([{ speaker: "person", text: "改一下 useDictation 和 the `cofluxd` thing" }]), ["useDictation", "cofluxd"]);
  assert.equal(termSentence(["store.ts", "useDictation"], 200), "相关术语：store.ts、useDictation。");
  assert.equal(termSentence([], 200), null);
});

test("a plain shell pane yields the workspace sentence only; read failures degrade", async () => {
  const sentence = workspaceSentence("coflux", "20261110-desktop-dictation", "dev/20261110-desktop-dictation");
  assert.equal(sentence, "当前项目 coflux，工作区 20261110-desktop-dictation，分支 dev/20261110-desktop-dictation。");
  const failing = createDictationContextSource({
    exec: async () => {
      throw new Error("offline");
    },
    workspaceId: "w",
    workspaceSentence: sentence,
    agent: null,
    agentSessionId: null,
  });
  assert.equal(await failing.readTranscript("recognition"), null);
  assert.deepEqual(await failing.readRepositoryTerms(), []);
  assert.deepEqual(failing.recognitionContext(null, null), { items: [sentence] });
  assert.deepEqual(failing.refineContext(null, null), { workspaceSentence: sentence, terms: [], entries: [] });
});
