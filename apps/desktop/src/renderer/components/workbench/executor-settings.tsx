import { useEffect, useState } from "react";
import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { Dialog as AstryxDialog, DialogHeader as AstryxDialogHeader } from "@astryxdesign/core/Dialog";
import { HStack, Layout, LayoutContent, LayoutFooter, VStack } from "@astryxdesign/core/Layout";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";

import type { DesktopBridge, DesktopExecutorSettings } from "@/desktop-bridge";

type ExecutorSettingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bridge: DesktopBridge;
};

/**
 * The account menu's "Executor settings…" dialog. One global configuration, not per workspace.
 *
 * The API key is **write-only**: the main process never hands it to the renderer, which only knows
 * whether one is set. So the field stays empty when a key exists, its placeholder says that leaving
 * it empty changes nothing, and clearing takes an explicit button. That is more honest than a row of
 * fake dots — a user seeing a fake value takes it for their key, and an accidental overwrite is
 * unrecoverable.
 */
export function ExecutorSettingsDialog({ open, onOpenChange, bridge }: ExecutorSettingsDialogProps) {
  const [settings, setSettings] = useState<DesktopExecutorSettings | null>(null);
  const [provider, setProvider] = useState("");
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void bridge.getExecutorSettings().then((next) => {
      if (!alive) return;
      setSettings(next);
      setProvider(next.provider);
      setModelId(next.modelId);
      setApiKey("");
    });
    return () => {
      alive = false;
    };
  }, [open, bridge]);

  useEffect(() => bridge.onExecutorSettings(setSettings), [bridge]);

  function save() {
    bridge.setExecutorModel(provider, modelId);
    if (apiKey.trim()) bridge.setExecutorApiKey(apiKey); // Empty means: leave the stored key alone.
    setApiKey("");
    onOpenChange(false);
  }

  const ready = settings?.ready === true;

  return (
    <AstryxDialog isOpen={open} onOpenChange={onOpenChange} width={460}>
      <Layout
        header={<AstryxDialogHeader title="Executor 设置" onOpenChange={onOpenChange} hasDivider={false} />}
        content={
          <LayoutContent>
            <VStack gap={3} hAlign="stretch">
              <Text type="supporting">
                coflux 内置的 executor 用这里配的模型执行任务。你的 agent 在终端里用 <Text type="code">coflux executor run</Text>{" "}
                发起；executor 只能改发起它的那个工作区里的文件，不会提交，执行命令时也没有网络。
              </Text>

              <HStack gap={2} vAlign="center">
                <StatusDot variant={ready ? "success" : "warning"} label={ready ? "已就绪" : "未就绪"} />
                <Text type="body">{ready ? "已就绪，agent 现在可以发起任务" : (settings?.reason ?? "正在读取配置…")}</Text>
              </HStack>

              <VStack gap={1} hAlign="stretch">
                <TextInput label="Provider" value={provider} onChange={setProvider} placeholder="anthropic / openai / google / openrouter …" />
                <TextInput label="模型" value={modelId} onChange={setModelId} placeholder="模型 id，例如 claude-sonnet-5" />
                <TextInput
                  label="API key"
                  type="password"
                  value={apiKey}
                  onChange={setApiKey}
                  placeholder={settings?.hasApiKey ? "已保存（留空则不改动）" : "粘贴 API key"}
                />
                <Text type="supporting">key 经系统钥匙串加密后只存在本机，不上传服务器，也不会传给 executor 执行的命令。</Text>
              </VStack>
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider={false}>
            <HStack gap={2} hAlign="end">
              {settings?.hasApiKey ? (
                <AstryxButton
                  label="清除 key"
                  variant="ghost"
                  onClick={() => {
                    bridge.setExecutorApiKey("");
                    setApiKey("");
                  }}
                />
              ) : null}
              <AstryxButton label="取消" variant="ghost" onClick={() => onOpenChange(false)} />
              <AstryxButton label="保存" variant="primary" onClick={save} />
            </HStack>
          </LayoutFooter>
        }
      />
    </AstryxDialog>
  );
}
