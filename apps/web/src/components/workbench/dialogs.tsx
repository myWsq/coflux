import { useEffect, useState, type FormEvent } from "react";
import { TerminalSquare } from "lucide-react";
import type { DaemonInfo, Workspace } from "@coflux/protocol";
import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Dialog as AstryxDialog, DialogHeader as AstryxDialogHeader } from "@astryxdesign/core/Dialog";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, Layout, LayoutContent, LayoutFooter, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";

import { shortcutModifiers, useIsStandalone } from "@/components/workbench/use-shortcut-modifier";

type WorkspaceRenameDialogProps = {
  workspace: Workspace | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (workspaceId: string, name: string) => void;
};

/** 重命名工作区（name 是自由文本；清空提交 = 回落分支名） */
export function WorkspaceRenameDialog(props: WorkspaceRenameDialogProps) {
  const [name, setName] = useState("");

  useEffect(() => {
    if (!props.open) return;
    const workspace = props.workspace;
    setName(workspace && workspace.name !== workspace.branch ? workspace.name : "");
  }, [props.open, props.workspace]);

  function save() {
    if (!props.workspace) return;
    props.onSave(props.workspace.id, name.trim());
    props.onOpenChange(false);
  }

  return (
    <AstryxDialog isOpen={props.open} onOpenChange={props.onOpenChange} purpose="form" width={400}>
      <Layout
        header={
          <AstryxDialogHeader
            title="重命名"
            subtitle={`给「${props.workspace?.branch ?? ""}」记一句这个工作区要干什么。`}
            onOpenChange={props.onOpenChange}
            hasDivider={false}
          />
        }
        content={
          <LayoutContent>
            <form
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                save();
              }}
            >
              <TextInput label="名称" isLabelHidden value={name} onChange={setName} placeholder="比如：重构登录页" hasAutoFocus />
              <button type="submit" hidden />
            </form>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider={false}>
            <HStack gap={2} hAlign="end">
              <AstryxButton label="取消" variant="secondary" onClick={() => props.onOpenChange(false)} />
              <AstryxButton label="保存" variant="primary" onClick={save} />
            </HStack>
          </LayoutFooter>
        }
      />
    </AstryxDialog>
  );
}

type DeviceRenameDialogProps = {
  daemon: DaemonInfo | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (daemonId: string, name: string) => void;
};

/** 重命名设备（别名；空则拒绝） */
export function DeviceRenameDialog(props: DeviceRenameDialogProps) {
  const [name, setName] = useState("");

  useEffect(() => {
    if (!props.open) return;
    const daemon = props.daemon;
    setName(daemon?.name ?? "");
  }, [props.open, props.daemon]);

  function save() {
    if (!props.daemon) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    props.onSave(props.daemon.daemonId, trimmed);
    props.onOpenChange(false);
  }

  const trimmed = name.trim();
  const isSaveDisabled = !trimmed;

  return (
    <AstryxDialog isOpen={props.open} onOpenChange={props.onOpenChange} purpose="form" width={400}>
      <Layout
        header={
          <AstryxDialogHeader
            title="重命名设备"
            subtitle={`给「${props.daemon?.name ?? ""}」起一个易识别的别名。`}
            onOpenChange={props.onOpenChange}
            hasDivider={false}
          />
        }
        content={
          <LayoutContent>
            <form
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                if (!isSaveDisabled) save();
              }}
            >
              <TextInput label="名称" isLabelHidden value={name} onChange={setName} placeholder="比如：家里的 MacBook Pro" hasAutoFocus />
              <button type="submit" hidden />
            </form>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider={false}>
            <HStack gap={2} hAlign="end">
              <AstryxButton label="取消" variant="secondary" onClick={() => props.onOpenChange(false)} />
              <AstryxButton label="保存" variant="primary" onClick={save} isDisabled={isSaveDisabled} />
            </HStack>
          </LayoutFooter>
        }
      />
    </AstryxDialog>
  );
}

type EnrollmentDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** 添加设备：静态安装引导（无凭证生成——登记走浏览器授权，daemon 自己打印链接）。 */
export function EnrollmentDialog(props: EnrollmentDialogProps) {
  return (
    <AstryxDialog isOpen={props.open} onOpenChange={props.onOpenChange} purpose="form" width={480}>
      <Layout
        header={
          <AstryxDialogHeader
            title="添加设备"
            subtitle="在要接入的机器上安装并启动 daemon，然后在浏览器里完成一次授权。"
            onOpenChange={props.onOpenChange}
            hasDivider={false}
          />
        }
        content={
          <LayoutContent>
            <VStack gap={3} hAlign="stretch">
              <Text type="body" size="sm">
                在新机器的终端中运行：
              </Text>
              {/* CodeBlock 自带复制按钮；文本可选中，剪贴板权限被拒时可手动复制 */}
              <CodeBlock code={"npm i -g cofluxd && cofluxd up"} language="plaintext" size="sm" isWrapped />
              <VStack gap={2} hAlign="center">
                <Icon icon={TerminalSquare} size="md" />
                <Text type="supporting" justify="center">
                  daemon 启动后会打印一个授权链接，在任意设备的浏览器里打开它并确认，设备即上线。
                </Text>
              </VStack>
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider={false}>
            <HStack gap={2} hAlign="end">
              <AstryxButton label="完成" variant="primary" onClick={() => props.onOpenChange(false)} />
            </HStack>
          </LayoutFooter>
        }
      />
    </AstryxDialog>
  );
}

export type ConfirmAction = {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
};

/** 键位展示：物理键位组合，纯展示不做输入解析（解析逻辑见 use-global-shortcuts.ts）。
 * 修饰键顺序遵循 macOS 菜单惯例：⌃⌥⇧⌘。前缀随 PWA standalone 环境变（⌃⌘ ↔ ⌘）。 */
function shortcutRows(standalone: boolean): { keys: string[]; description: string }[] {
  const mod = shortcutModifiers(standalone);
  return [
    { keys: [...mod, "T"], description: "新建终端" },
    { keys: [...mod, "W"], description: "关闭当前终端" },
    { keys: [...mod, "1-9"], description: "切换到第 N 个终端" },
    { keys: [...mod, "["], description: "上一个终端" },
    { keys: [...mod, "]"], description: "下一个终端" },
    { keys: [...mod, "N"], description: "新建工作区" },
    { keys: ["⌘", "/"], description: "显示 / 隐藏本面板" },
  ];
}

function KeyCap({ label }: { label: string }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1 font-mono text-xs text-foreground">
      {label}
    </kbd>
  );
}

/** 快捷键帮助面板：Cmd+/ 打开，再按一次或 Esc 关闭；键位表硬编码（6 条快捷键不值得配置化）。 */
export function ShortcutsHelpDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const rows = shortcutRows(useIsStandalone());
  return (
    <AstryxDialog isOpen={props.open} onOpenChange={props.onOpenChange} width={380}>
      <Layout
        header={<AstryxDialogHeader title="快捷键" onOpenChange={props.onOpenChange} hasDivider={false} />}
        content={
          <LayoutContent>
            <VStack gap={2} hAlign="stretch">
              {rows.map((row) => (
                <HStack key={row.description} gap={3} hAlign="between" vAlign="center">
                  <Text type="body">{row.description}</Text>
                  <HStack gap={1} vAlign="center">
                    {row.keys.map((key, index) => (
                      <KeyCap key={index} label={key} />
                    ))}
                  </HStack>
                </HStack>
              ))}
            </VStack>
          </LayoutContent>
        }
      />
    </AstryxDialog>
  );
}

export function ConfirmActionDialog(props: { action: ConfirmAction | null; onCancel: () => void }) {
  return (
    <AstryxDialog isOpen={Boolean(props.action)} onOpenChange={(open) => !open && props.onCancel()} width={400}>
      <Layout
        header={<AstryxDialogHeader title={props.action?.title ?? ""} onOpenChange={(open) => !open && props.onCancel()} hasDivider={false} />}
        content={
          <LayoutContent>
            <Text type="body">{props.action?.description}</Text>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider={false}>
            <HStack gap={2} hAlign="end">
              <AstryxButton label="取消" variant="secondary" onClick={() => props.onCancel()} />
              <AstryxButton
                label={props.action?.confirmLabel ?? "确认"}
                variant="destructive"
                onClick={() => {
                  props.action?.onConfirm();
                  props.onCancel();
                }}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </AstryxDialog>
  );
}
