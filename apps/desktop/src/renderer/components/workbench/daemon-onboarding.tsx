import { useEffect, useState } from "react";
import { AlertCircle, Check, Circle, LoaderCircle } from "lucide-react";
import type { CofluxClient } from "@coflux/client";
import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { Dialog as AstryxDialog, DialogHeader as AstryxDialogHeader } from "@astryxdesign/core/Dialog";
import { HStack, Layout, LayoutContent, LayoutFooter, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";

import {
  authorizeStepDetail,
  resolveOnboardingPage,
  resolveOnboardingSteps,
  type OnboardingLocal,
  type OnboardingStepState,
} from "@/components/workbench/daemon-view";
import type { DesktopBridge, DesktopDaemonState } from "@/desktop-bridge";
import { cn } from "@/lib/utils";

type DaemonOnboardingDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: DesktopDaemonState;
  client: CofluxClient;
  authError: string | null;
  onRetryAuthorize: () => void;
  bridge: DesktopBridge;
  /** 说明页点「暂不」：记住不再自动弹（之后只从账号菜单再进） */
  onDismiss: () => void;
};

function StepIcon({ state }: { state: OnboardingStepState }) {
  if (state === "done") return <Check className="size-4 text-success" />;
  if (state === "active") return <LoaderCircle className="size-4 animate-spin text-primary" />;
  if (state === "failed") return <AlertCircle className="size-4 text-destructive" />;
  return <Circle className="size-4 text-muted-foreground/50" />;
}

function StepRow({ state, label, detail }: { state: OnboardingStepState; label: string; detail?: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 shrink-0">
        <StepIcon state={state} />
      </div>
      <div className="flex min-w-0 flex-col">
        <span className={cn("text-sm", state === "pending" ? "text-muted-foreground" : "text-foreground")}>{label}</span>
        {detail ? <span className={cn("text-xs leading-5", state === "failed" ? "text-destructive" : "text-muted-foreground")}>{detail}</span> : null}
      </div>
    </div>
  );
}

/**
 * 接入引导（plan 113）：说明页 → 进度页（安装组件 / 启动服务 / 授权中）→ FDA 页 → 完成页。
 * 页面由 daemon 状态对象 + 本地三个标记纯派生（daemon-view.ts），组件只负责发动词与渲染。
 * 授权用当前登录态在 app 内完成：状态一到 pending-auth 且带 token 就 client.authorizeDevice(token)，
 * 每个 token 只试一次，失败显示红字 + 重试；daemon 断线换新链接时 token 变了会自动再试。
 */
export function DaemonOnboardingDialog(props: DaemonOnboardingDialogProps) {
  const { open, state, bridge } = props;
  const [local, setLocal] = useState<OnboardingLocal>({ started: false, authError: null, fdaSettled: false });


  // 打开时按当下状态定起点：从账号菜单以「等待授权」进来直接是进度页；引导重新打开不沿用上次的标记
  useEffect(() => {
    if (!open) return;
    setLocal({ started: state.status !== "not-installed", authError: null, fdaSettled: false });

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const current = { ...local, authError: props.authError };
  const page = resolveOnboardingPage(state, current);
  const steps = resolveOnboardingSteps(state, current);

  function close() {
    bridge.daemonDismissError();
    props.onOpenChange(false);
  }

  function enroll() {
    setLocal((previous) => ({ ...previous, started: true, authError: null }));
    bridge.daemonDismissError();
    bridge.daemonEnroll();
  }

  function retry() {
    if (steps.retry === "authorize") {
      props.onRetryAuthorize();

      setLocal((previous) => ({ ...previous, authError: null }));
      return;
    }
    enroll();
  }

  function dismissIntro() {
    props.onDismiss();
    close();
  }

  const header = {
    intro: { title: "把这台 Mac 接入 coflux", subtitle: "登录后即可使用本机终端。关闭窗口继续在线，退出 Coflux 会结束本机终端。" },
    progress: { title: "正在接入这台 Mac", subtitle: "正在为当前账号准备本机终端，请稍候。" },
    fda: { title: "完全磁盘访问", subtitle: "终端里访问桌面 / 文稿 / 下载会被系统弹窗卡住，建议现在授予。" },
    done: { title: "这台 Mac 已上线", subtitle: "可以在本机创建终端，也可以操作同账号的其他在线设备。" },
  }[page];

  return (
    <AstryxDialog isOpen={open} onOpenChange={(next) => !next && close()} width={460}>
      <Layout
        header={<AstryxDialogHeader title={header.title} subtitle={header.subtitle} onOpenChange={(next) => !next && close()} hasDivider={false} />}
        content={
          <LayoutContent>
            {page === "intro" ? (
              <VStack gap={2} hAlign="stretch">
                <Text type="body" size="sm">
                  接入后 coflux 终端里自动带上 <Text type="code">cofluxd</Text>，agent 在里面跑 <Text type="code">coflux progress</Text> 就能出现在侧栏。
                </Text>
                <Text type="supporting">已经用 npm 装过 cofluxd 的机器不会重复接入。</Text>
              </VStack>
            ) : null}
            {page === "progress" ? (
              <VStack gap={3} hAlign="stretch">
                <StepRow state={steps.install} label="准备本机" detail={state.error?.action === "install" ? state.error.message : undefined} />
                <StepRow state={steps.start} label="启动终端" detail={state.error?.action === "start" ? state.error.message : undefined} />
                <StepRow state={steps.authorize} label="授权" detail={steps.authorize === "pending" ? undefined : authorizeStepDetail(state, current)} />
                {steps.failure ? <p className="text-sm leading-5 text-destructive">{steps.failure}</p> : null}
              </VStack>
            ) : null}
            {page === "fda" ? (
              <VStack gap={2} hAlign="stretch">
                <Text type="body" size="sm">
                  macOS 不允许程序自动弹出这个授权：点「打开系统设置」后，把 Finder 里定位到的 <Text type="code">Coflux.app</Text> 拖进「完全磁盘访问权限」列表并勾选，再回来点「我已勾选，重新启动」。
                </Text>
                <Text type="supporting">授权后可能需要退出并重新打开 Coflux；当前状态：{state.fda === "denied" ? "未授予" : state.fda === "granted" ? "已授予" : "未知"}。</Text>
              </VStack>
            ) : null}
            {page === "done" ? (
              <VStack gap={2} hAlign="stretch">
                <Text type="body" size="sm">
                  设备会出现在左侧列表里，终端中的 Agent 可以直接使用 Coflux 提供的命令。
                </Text>
              </VStack>
            ) : null}
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider={false}>
            <HStack gap={2} hAlign="end">
              {page === "intro" ? (
                <>
                  <AstryxButton label="暂不" variant="secondary" onClick={dismissIntro} />
                  <AstryxButton label="接入" variant="primary" onClick={enroll} isDisabled={!state.bundled} />
                </>
              ) : null}
              {page === "progress" ? (
                <>
                  <AstryxButton label="暂不" variant="secondary" onClick={close} />
                  {steps.retry ? <AstryxButton label="重试" variant="primary" onClick={retry} /> : null}
                </>
              ) : null}
              {page === "fda" ? (
                <>
                  <AstryxButton label="跳过" variant="secondary" onClick={() => setLocal((previous) => ({ ...previous, fdaSettled: true }))} />
                  <AstryxButton label="打开系统设置" variant="secondary" onClick={() => bridge.daemonOpenFdaGuide()} />
                  <AstryxButton
                    label="我已勾选，重新启动"
                    variant="primary"
                    isDisabled={Boolean(state.busy)}
                    onClick={() => {
                      bridge.daemonRestart();
                      setLocal((previous) => ({ ...previous, fdaSettled: true }));
                    }}
                  />
                </>
              ) : null}
              {page === "done" ? <AstryxButton label="开始使用" variant="primary" onClick={close} /> : null}
            </HStack>
          </LayoutFooter>
        }
      />
    </AstryxDialog>
  );
}
