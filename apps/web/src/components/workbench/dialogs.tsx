import { Show, createEffect, createSignal, on } from "solid-js";
import { Check, Copy, FolderGit2, GitBranch, LoaderCircle, MonitorUp, TerminalSquare, TriangleAlert } from "lucide-solid";
import type { DaemonInfo, Project } from "@coflux/protocol";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SimpleSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { ClientError } from "@/client/store";

type ImportProjectDialogProps = {
  open: boolean;
  daemons: DaemonInfo[];
  onOpenChange: (open: boolean) => void;
  onImport: (daemonId: string, path: string) => void;
  onAddDevice: () => void;
};

export function ImportProjectDialog(props: ImportProjectDialogProps) {
  const onlineDaemons = () => props.daemons.filter((daemon) => daemon.online);
  const [daemonId, setDaemonId] = createSignal("");
  const [path, setPath] = createSignal("");

  createEffect(
    on(
      () => [props.open, props.daemons] as const,
      ([open]) => {
        if (!open) return;
        setDaemonId((current) => (onlineDaemons().some((daemon) => daemon.daemonId === current) ? current : onlineDaemons()[0]?.daemonId ?? ""));
        setPath("");
      },
    ),
  );

  function submit(event: SubmitEvent) {
    event.preventDefault();
    const normalizedPath = path().trim();
    if (!daemonId() || !normalizedPath) return;
    props.onImport(daemonId(), normalizedPath);
    props.onOpenChange(false);
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <div class="mb-1 flex size-9 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
            <FolderGit2 class="size-4" />
          </div>
          <DialogTitle>导入项目</DialogTitle>
          <DialogDescription>选择仓库所在的在线设备，并填写该设备上的 git 仓库绝对路径。</DialogDescription>
        </DialogHeader>

        <Show
          when={onlineDaemons().length > 0}
          fallback={
            <div class="rounded-lg border border-dashed border-border px-4 py-8 text-center">
              <MonitorUp class="mx-auto size-6 text-muted-foreground" />
              <div class="mt-3 text-sm font-medium">没有在线设备</div>
              <p class="mt-1 text-xs leading-5 text-muted-foreground">添加设备并启动 daemon 后，才能导入这台机器上的仓库。</p>
              <Button class="mt-4" variant="outline" size="sm" onClick={() => props.onAddDevice()}>
                添加设备
              </Button>
            </div>
          }
        >
          <form onSubmit={submit} class="space-y-5">
            <div class="space-y-2">
              <Label>设备</Label>
              <SimpleSelect
                aria-label="设备"
                options={onlineDaemons().map((daemon) => ({ value: daemon.daemonId, label: `${daemon.name} · ${daemon.host}` }))}
                value={daemonId()}
                onChange={setDaemonId}
                placeholder="选择在线设备"
              />
            </div>
            <div class="space-y-2">
              <Label for="project-path">仓库路径</Label>
              <Input
                id="project-path"
                autofocus
                value={path()}
                onInput={(event) => setPath(event.currentTarget.value)}
                placeholder="/Users/me/Workspace/project"
                autocomplete="off"
              />
              <p class="text-[11px] text-muted-foreground">路径由对应设备解析，浏览器不读取你的本地文件系统。</p>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
                取消
              </Button>
              <Button type="submit" disabled={!daemonId() || !path().trim()}>
                导入项目
              </Button>
            </DialogFooter>
          </form>
        </Show>
      </DialogContent>
    </Dialog>
  );
}

type CreateWorkspaceDialogProps = {
  project: Project | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (projectId: string, name: string, branch: string, createNew: boolean) => void;
};

export function CreateWorkspaceDialog(props: CreateWorkspaceDialogProps) {
  const [name, setName] = createSignal("feature");
  const [branch, setBranch] = createSignal("feature");
  const [branchEdited, setBranchEdited] = createSignal(false);
  const [mode, setMode] = createSignal<"new" | "existing">("new");

  createEffect(
    on(
      () => [props.open, props.project?.id] as const,
      ([open]) => {
        if (!open) return;
        setName("feature");
        setBranch("feature");
        setBranchEdited(false);
        setMode("new");
      },
    ),
  );

  function changeName(value: string) {
    setName(value);
    if (!branchEdited()) setBranch(value);
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    const normalizedName = name().trim();
    const normalizedBranch = branch().trim();
    if (!props.project || !normalizedName || !normalizedBranch) return;
    props.onCreate(props.project.id, normalizedName, normalizedBranch, mode() === "new");
    props.onOpenChange(false);
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <div class="mb-1 flex size-9 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
            <GitBranch class="size-4" />
          </div>
          <DialogTitle>新建工作区</DialogTitle>
          <DialogDescription>在项目「{props.project?.name ?? ""}」下创建独立 git worktree。主工作区不会被修改。</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} class="space-y-5">
          <div class="grid grid-cols-2 gap-4">
            <div class="space-y-2">
              <Label for="workspace-name">名称</Label>
              <Input id="workspace-name" autofocus value={name()} onInput={(event) => changeName(event.currentTarget.value)} placeholder="feature" />
            </div>
            <div class="space-y-2">
              <Label for="workspace-branch">分支</Label>
              <Input
                id="workspace-branch"
                value={branch()}
                onInput={(event) => {
                  setBranchEdited(true);
                  setBranch(event.currentTarget.value);
                }}
                placeholder="feature/my-change"
              />
            </div>
          </div>
          <div class="space-y-2">
            <Label>分支方式</Label>
            <SimpleSelect
              aria-label="分支方式"
              options={[
                { value: "new", label: "从当前 HEAD 新建分支" },
                { value: "existing", label: "检出已有分支" },
              ]}
              value={mode()}
              onChange={(value) => setMode(value as "new" | "existing")}
            />
            <p class="text-[11px] text-muted-foreground">
              {mode() === "new" ? `将创建新分支 ${branch().trim() || "…"}` : `将在新 worktree 中检出 ${branch().trim() || "…"}`}
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={!props.project || !name().trim() || !branch().trim()}>
              创建工作区
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
  let commandRef: HTMLTextAreaElement | undefined;
  let requestErrorBaseline: number | null = null;
  const [requested, setRequested] = createSignal(false);
  const [copyState, setCopyState] = createSignal<"idle" | "copied" | "manual">("idle");
  const [requestError, setRequestError] = createSignal("");

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        setRequested(false);
        setCopyState("idle");
        setRequestError("");
        requestErrorBaseline = props.lastError?.id ?? null;
      },
    ),
  );

  createEffect(
    on(
      () => [props.lastError, requested()] as const,
      ([lastError, isRequested]) => {
        if (!isRequested || !lastError || lastError.id === requestErrorBaseline) return;
        setRequested(false);
        setRequestError(lastError.message.replaceAll("任务", "终端"));
      },
    ),
  );

  function changeOpen(nextOpen: boolean) {
    if (!nextOpen) props.onClear();
    props.onOpenChange(nextOpen);
  }

  function requestCommand() {
    requestErrorBaseline = props.lastError?.id ?? null;
    setRequestError("");
    setRequested(true);
    props.onRequest();
  }

  async function copyCommand() {
    const command = props.command;
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopyState("copied");
    } catch {
      setCopyState("manual");
      requestAnimationFrame(() => {
        commandRef?.focus();
        commandRef?.select();
      });
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={changeOpen}>
      <DialogContent>
        <DialogHeader>
          <div class="mb-1 flex size-9 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
            <MonitorUp class="size-4" />
          </div>
          <DialogTitle>添加设备</DialogTitle>
          <DialogDescription>生成一次登记命令，在要接入的机器上执行。设备上线后会自动出现在侧边栏。</DialogDescription>
        </DialogHeader>

        <Show
          when={props.command}
          fallback={
            <div class="rounded-lg border border-dashed border-border px-5 py-7 text-center">
              <TerminalSquare class="mx-auto size-7 text-muted-foreground" />
              <p class="mt-3 text-xs leading-5 text-muted-foreground">命令包含登记凭证，请只在你信任的机器上使用，不要转发或公开。</p>
              <Show when={requestError()}>
                <p class="mt-3 rounded-md bg-destructive/8 px-3 py-2 text-xs text-destructive">{requestError()}</p>
              </Show>
              <Button class="mt-4" onClick={requestCommand} disabled={requested()}>
                <Show when={requested()}>
                  <LoaderCircle class="animate-spin" />
                </Show>
                {requested() ? "正在生成…" : "生成登记命令"}
              </Button>
            </div>
          }
        >
          {(command) => (
            <div class="space-y-3">
              <Label for="enrollment-command">在新机器的终端中运行</Label>
              <Textarea
                ref={commandRef}
                id="enrollment-command"
                value={command()}
                readOnly
                spellcheck={false}
                class="min-h-28 resize-none font-mono text-[11px] leading-5 text-success"
                onFocus={(event) => event.currentTarget.select()}
              />
              <Show when={copyState() === "manual"}>
                <p class="text-xs text-warning">浏览器未授予剪贴板权限，命令已选中，请手动复制。</p>
              </Show>
              <DialogFooter>
                <Button variant="outline" onClick={() => changeOpen(false)}>
                  完成
                </Button>
                <Button onClick={copyCommand}>
                  {copyState() === "copied" ? <Check /> : <Copy />}
                  {copyState() === "copied" ? "已复制" : "复制命令"}
                </Button>
              </DialogFooter>
            </div>
          )}
        </Show>
      </DialogContent>
    </Dialog>
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
    <AlertDialog open={Boolean(props.action)} onOpenChange={(open) => !open && props.onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div class="mb-1 flex size-9 items-center justify-center rounded-lg border border-destructive/25 bg-destructive/8 text-destructive">
            <TriangleAlert class="size-4" />
          </div>
          <AlertDialogTitle>{props.action?.title}</AlertDialogTitle>
          <AlertDialogDescription>{props.action?.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => props.onCancel()}>
            取消
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              props.action?.onConfirm();
              props.onCancel();
            }}
          >
            {props.action?.confirmLabel ?? "确认"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
