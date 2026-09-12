import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";

import { SettingsGroup, SettingsRow } from "@/components/settings/settings-group";
import type { DesktopBridge, DesktopExecutorSettings } from "@/desktop-bridge";

/**
 * 设置页的 Executor 分区（原先是账号菜单里的「Executor 设置…」对话框）。
 * 全局一份配置，不分工作区。
 *
 * API key 是**只写**的：主进程从不把它交给渲染层，渲染层只知道「配没配」。所以已有 key 时输入框
 * 仍然留空、占位文案写明留空不改动，清除要单独按按钮——这比画一排假圆点诚实：用户把假值当成自己的
 * key，一次误覆盖就找不回来了。
 *
 * 三个输入没有做成「一行一个控件」的设置行：那样输入框会被挤在行尾一小条里。它们是一组要一起填、
 * 一起保存的字段，按表单排更好用，状态与说明则用设置行的样子放在上面。
 */
export function ExecutorSection({ bridge }: { bridge: DesktopBridge }) {
  const [settings, setSettings] = useState<DesktopExecutorSettings | null>(null);
  const [provider, setProvider] = useState("");
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
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
  }, [bridge]);

  useEffect(() => bridge.onExecutorSettings(setSettings), [bridge]);

  // 「已保存」只是一句短反馈：设置页不像对话框那样保存后就关掉，没有反馈会让人不确定按下去没有。
  useEffect(() => {
    if (!justSaved) return;
    const timer = window.setTimeout(() => setJustSaved(false), 2400);
    return () => window.clearTimeout(timer);
  }, [justSaved]);

  function save() {
    bridge.setExecutorModel(provider, modelId);
    if (apiKey.trim()) bridge.setExecutorApiKey(apiKey); // 留空表示：别动已存的 key。
    setApiKey("");
    setJustSaved(true);
  }

  const ready = settings?.ready === true;

  return (
    <VStack gap={5} hAlign="stretch">
      <SettingsGroup title="状态">
        <SettingsRow
          label={ready ? "已就绪" : "未就绪"}
          description={ready ? "agent 现在可以发起任务" : (settings?.reason ?? "正在读取配置…")}
          control={<StatusDot variant={ready ? "success" : "warning"} label={ready ? "已就绪" : "未就绪"} />}
        />
        <SettingsRow
          label="怎么用"
          description={
            <>
              你的 agent 在终端里用 <Text type="code">coflux executor run</Text> 发起。executor 只能改发起它的那个工作区里的文件，不会提交，执行命令时也没有网络。
            </>
          }
        />
      </SettingsGroup>

      <VStack gap={1.5} hAlign="stretch">
        <Text type="label" color="secondary">模型</Text>
        <Card variant="muted" width="100%">
          <VStack gap={3} hAlign="stretch">
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

            <HStack gap={2} vAlign="center">
              <Button label="保存" variant="primary" size="sm" onClick={save} />
              {settings?.hasApiKey ? (
                <Button
                  label="清除 key"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    bridge.setExecutorApiKey("");
                    setApiKey("");
                  }}
                />
              ) : null}
              {justSaved ? <Text type="supporting">已保存</Text> : null}
            </HStack>
          </VStack>
        </Card>
      </VStack>
    </VStack>
  );
}
