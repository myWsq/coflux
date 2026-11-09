import { useState } from "react";
import { useStore } from "zustand";
import {
  SPEECH_PROVIDER_DEFAULTS,
  SPEECH_PROVIDER_IDS,
  speechConfigInputError,
  speechRefineInputError,
  type CofluxClient,
  type SpeechProviderId,
  type SpeechProviderState,
  type SpeechRefineState,
} from "@coflux/client";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";

import { SettingsGroup, SettingsRow } from "@/components/settings/settings-group";

type Feedback = { kind: "ok" | "error"; text: string };

const PROVIDER_NOTES: Record<SpeechProviderId, { summary: string; keyPlaceholder: string }> = {
  doubao: {
    summary: "火山方舟 Agent Plan 的豆包语音识别 2.0 流式识别。",
    keyPlaceholder: "粘贴火山方舟 Agent Plan 的 API Key",
  },
  openai: {
    summary: "OpenAI Realtime 实时转写，只支持 gpt-live-transcribe 系列模型。",
    keyPlaceholder: "粘贴 OpenAI 的 API Key",
  },
};

/**
 * The 「语音识别」 settings section (plan 20261109-speech-providers): which provider the iPhone's
 * long-press dictation uses, and one configuration per provider — base URL, model and API key.
 *
 * **Keys are write-only**: the desktop never asks the center for a key and never holds one; it only
 * knows whether one is stored. Key inputs therefore always start empty, and clearing is its own
 * button. Base URL and model are prefilled with the stored values; empty means the default shown as
 * the placeholder.
 *
 * Below the engines, 「识别后整理」 (plan 20261109-dictation-refine) configures the optional chat model
 * the iPhone sends the recogniser's text to for term correction. It is not an engine: it is never
 * offered under 当前使用.
 */
export function SpeechSection({ client }: { client: CofluxClient }) {
  const online = useStore(client.store, (state) => state.status === "connected");
  const supported = useStore(client.store, (state) => state.speechConfigSupported);
  const refineSupported = useStore(client.store, (state) => state.speechRefineSupported);
  const config = useStore(client.store, (state) => state.speechConfig);
  const [pendingActive, setPendingActive] = useState<SpeechProviderId | null>(null);
  const [activeResult, setActiveResult] = useState<Feedback | null>(null);

  const disabledReason = !online
    ? "语音识别设置存在账号上，离线时改不了"
    : !supported
      ? "服务器版本过旧，不支持语音识别设置"
      : !config
        ? "正在读取账号里的设置…"
        : undefined;

  async function chooseActive(value: string) {
    const provider = SPEECH_PROVIDER_IDS.find((id) => id === value);
    if (!provider || !config || provider === config.active || pendingActive) return;
    setPendingActive(provider);
    setActiveResult(null);
    try {
      const answer = await client.setSpeechActiveProvider(provider);
      setActiveResult(
        answer.ok
          ? { kind: "ok", text: `已切换到 ${SPEECH_PROVIDER_DEFAULTS[provider].displayName}` }
          : { kind: "error", text: answer.error },
      );
    } finally {
      setPendingActive(null);
    }
  }

  const active = pendingActive ?? config?.active ?? "doubao";
  const activeState = config?.providers[active];

  return (
    <VStack gap={5} hAlign="stretch">
      <VStack gap={1.5} hAlign="stretch">
        <SettingsGroup title="当前使用">
          <SettingsRow
            label="语音输入使用"
            description={
              !config
                ? "iPhone 上长按说话时调用这里选中的服务；没有配置 API Key 时语音输入不可用。"
                : activeState?.keyConfigured
                  ? "iPhone 上长按说话时调用这里选中的服务。"
                  : `${SPEECH_PROVIDER_DEFAULTS[active].displayName} 还没有配置 API Key，iPhone 上的语音输入暂不可用。`
            }
            control={
              <SegmentedControl
                value={active}
                onChange={(value) => void chooseActive(value)}
                label="当前使用的语音识别服务"
                size="sm"
                isDisabled={!!disabledReason || pendingActive !== null}
                disabledMessage={disabledReason}
              >
                {SPEECH_PROVIDER_IDS.map((id) => (
                  <SegmentedControlItem key={id} value={id} label={SPEECH_PROVIDER_DEFAULTS[id].displayName} />
                ))}
              </SegmentedControl>
            }
          />
          <SettingsRow
            label="生效范围"
            description="设置保存在账号上，账号下所有设备共用；API Key 加密保存，桌面端只能写入或清除它，不会读回或显示它。"
          />
        </SettingsGroup>
        {activeResult ? <FeedbackLine variant={activeResult.kind === "ok" ? "success" : "error"} text={activeResult.text} /> : null}
        {disabledReason ? <FeedbackLine variant="warning" text={disabledReason} /> : null}
      </VStack>

      {SPEECH_PROVIDER_IDS.map((id) => (
        <ProviderGroup
          key={id}
          client={client}
          provider={id}
          stored={config?.providers[id]}
          disabledReason={disabledReason}
        />
      ))}

      <RefineGroup
        client={client}
        stored={config?.refine}
        disabledReason={disabledReason}
        unsupportedReason={!disabledReason && !refineSupported ? "服务器版本过旧，不支持识别后整理" : undefined}
      />
    </VStack>
  );
}

/**
 * 「识别后整理」: the switch writes at once with the stored base URL and model and keeps the key; 保存
 * sends the base URL and model as typed (keeping the switch as stored) and the key only when one was
 * typed; 清除 removes the key. The key is write-only, as for the engines.
 */
function RefineGroup({
  client,
  stored,
  disabledReason,
  unsupportedReason,
}: {
  client: CofluxClient;
  stored: SpeechRefineState | undefined;
  disabledReason: string | undefined;
  unsupportedReason: string | undefined;
}) {
  // Null = show the stored values; set on the first edit and dropped after a successful save.
  const [draft, setDraft] = useState<{ baseUrl: string; model: string } | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"switch" | "save" | "clear" | null>(null);
  const [result, setResult] = useState<Feedback | null>(null);

  const reason = disabledReason ?? unsupportedReason;
  const storedBaseUrl = stored?.baseUrl ?? "";
  const storedModel = stored?.model ?? "";
  const enabled = stored?.enabled === true;
  const baseUrl = draft?.baseUrl ?? storedBaseUrl;
  const model = draft?.model ?? storedModel;
  const keyConfigured = stored?.keyConfigured === true;
  const editingDisabled = !!reason || busy !== null;
  const changed = baseUrl.trim() !== storedBaseUrl || model.trim() !== storedModel || apiKey.trim() !== "";
  const status: { variant: "success" | "warning" | "neutral"; text: string } = !enabled
    ? { variant: "neutral", text: "未启用" }
    : keyConfigured && storedBaseUrl !== "" && storedModel !== ""
      ? { variant: "success", text: "已配置" }
      : { variant: "warning", text: "未配置" };

  function edit(field: "baseUrl" | "model", value: string) {
    setDraft({ baseUrl, model, [field]: value });
    setResult(null);
  }

  async function toggle(next: boolean) {
    if (!stored || busy) return;
    if (next && (storedBaseUrl === "" || storedModel === "")) {
      setResult({ kind: "error", text: "开启识别后整理前请先填写并保存 Base URL 和模型" });
      return;
    }
    setBusy("switch");
    setResult(null);
    try {
      const answer = await client.setSpeechRefine({ enabled: next, baseUrl: storedBaseUrl, model: storedModel, key: { kind: "keep" } });
      if (!answer.ok) setResult({ kind: "error", text: answer.error });
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    const invalid = speechRefineInputError({ enabled, baseUrl, model, apiKey });
    if (invalid) {
      setResult({ kind: "error", text: invalid });
      return;
    }
    setBusy("save");
    setResult(null);
    try {
      const key = apiKey.trim() ? ({ kind: "replace", apiKey } as const) : ({ kind: "keep" } as const);
      const answer = await client.setSpeechRefine({ enabled, baseUrl, model, key });
      if (!answer.ok) {
        setResult({ kind: "error", text: answer.error });
        return;
      }
      setDraft(null);
      setApiKey("");
      setResult({ kind: "ok", text: "已保存" });
    } finally {
      setBusy(null);
    }
  }

  async function clearKey() {
    setBusy("clear");
    setResult(null);
    try {
      const answer = await client.setSpeechRefine({ enabled, baseUrl: storedBaseUrl, model: storedModel, key: { kind: "clear" } });
      if (!answer.ok) {
        setResult({ kind: "error", text: answer.error });
        return;
      }
      setApiKey("");
      setResult({ kind: "ok", text: "已清除 API Key" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <VStack gap={1.5} hAlign="stretch">
      <Text type="label" color="secondary">识别后整理</Text>
      <Card variant="muted" width="100%">
        <VStack gap={3} hAlign="stretch">
          <HStack gap={3} vAlign="center">
            <Switch
              label="识别后整理"
              isLabelHidden
              size="sm"
              value={enabled}
              onChange={(next) => void toggle(next)}
              isLoading={busy === "switch"}
              isDisabled={editingDisabled || !stored}
              disabledMessage={reason}
            />
            {stored && !unsupportedReason ? (
              <HStack gap={2} vAlign="center">
                <StatusDot variant={status.variant} label={status.text} />
                <Text type="supporting">
                  {`${status.text}${stored.updatedAt > 0 ? ` · 最近一次保存：${new Date(stored.updatedAt).toLocaleString()}` : ""}`}
                </Text>
              </HStack>
            ) : !stored ? (
              <Text type="supporting">正在读取…</Text>
            ) : null}
          </HStack>
          <Text type="supporting" color="secondary">用大模型按对话和仓库术语纠正识别结果。建议选不带深度思考的快速模型。</Text>
          <TextInput
            label="Base URL"
            value={baseUrl}
            onChange={(value) => edit("baseUrl", value)}
            isDisabled={editingDisabled}
            disabledMessage={reason}
            placeholder="https://api.example.com/v1"
            autoComplete="off"
          />
          <TextInput
            label="模型"
            value={model}
            onChange={(value) => edit("model", value)}
            isDisabled={editingDisabled}
            disabledMessage={reason}
            placeholder="model id"
            autoComplete="off"
          />
          <TextInput
            label="API Key"
            type="password"
            value={apiKey}
            onChange={(value) => {
              setApiKey(value);
              setResult(null);
            }}
            isDisabled={editingDisabled}
            disabledMessage={reason}
            placeholder={keyConfigured ? "已保存（留空则不改）" : "粘贴该服务的 API Key"}
            autoComplete="off"
          />
          <HStack gap={2} vAlign="center">
            <Button
              label="保存"
              variant="primary"
              size="sm"
              isDisabled={editingDisabled || !changed}
              tooltip={!editingDisabled && !changed ? "没有改动" : undefined}
              isLoading={busy === "save"}
              onClick={() => void save()}
            />
            <Button
              label="清除"
              variant="ghost"
              size="sm"
              isDisabled={editingDisabled || !keyConfigured}
              tooltip={!editingDisabled && !keyConfigured ? "没有保存的 API Key" : undefined}
              isLoading={busy === "clear"}
              onClick={() => void clearKey()}
            />
          </HStack>
          {unsupportedReason ? <FeedbackLine variant="warning" text={unsupportedReason} /> : null}
          {result ? <FeedbackLine variant={result.kind === "ok" ? "success" : "error"} text={result.text} /> : null}
        </VStack>
      </Card>
    </VStack>
  );
}

/**
 * One provider's slot. The base URL and model inputs show the stored values until the user edits
 * them; 保存 sends both as typed and the key only when one was typed, 清除 removes the key and keeps the
 * stored base URL and model. Writing one provider never touches the other.
 */
function ProviderGroup({
  client,
  provider,
  stored,
  disabledReason,
}: {
  client: CofluxClient;
  provider: SpeechProviderId;
  stored: SpeechProviderState | undefined;
  disabledReason: string | undefined;
}) {
  const defaults = SPEECH_PROVIDER_DEFAULTS[provider];
  const notes = PROVIDER_NOTES[provider];
  // Null = show the stored values; set on the first edit and dropped after a successful save.
  const [draft, setDraft] = useState<{ baseUrl: string; model: string } | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"save" | "clear" | null>(null);
  const [result, setResult] = useState<Feedback | null>(null);

  const storedBaseUrl = stored?.baseUrl ?? "";
  const storedModel = stored?.model ?? "";
  const baseUrl = draft?.baseUrl ?? storedBaseUrl;
  const model = draft?.model ?? storedModel;
  const configured = stored?.keyConfigured === true;
  const editingDisabled = !!disabledReason || busy !== null;
  const changed = baseUrl.trim() !== storedBaseUrl || model.trim() !== storedModel || apiKey.trim() !== "";

  function edit(field: "baseUrl" | "model", value: string) {
    setDraft({ baseUrl, model, [field]: value });
    setResult(null);
  }

  async function save() {
    const invalid = speechConfigInputError(provider, { baseUrl, model, apiKey });
    if (invalid) {
      setResult({ kind: "error", text: invalid });
      return;
    }
    setBusy("save");
    setResult(null);
    try {
      const key = apiKey.trim() ? ({ kind: "replace", apiKey } as const) : ({ kind: "keep" } as const);
      const answer = await client.setSpeechProviderConfig(provider, { baseUrl, model, key });
      if (!answer.ok) {
        setResult({ kind: "error", text: answer.error });
        return;
      }
      setDraft(null);
      setApiKey("");
      setResult({ kind: "ok", text: "已保存" });
    } finally {
      setBusy(null);
    }
  }

  async function clearKey() {
    setBusy("clear");
    setResult(null);
    try {
      const answer = await client.setSpeechProviderConfig(provider, {
        baseUrl: storedBaseUrl,
        model: storedModel,
        key: { kind: "clear" },
      });
      if (!answer.ok) {
        setResult({ kind: "error", text: answer.error });
        return;
      }
      setApiKey("");
      setResult({ kind: "ok", text: "已清除 API Key" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <VStack gap={1.5} hAlign="stretch">
      <Text type="label" color="secondary">{defaults.displayName}</Text>
      <Card variant="muted" width="100%">
        <VStack gap={3} hAlign="stretch">
          <HStack gap={2} vAlign="center">
            {stored ? (
              <StatusDot variant={configured ? "success" : "warning"} label={configured ? "已配置" : "未配置"} />
            ) : null}
            <Text type="supporting">
              {!stored
                ? "正在读取…"
                : `${configured ? "已配置" : "未配置"}${stored.updatedAt > 0 ? ` · 最近一次保存：${new Date(stored.updatedAt).toLocaleString()}` : ""}`}
            </Text>
          </HStack>
          <Text type="supporting" color="secondary">{notes.summary}</Text>
          <TextInput
            label="Base URL"
            value={baseUrl}
            onChange={(value) => edit("baseUrl", value)}
            isDisabled={editingDisabled}
            disabledMessage={disabledReason}
            placeholder={defaults.baseUrl}
            autoComplete="off"
          />
          <TextInput
            label="模型"
            value={model}
            onChange={(value) => edit("model", value)}
            isDisabled={editingDisabled}
            disabledMessage={disabledReason}
            placeholder={defaults.model}
            autoComplete="off"
          />
          <TextInput
            label="API Key"
            type="password"
            value={apiKey}
            onChange={(value) => {
              setApiKey(value);
              setResult(null);
            }}
            isDisabled={editingDisabled}
            disabledMessage={disabledReason}
            placeholder={configured ? "已保存（留空则不改）" : notes.keyPlaceholder}
            autoComplete="off"
          />
          <HStack gap={2} vAlign="center">
            <Button
              label="保存"
              variant="primary"
              size="sm"
              isDisabled={editingDisabled || !changed}
              tooltip={!editingDisabled && !changed ? "没有改动" : undefined}
              isLoading={busy === "save"}
              onClick={() => void save()}
            />
            <Button
              label="清除"
              variant="ghost"
              size="sm"
              isDisabled={editingDisabled || !configured}
              tooltip={!editingDisabled && !configured ? "没有保存的 API Key" : undefined}
              isLoading={busy === "clear"}
              onClick={() => void clearKey()}
            />
          </HStack>
          {result ? <FeedbackLine variant={result.kind === "ok" ? "success" : "error"} text={result.text} /> : null}
        </VStack>
      </Card>
    </VStack>
  );
}

function FeedbackLine({ variant, text }: { variant: "success" | "warning" | "error"; text: string }) {
  return (
    <HStack gap={2} vAlign="center">
      <StatusDot variant={variant} label={variant === "success" ? "成功" : variant === "warning" ? "注意" : "失败"} />
      <Text type="supporting">{text}</Text>
    </HStack>
  );
}
