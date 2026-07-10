import { useEffect, useRef, useState } from "react";
import { Check, Copy, FolderGit2, GitBranch, LoaderCircle, MonitorUp, TerminalSquare, TriangleAlert } from "lucide-react";
import type { DaemonInfo, Project } from "@coflux/protocol";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { ClientError } from "@/hooks/use-coflux-client";

type ImportProjectDialogProps = {
  open: boolean;
  daemons: DaemonInfo[];
  onOpenChange: (open: boolean) => void;
  onImport: (daemonId: string, path: string) => void;
  onAddDevice: () => void;
};

export function ImportProjectDialog({ open, daemons, onOpenChange, onImport, onAddDevice }: ImportProjectDialogProps) {
  const onlineDaemons = daemons.filter((daemon) => daemon.online);
  const [daemonId, setDaemonId] = useState("");
  const [path, setPath] = useState("");

  useEffect(() => {
    if (!open) return;
    setDaemonId((current) => (onlineDaemons.some((daemon) => daemon.daemonId === current) ? current : onlineDaemons[0]?.daemonId ?? ""));
    setPath("");
  }, [open, daemons]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const normalizedPath = path.trim();
    if (!daemonId || !normalizedPath) return;
    onImport(daemonId, normalizedPath);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <div className="mb-1 flex size-9 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
            <FolderGit2 className="size-4" />
          </div>
          <DialogTitle>导入项目</DialogTitle>
          <DialogDescription>选择仓库所在的在线设备，并填写该设备上的 git 仓库绝对路径。</DialogDescription>
        </DialogHeader>

        {onlineDaemons.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
            <MonitorUp className="mx-auto size-6 text-muted-foreground" />
            <div className="mt-3 text-sm font-medium">没有在线设备</div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">添加设备并启动 daemon 后，才能导入这台机器上的仓库。</p>
            <Button className="mt-4" variant="outline" size="sm" onClick={onAddDevice}>添加设备</Button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-5">
            <div className="space-y-2">
              <Label>设备</Label>
              <Select value={daemonId} onValueChange={setDaemonId}>
                <SelectTrigger>
                  <SelectValue placeholder="选择在线设备" />
                </SelectTrigger>
                <SelectContent>
                  {onlineDaemons.map((daemon) => (
                    <SelectItem key={daemon.daemonId} value={daemon.daemonId}>
                      {daemon.name} · {daemon.host}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="project-path">仓库路径</Label>
              <Input
                id="project-path"
                autoFocus
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="/Users/me/Workspace/project"
                autoComplete="off"
              />
              <p className="text-[11px] text-muted-foreground">路径由对应设备解析，浏览器不读取你的本地文件系统。</p>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
              <Button type="submit" disabled={!daemonId || !path.trim()}>导入项目</Button>
            </DialogFooter>
          </form>
        )}
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

export function CreateWorkspaceDialog({ project, open, onOpenChange, onCreate }: CreateWorkspaceDialogProps) {
  const [name, setName] = useState("feature");
  const [branch, setBranch] = useState("feature");
  const [branchEdited, setBranchEdited] = useState(false);
  const [mode, setMode] = useState<"new" | "existing">("new");

  useEffect(() => {
    if (!open) return;
    setName("feature");
    setBranch("feature");
    setBranchEdited(false);
    setMode("new");
  }, [open, project?.id]);

  function changeName(value: string) {
    setName(value);
    if (!branchEdited) setBranch(value);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const normalizedName = name.trim();
    const normalizedBranch = branch.trim();
    if (!project || !normalizedName || !normalizedBranch) return;
    onCreate(project.id, normalizedName, normalizedBranch, mode === "new");
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <div className="mb-1 flex size-9 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
            <GitBranch className="size-4" />
          </div>
          <DialogTitle>新建工作区</DialogTitle>
          <DialogDescription>
            在项目「{project?.name ?? ""}」下创建独立 git worktree。主工作区不会被修改。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="workspace-name">名称</Label>
              <Input id="workspace-name" autoFocus value={name} onChange={(event) => changeName(event.target.value)} placeholder="feature" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="workspace-branch">分支</Label>
              <Input
                id="workspace-branch"
                value={branch}
                onChange={(event) => {
                  setBranchEdited(true);
                  setBranch(event.target.value);
                }}
                placeholder="feature/my-change"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>分支方式</Label>
            <Select value={mode} onValueChange={(value) => setMode(value as "new" | "existing")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="new">从当前 HEAD 新建分支</SelectItem>
                <SelectItem value="existing">检出已有分支</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              {mode === "new" ? `将创建新分支 ${branch.trim() || "…"}` : `将在新 worktree 中检出 ${branch.trim() || "…"}`}
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
            <Button type="submit" disabled={!project || !name.trim() || !branch.trim()}>创建工作区</Button>
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

export function EnrollmentDialog({ open, command, lastError, onOpenChange, onRequest, onClear }: EnrollmentDialogProps) {
  const commandRef = useRef<HTMLTextAreaElement>(null);
  const requestErrorBaselineRef = useRef<number | null>(null);
  const [requested, setRequested] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "manual">("idle");
  const [requestError, setRequestError] = useState("");

  useEffect(() => {
    if (!open) return;
    setRequested(false);
    setCopyState("idle");
    setRequestError("");
    requestErrorBaselineRef.current = lastError?.id ?? null;
  }, [open]);

  useEffect(() => {
    if (!requested || !lastError || lastError.id === requestErrorBaselineRef.current) return;
    setRequested(false);
    setRequestError(lastError.message.replaceAll("任务", "终端"));
  }, [lastError, requested]);

  function changeOpen(nextOpen: boolean) {
    if (!nextOpen) onClear();
    onOpenChange(nextOpen);
  }

  function requestCommand() {
    requestErrorBaselineRef.current = lastError?.id ?? null;
    setRequestError("");
    setRequested(true);
    onRequest();
  }

  async function copyCommand() {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopyState("copied");
    } catch {
      setCopyState("manual");
      requestAnimationFrame(() => {
        commandRef.current?.focus();
        commandRef.current?.select();
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent>
        <DialogHeader>
          <div className="mb-1 flex size-9 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
            <MonitorUp className="size-4" />
          </div>
          <DialogTitle>添加设备</DialogTitle>
          <DialogDescription>生成一次登记命令，在要接入的机器上执行。设备上线后会自动出现在侧边栏。</DialogDescription>
        </DialogHeader>

        {!command ? (
          <div className="rounded-lg border border-dashed border-border px-5 py-7 text-center">
            <TerminalSquare className="mx-auto size-7 text-muted-foreground" />
            <p className="mt-3 text-xs leading-5 text-muted-foreground">命令包含登记凭证，请只在你信任的机器上使用，不要转发或公开。</p>
            {requestError && <p className="mt-3 rounded-md bg-destructive/8 px-3 py-2 text-xs text-destructive">{requestError}</p>}
            <Button className="mt-4" onClick={requestCommand} disabled={requested}>
              {requested && <LoaderCircle className="animate-spin" />}
              {requested ? "正在生成…" : "生成登记命令"}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <Label htmlFor="enrollment-command">在新机器的终端中运行</Label>
            <Textarea
              ref={commandRef}
              id="enrollment-command"
              value={command}
              readOnly
              spellCheck={false}
              className="min-h-28 resize-none font-mono text-[11px] leading-5 text-success"
              onFocus={(event) => event.currentTarget.select()}
            />
            {copyState === "manual" && <p className="text-xs text-warning">浏览器未授予剪贴板权限，命令已选中，请手动复制。</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => changeOpen(false)}>完成</Button>
              <Button onClick={copyCommand}>
                {copyState === "copied" ? <Check /> : <Copy />}
                {copyState === "copied" ? "已复制" : "复制命令"}
              </Button>
            </DialogFooter>
          </div>
        )}
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

export function ConfirmActionDialog({ action, onCancel }: { action: ConfirmAction | null; onCancel: () => void }) {
  return (
    <AlertDialog open={Boolean(action)} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="mb-1 flex size-9 items-center justify-center rounded-lg border border-destructive/25 bg-destructive/8 text-destructive">
            <TriangleAlert className="size-4" />
          </div>
          <AlertDialogTitle>{action?.title}</AlertDialogTitle>
          <AlertDialogDescription>{action?.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              action?.onConfirm();
              onCancel();
            }}
          >
            {action?.confirmLabel ?? "确认"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
