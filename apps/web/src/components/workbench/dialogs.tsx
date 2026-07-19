import { useEffect, useRef, useState, type FormEvent } from "react";
import { TerminalSquare } from "lucide-react";
import type { Workspace } from "@coflux/protocol";
import { Banner } from "@astryxdesign/core/Banner";
import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Dialog as AstryxDialog, DialogHeader as AstryxDialogHeader } from "@astryxdesign/core/Dialog";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, Layout, LayoutContent, LayoutFooter, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";

import type { ClientError } from "@/client/store";

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

type EnrollmentDialogProps = {
  open: boolean;
  command: string | null;
  lastError: ClientError | null;
  onOpenChange: (open: boolean) => void;
  onRequest: () => void;
  onClear: () => void;
};

export function EnrollmentDialog(props: EnrollmentDialogProps) {
  const requestErrorBaseline = useRef<number | null>(null);
  const [requested, setRequested] = useState(false);
  const [requestError, setRequestError] = useState("");

  useEffect(() => {
    if (!props.open) return;
    setRequested(false);
    setRequestError("");
    requestErrorBaseline.current = props.lastError?.id ?? null;
    // 打开时只消费一次当时的 lastError 作为基线，之后的变化交给下面的效果处理。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  useEffect(() => {
    if (!requested || !props.lastError || props.lastError.id === requestErrorBaseline.current) return;
    setRequested(false);
    setRequestError(props.lastError.message.replaceAll("任务", "终端"));
  }, [props.lastError, requested]);

  function changeOpen(nextOpen: boolean) {
    if (!nextOpen) props.onClear();
    props.onOpenChange(nextOpen);
  }

  function requestCommand() {
    requestErrorBaseline.current = props.lastError?.id ?? null;
    setRequestError("");
    setRequested(true);
    props.onRequest();
  }

  return (
    <AstryxDialog isOpen={props.open} onOpenChange={changeOpen} purpose="form" width={480}>
      <Layout
        header={
          <AstryxDialogHeader
            title="添加设备"
            subtitle="生成一次登记命令，在要接入的机器上执行。设备上线后会自动出现在侧边栏。"
            onOpenChange={changeOpen}
            hasDivider={false}
          />
        }
        content={
          <LayoutContent>
            {props.command ? (
              <VStack gap={3} hAlign="stretch">
                <Text type="body" size="sm">
                  在新机器的终端中运行：
                </Text>
                {/* CodeBlock 自带复制按钮；文本可选中，剪贴板权限被拒时可手动复制 */}
                <CodeBlock code={props.command} language="plaintext" size="sm" isWrapped />
              </VStack>
            ) : (
              <VStack gap={3} hAlign="center">
                <Icon icon={TerminalSquare} size="md" />
                <Text type="supporting" justify="center">
                  命令包含登记凭证，请只在你信任的机器上使用，不要转发或公开。
                </Text>
                {requestError ? <Banner status="error" title={requestError} container="card" /> : null}
                <AstryxButton
                  label={requested ? "正在生成…" : "生成登记命令"}
                  variant="primary"
                  isLoading={requested}
                  onClick={requestCommand}
                />
              </VStack>
            )}
          </LayoutContent>
        }
        footer={
          props.command ? (
            <LayoutFooter hasDivider={false}>
              <HStack gap={2} hAlign="end">
                <AstryxButton label="完成" variant="primary" onClick={() => changeOpen(false)} />
              </HStack>
            </LayoutFooter>
          ) : undefined
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
 * 修饰键顺序遵循 macOS 菜单惯例：⌃⌥⇧⌘。 */
const SHORTCUT_ROWS: { keys: string[]; description: string }[] = [
  { keys: ["⌃", "⌘", "T"], description: "新建终端" },
  { keys: ["⌃", "⌘", "W"], description: "关闭当前终端" },
  { keys: ["⌃", "⌘", "1-9"], description: "切换到第 N 个终端" },
  { keys: ["⌃", "⌘", "["], description: "上一个终端" },
  { keys: ["⌃", "⌘", "]"], description: "下一个终端" },
  { keys: ["⌃", "⌘", "N"], description: "新建工作区" },
  { keys: ["⌘", "/"], description: "显示 / 隐藏本面板" },
];

function KeyCap({ label }: { label: string }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1 font-mono text-xs text-foreground">
      {label}
    </kbd>
  );
}

/** 快捷键帮助面板：Cmd+/ 打开，再按一次或 Esc 关闭；键位表硬编码（6 条快捷键不值得配置化）。 */
export function ShortcutsHelpDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <AstryxDialog isOpen={props.open} onOpenChange={props.onOpenChange} width={380}>
      <Layout
        header={<AstryxDialogHeader title="快捷键" onOpenChange={props.onOpenChange} hasDivider={false} />}
        content={
          <LayoutContent>
            <VStack gap={2} hAlign="stretch">
              {SHORTCUT_ROWS.map((row) => (
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
