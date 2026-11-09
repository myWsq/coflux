import assert from "node:assert/strict";
import { test } from "node:test";

import { openAIPrompt, openAISessionUpdate, openAISocketUrl } from "./dictation-openai";
import { acceptedAnswer, refineEndpoint, refineRequestBody, refineUserMessage } from "./dictation-refine";
import {
  parseSeedFrame,
  SEED_BYTES_PER_FRAME,
  SEED_FLAGS,
  SEED_MESSAGE_TYPE,
  SEED_SERIALIZATION,
  seedConfigPayload,
  seedFrame,
  seedResultText,
} from "./dictation-seed";

test("seed config frame: full client request, sequence 1, JSON payload with the dialog context", () => {
  const payload = seedConfigPayload(["当前项目 coflux，分支 main。", "我：把 store.ts 改一下"]);
  const frame = seedFrame(SEED_MESSAGE_TYPE.fullClientRequest, SEED_FLAGS.sequence, SEED_SERIALIZATION.json, 1, payload);
  assert.deepEqual([...frame.subarray(0, 12)], [0x11, 0x11, 0x10, 0x00, 0, 0, 0, 1, ...uint32(payload.length)]);
  assert.deepEqual(frame.subarray(12), payload);
  const body = JSON.parse(payload.toString("utf8"));
  assert.deepEqual(body.user, { uid: "coflux-ios" });
  assert.deepEqual(body.audio, { format: "pcm", codec: "raw", rate: 16000, bits: 16, channel: 1 });
  assert.equal(body.request.model_name, "bigmodel");
  assert.equal(body.request.result_type, "full");
  assert.deepEqual(JSON.parse(body.request.corpus.context), {
    context_type: "dialog_ctx",
    context_data: [{ text: "当前项目 coflux，分支 main。" }, { text: "我：把 store.ts 改一下" }],
  });
});

test("seed config payload without context has no corpus", () => {
  const body = JSON.parse(seedConfigPayload([]).toString("utf8"));
  assert.equal("corpus" in body.request, false);
});

test("seed audio frames: raw PCM, positive sequence, and the last one negative", () => {
  const pcm = Buffer.from([1, 2, 3, 4]);
  const frame = seedFrame(SEED_MESSAGE_TYPE.audioOnlyRequest, SEED_FLAGS.sequence, SEED_SERIALIZATION.none, 2, pcm);
  assert.deepEqual([...frame], [0x11, 0x21, 0x00, 0x00, 0, 0, 0, 2, 0, 0, 0, 4, 1, 2, 3, 4]);
  const last = seedFrame(SEED_MESSAGE_TYPE.audioOnlyRequest, SEED_FLAGS.lastWithNegativeSequence, SEED_SERIALIZATION.none, -3, Buffer.alloc(0));
  assert.deepEqual([...last], [0x11, 0x23, 0x00, 0x00, 0xff, 0xff, 0xff, 0xfd, 0, 0, 0, 0]);
  assert.equal(SEED_BYTES_PER_FRAME, 6400);
});

test("seed server response frame decodes to its text and whether it is settled", () => {
  const payload = Buffer.from(JSON.stringify({ result: { text: "把 rebase 做完", utterances: [{ definite: true }, { definite: false }] } }), "utf8");
  const frame = Buffer.concat([Buffer.from([0x11, 0x91, 0x10, 0x00, 0, 0, 0, 5]), Buffer.from(uint32(payload.length)), payload]);
  const parsed = parseSeedFrame(frame);
  assert.ok(parsed && parsed.kind === "result");
  assert.equal(parsed.isLast, false);
  assert.deepEqual(seedResultText(parsed.payload), { text: "把 rebase 做完", settled: false });

  const lastPayload = Buffer.from(JSON.stringify({ result: [{ text: "好了", utterances: [{ definite: true }] }] }), "utf8");
  const lastFrame = Buffer.concat([Buffer.from([0x11, 0x93, 0x10, 0x00, 0xff, 0xff, 0xff, 0xfa]), Buffer.from(uint32(lastPayload.length)), lastPayload]);
  const lastParsed = parseSeedFrame(lastFrame);
  assert.ok(lastParsed && lastParsed.kind === "result");
  assert.equal(lastParsed.isLast, true);
  assert.deepEqual(seedResultText(lastParsed.payload), { text: "好了", settled: true });
});

test("seed error frame and unreadable frames", () => {
  const error = Buffer.from([0x11, 0xf0, 0x10, 0x00, 0, 0, 0x2d, 0x5e, 0, 0, 0, 0]);
  assert.deepEqual(parseSeedFrame(error), { kind: "error", code: 11614 });
  assert.equal(parseSeedFrame(Buffer.from([0x11, 0x91])), null);
  // Compressed (gzip) is never asked for, so it is unreadable.
  assert.equal(parseSeedFrame(Buffer.from([0x11, 0x91, 0x11, 0x00, 0, 0, 0, 1, 0, 0, 0, 0])), null);
});

test("openai socket URL, session update and prompt order", () => {
  assert.equal(openAISocketUrl("https://api.openai.com/v1/"), "wss://api.openai.com/v1/realtime?intent=transcription");
  assert.equal(openAISocketUrl("http://api.openai.com/v1"), null);
  const update = JSON.parse(openAISessionUpdate("gpt-live-transcribe", "上下文"));
  assert.deepEqual(update, {
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          transcription: { model: "gpt-live-transcribe", languages: ["zh", "en"], prompt: "上下文" },
          turn_detection: null,
        },
      },
    },
  });
  assert.equal("prompt" in JSON.parse(openAISessionUpdate("gpt-live-transcribe", "")).session.audio.input.transcription, false);
  // Items arrive newest first; the prompt reads oldest to newest after the sentences.
  assert.equal(openAIPrompt(["当前项目 coflux。", "相关术语：store.ts。", "我：第二句", "Agent：第一句"]), "当前项目 coflux。\n相关术语：store.ts。\nAgent：第一句\n我：第二句");
});

test("correction acceptance: a corrected term passes, a long answer fails, a fence is stripped", () => {
  assert.equal(acceptedAnswer("rebase 到 main", "瑞贝斯 到 妹恩"), "rebase 到 main");
  const raw = "瑞贝斯 到 妹恩";
  assert.equal(acceptedAnswer(raw.repeat(3), raw), null);
  assert.equal(acceptedAnswer("```text\nrebase 到 main\n```", raw), "rebase 到 main");
  assert.equal(acceptedAnswer("「rebase 到 main」", raw), "rebase 到 main");
  assert.equal(acceptedAnswer("", raw), null);
});

test("correction request: endpoint, body and prompt layout with the dictation last", () => {
  assert.equal(refineEndpoint("https://api.example.com/v1//"), "https://api.example.com/v1/chat/completions");
  assert.equal(refineEndpoint("http://api.example.com/v1"), null);
  const context = {
    workspaceSentence: "当前项目 coflux，分支 main。",
    terms: ["store.ts", "rebase"],
    entries: [
      { speaker: "person" as const, text: "先看 store" },
      { speaker: "tool" as const, text: "src/store.ts", tool: "Read" },
      { speaker: "agent" as const, text: "看完了" },
    ],
  };
  const message = refineUserMessage("瑞贝斯", context);
  assert.equal(
    message,
    "<workspace>\n当前项目 coflux，分支 main。\n</workspace>\n\n<terms>\nstore.ts、rebase\n</terms>\n\n<conversation>\n我：先看 store\n工具 Read：src/store.ts\nAgent：看完了\n</conversation>\n\n<dictation>\n瑞贝斯\n</dictation>",
  );
  const body = refineRequestBody("瑞贝斯", context, "gpt-5-mini");
  assert.equal(body.model, "gpt-5-mini");
  assert.equal(body.temperature, 0);
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 128);
});

function uint32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}
