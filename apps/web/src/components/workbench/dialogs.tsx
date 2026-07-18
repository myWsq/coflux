import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { GitBranch, Search, TerminalSquare } from "lucide-react";
import type { Project, Workspace } from "@coflux/protocol";
import { Banner } from "@astryxdesign/core/Banner";
import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Dialog as AstryxDialog, DialogHeader as AstryxDialogHeader } from "@astryxdesign/core/Dialog";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, Layout, LayoutContent, LayoutFooter, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";

import type { ClientError } from "@/client/store";

export type BranchTaken = { hint: string; reason: string };

type BranchPickerDialogProps = {
  open: boolean;
  title: string;
  /** header 右侧角标（项目名/工作区名） */
  contextLabel: string;
  /** 底栏主按钮文案 */
  checkoutVerb: string;
  createVerb: string;
  /** 选中分支后的说明句 */
  describe: (branch: string, createNew: boolean) => string;
  onOpenChange: (open: boolean) => void;
  listBranches: () => Promise<{ ok: boolean; branches: string[]; error: string }>;
  /** 不可选分支 → 行内短提示 + 完整原因（git 不允许同一分支检出到两个 worktree / 当前分支） */
  takenBranches: Map<string, BranchTaken>;
  /** 返回 null = 成功（弹窗关闭）；返回字符串 = 错误信息（弹窗内展示） */
  onPick: (branch: string, createNew: boolean) => Promise<string | null>;
};

/** 与导入向导同款定高：搜索栏/底栏固定，中间列表内部滚动 */
const BRANCH_PICKER_HEIGHT = 420;

/**
 * 通用分支选择器（交互对齐导入向导）：输入即搜索，↑↓ 高亮、Enter 确认、hover 联动；
 * 模式由结果推导——高亮/精确命中已有分支 = 检出，否则 = 从 HEAD 新建。
 * 供「新建工作区」与终端区「切换分支」复用。
 */
export function BranchPickerDialog(props: BranchPickerDialogProps) {
  const [branch, setBranch] = useState("");
  /** null = 加载中；加载失败置 [] 并展示 loadError */
  const [branches, setBranches] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [pickError, setPickError] = useState("");
  const [busy, setBusy] = useState(false);
  /** -1 = 未进入键盘选择；按 ↓ 才从 0 开始高亮（同导入向导） */
  const [highlight, setHighlight] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!props.open) return;
    setBranch("");
    setBranches(null);
    setLoadError("");
    setPickError("");
    setBusy(false);
    setHighlight(-1);
    let cancelled = false;
    void props.listBranches().then((result) => {
      if (cancelled) return;
      setBranches(result.branches);
      if (!result.ok) setLoadError(result.error);
    });
    queueMicrotask(() => inputRef.current?.focus());
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  const trimmed = branch.trim();
  const query = trimmed.toLowerCase();
  const matches = (branches ?? []).filter((item) => item.toLowerCase().includes(query));
  const exactMatch = (branches ?? []).some((item) => item === trimmed);
  /** 高亮行优先于输入框文本：Enter/按钮以它为准 */
  const chosen = highlight >= 0 && matches[highlight] ? matches[highlight] : trimmed;
  const createNew = !(highlight >= 0 && matches[highlight]) && !exactMatch;
  /** 目标分支不可用：禁用提交并提示（新建分支不受影响） */
  const chosenTaken = !createNew ? props.takenBranches.get(chosen) : undefined;
  const canSubmit = Boolean(chosen && branches !== null && chosenTaken === undefined && !busy);

  useEffect(() => {
    setHighlight(-1);
  }, [branch, branches]);

  useEffect(() => {
    if (highlight < 0) return;
    listRef.current?.querySelector<HTMLElement>(`[data-branch-index="${highlight}"]`)?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  function moveHighlight(delta: number) {
    if (matches.length === 0) return;
    setHighlight((index) => {
      let next = index < 0 ? (delta > 0 ? 0 : -1) : index + delta;
      // 跳过不可选的行
      while (next >= 0 && next < matches.length && props.takenBranches.has(matches[next]!)) next += delta;
      if (next < 0) return -1;
      if (next >= matches.length) return index;
      return next;
    });
  }

  async function submitWith(target: string, targetCreateNew: boolean) {
    if (!target || busy) return;
    setBusy(true);
    setPickError("");
    const error = await props.onPick(target, targetCreateNew);
    setBusy(false);
    if (error) setPickError(error);
    else props.onOpenChange(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveHighlight(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveHighlight(-1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (canSubmit) void submitWith(chosen, createNew);
    }
  }

  return (
    <AstryxDialog
      isOpen={props.open}
      onOpenChange={props.onOpenChange}
      purpose="form"
      width={440}
      maxHeight={BRANCH_PICKER_HEIGHT}
      style={{ height: BRANCH_PICKER_HEIGHT }}
    >
      <Layout
        header={
          <AstryxDialogHeader
            title={props.title}
            endContent={
              <Text type="body" color="secondary" size="sm">
                {props.contextLabel}
              </Text>
            }
            onOpenChange={props.onOpenChange}
            hasDivider={false}
          />
        }
        content={
          <LayoutContent>
            <VStack gap={2} hAlign="stretch" style={{ height: "100%", minHeight: 0 }}>
              <div className="coflux-pathbar" onClick={() => inputRef.current?.focus()}>
                <span className="coflux-pathbar__icon" aria-hidden>
                  <Search />
                </span>
                <input
                  ref={inputRef}
                  className="coflux-pathbar__input"
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder="搜索或输入新分支名"
                  aria-label="搜索或输入新分支名"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              {matches.length > 0 ? (
                <div ref={listRef} role="listbox" aria-label="匹配的分支" className="coflux-import-list">
                  {matches.map((item, index) => {
                    const taken = props.takenBranches.get(item);
                    return (
                      <button
                        key={item}
                        type="button"
                        role="option"
                        aria-selected={index === highlight}
                        aria-disabled={taken !== undefined || undefined}
                        data-branch-index={index}
                        className={`coflux-import-row${index === highlight ? " is-active" : ""}`}
                        title={taken?.reason}
                        onMouseEnter={taken ? undefined : () => setHighlight(index)}
                        onClick={taken ? undefined : () => void submitWith(item, false)}
                      >
                        <span className="coflux-import-row__icon">
                          <GitBranch aria-hidden />
                        </span>
                        <Text type="body" className="coflux-import-row__name" maxLines={1}>
                          {item}
                        </Text>
                        {taken ? (
                          <Text type="body" size="sm" color="secondary" className="coflux-import-row__hint">
                            {taken.hint}
                          </Text>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <Text type="supporting">{branches === null ? "正在获取分支列表…" : trimmed ? "没有匹配的分支。" : "仓库还没有本地分支。"}</Text>
              )}

              {loadError ? <Banner status="warning" title={`${loadError}，将按新建分支处理`} container="card" /> : null}
              {pickError ? <Banner status="error" title={pickError} container="card" /> : null}
              {trimmed && branches !== null ? (
                <Text type="supporting">
                  {chosenTaken !== undefined ? `「${chosen}」${chosenTaken.reason}` : props.describe(chosen, createNew)}
                </Text>
              ) : null}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider={false}>
            <HStack gap={2} hAlign="between" vAlign="center">
              <Text type="supporting">↑↓ 选择，Enter 确认</Text>
              <HStack gap={2}>
                <AstryxButton label="取消" variant="secondary" isDisabled={busy} onClick={() => props.onOpenChange(false)} />
                <AstryxButton
                  label={createNew ? props.createVerb : props.checkoutVerb}
                  variant="primary"
                  isDisabled={!canSubmit}
                  isLoading={busy}
                  onClick={() => void submitWith(chosen, createNew)}
                />
              </HStack>
            </HStack>
          </LayoutFooter>
        }
      />
    </AstryxDialog>
  );
}

type CreateWorkspaceDialogProps = {
  project: Project | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (projectId: string, name: string, branch: string, createNew: boolean) => void;
  listBranches: (project: Project) => Promise<{ ok: boolean; branches: string[]; error: string }>;
  takenBranches: Map<string, BranchTaken>;
};

export function CreateWorkspaceDialog(props: CreateWorkspaceDialogProps) {
  const project = props.project;
  return (
    <BranchPickerDialog
      open={props.open && project !== null}
      title="新建工作区"
      contextLabel={project?.name ?? ""}
      checkoutVerb="检出并创建"
      createVerb="新建分支并创建"
      describe={(target, createNew) =>
        createNew ? `没有同名分支，将从当前 HEAD 新建「${target}」` : `将在新 worktree 中检出已有分支「${target}」`
      }
      onOpenChange={props.onOpenChange}
      listBranches={() => (project ? props.listBranches(project) : Promise.resolve({ ok: true, branches: [], error: "" }))}
      takenBranches={props.takenBranches}
      onPick={(target, createNew) => {
        if (project) props.onCreate(project.id, target, target, createNew);
        return Promise.resolve(null);
      }}
    />
  );
}

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
