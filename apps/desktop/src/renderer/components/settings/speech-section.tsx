import { useState } from "react";
import { useStore } from "zustand";
import type { CofluxClient } from "@coflux/client";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";

import { SettingsGroup, SettingsRow } from "@/components/settings/settings-group";

/**
 * The 「语音识别」 settings section (plan 20261108-ios-seed-asr): the account's Doubao speech-recognition
 * key, used by long-press dictation on the iPhone.
 *
 * **Write-only**: the desktop never asks the center for the key and never holds it; it only knows
 * whether one is stored. The input therefore always starts empty, and clearing is its own button.
 */
export function SpeechSection({ client }: { client: CofluxClient }) {
  const online = useStore(client.store, (state) => state.status === "connected");
  const supported = useStore(client.store, (state) => state.speechKeySupported);
  const status = useStore(client.store, (state) => state.speechKeyStatus);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"save" | "clear" | null>(null);
  const [result, setResult] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const configured = status?.configured === true;
  const disabledReason = !online
    ? "语音识别 Key 存在账号上，离线时改不了"
    : !supported
      ? "服务器版本过旧，不支持保存语音识别 Key"
      : !status
        ? "正在读取账号里的状态…"
        : undefined;
  const editingDisabled = !!disabledReason || busy !== null;

  async function write(next: string, kind: "save" | "clear") {
    setBusy(kind);
    setResult(null);
    try {
      const answer = await client.setSpeechKey(next);
      if (!answer.ok) {
        setResult({ kind: "error", text: answer.error });
        return;
      }
      setApiKey("");
      setResult({ kind: "ok", text: kind === "save" ? "已保存" : "已清除" });
    } finally {
      setBusy(null);
    }
  }

  const statusLabel = !supported && online
    ? "服务器版本过旧，不支持保存语音识别 Key"
    : !status
      ? "正在读取…"
      : configured
        ? "已配置"
        : "未配置";

  return (
    <VStack gap={5} hAlign="stretch">
      <SettingsGroup title="状态">
        <SettingsRow
          label={statusLabel}
          description={
            configured && status && status.updatedAt > 0
              ? `最近一次保存：${new Date(status.updatedAt).toLocaleString()}`
              : "iPhone 上长按说话时用这把 Key 调用豆包语音识别；没有配置时语音输入不可用。"
          }
          control={
            status ? (
              <StatusDot variant={configured ? "success" : "warning"} label={configured ? "已配置" : "未配置"} />
            ) : null
          }
        />
        <SettingsRow
          label="生效范围"
          description="Key 加密保存在账号上，账号下所有设备共用；桌面端只能写入或清除，不会读回或显示它。"
        />
      </SettingsGroup>

      <VStack gap={1.5} hAlign="stretch">
        <Text type="label" color="secondary">API Key</Text>
        <Card variant="muted" width="100%">
          <VStack gap={3} hAlign="stretch">
            <TextInput
              label="豆包语音识别 2.0 API Key"
              type="password"
              value={apiKey}
              onChange={setApiKey}
              isDisabled={editingDisabled}
              disabledMessage={disabledReason}
              placeholder={configured ? "已保存（填入新 Key 可替换）" : "粘贴火山方舟 Agent Plan 的 API Key"}
            />
            <HStack gap={2} vAlign="center">
              <Button
                label="保存"
                variant="primary"
                size="sm"
                isDisabled={editingDisabled || !apiKey.trim()}
                tooltip={!editingDisabled && !apiKey.trim() ? "先填入 API Key" : undefined}
                isLoading={busy === "save"}
                onClick={() => void write(apiKey, "save")}
              />
              <Button
                label="清除"
                variant="ghost"
                size="sm"
                isDisabled={editingDisabled || !configured}
                isLoading={busy === "clear"}
                onClick={() => void write("", "clear")}
              />
            </HStack>
            {result ? <FeedbackLine variant={result.kind === "ok" ? "success" : "error"} text={result.text} /> : null}
            {disabledReason ? <FeedbackLine variant="warning" text={disabledReason} /> : null}
          </VStack>
        </Card>
      </VStack>
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
