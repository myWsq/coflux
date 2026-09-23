import { useEffect, useRef, useState, type FormEvent } from "react";
import { CircleCheck, Download } from "lucide-react";
import { useStore } from "zustand";
import type { CofluxClient } from "@coflux/client";
import type { DaemonInfo } from "@coflux/protocol";
import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Dialog as AstryxDialog, DialogHeader as AstryxDialogHeader } from "@astryxdesign/core/Dialog";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, Layout, LayoutContent, StackItem, VStack } from "@astryxdesign/core/Layout";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";

import { DialogFooterActions } from "@/components/dialog-footer";
import {
  advanceBaselineTracker,
  desktopDownloadUrl,
  headlessAgentPrompt,
  manualInstallCommand,
  newDevices,
  parseAuthorizeInput,
  showThisMacRow,
  startBaselineTracker,
  type AuthorizeToken,
  type BaselineTracker,
} from "@/components/workbench/add-device-view";
import { desktop, SERVER_URL } from "@/config";
import type { DesktopDaemonState } from "@/desktop-bridge";

import { daemonServerUrl } from "../../../shared/daemon-urls";

type AddDeviceTab = "desktop" | "headless";

type AddDeviceDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client: CofluxClient;
  /** Local daemon state; drives the 「这台 Mac 尚未接入」 row. null until the first state arrives. */
  daemonState: DesktopDaemonState | null;
  /** Close this dialog and open the existing this-Mac onboarding (plan 113). */
  onOnboardThisMac: () => void;
};

const DAEMON_URL = daemonServerUrl(SERVER_URL);
const AGENT_PROMPT = headlessAgentPrompt(DAEMON_URL);
const MANUAL_COMMAND = manualInstallCommand(DAEMON_URL);

/**
 * 添加设备 (plan 20260923-add-device-dialog): Desktop (install Coflux.app on another Apple-silicon
 * Mac) and Headless (cofluxd, set up by an agent or by hand, authorized by pasting its link here with
 * this app's own session). Whichever route is used, any device id that was not in the account when
 * the dialog started watching flips the dialog to success in place. Closing has no side effects; an
 * authorization still in flight may complete, but its result is dropped and reopening starts clean.
 */
export function AddDeviceDialog(props: AddDeviceDialogProps) {
  const { open, client } = props;
  const status = useStore(client.store, (state) => state.status);
  const daemons = useStore(client.store, (state) => state.daemons);

  const [tab, setTab] = useState<AddDeviceTab>("desktop");
  const [tracker, setTracker] = useState<BaselineTracker<DaemonInfo>>(() => ({ baseline: null, daemonsAtConnect: null }));
  const [success, setSuccess] = useState<{ daemonId: string; name: string } | null>(null);
  const [link, setLink] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [wasOpen, setWasOpen] = useState(false);
  // Bumped on every open / close: a result that belongs to an earlier opening is dropped.
  const generationRef = useRef(0);

  // Every opening starts clean on the Desktop tab with a fresh baseline. Reset during render (not in
  // an effect) so the first committed frame never shows the previous opening's success view or
  // diffs against its baseline.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setTab("desktop");
      setTracker(startBaselineTracker(status, daemons));
      setSuccess(null);
      setLink("");
      setLinkError(null);
      setPending(false);
      setAuthorized(false);
    }
  }

  useEffect(() => {
    generationRef.current += 1;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setTracker((previous) => advanceBaselineTracker(previous, status, daemons));
  }, [open, status, daemons]);

  const found = open && !success ? newDevices(tracker.baseline, daemons)[0] : undefined;
  useEffect(() => {
    if (found) setSuccess({ daemonId: found.daemonId, name: found.name });
  }, [found]);

  // Only a validated token can be sent: every miss counts against this connection's failure budget,
  // which this Mac's own automatic local authorization shares.
  async function sendAuthorization(token: AuthorizeToken) {
    const generation = generationRef.current;
    setPending(true);
    setLinkError(null);
    let error: string | null = null;
    try {
      const result = await client.authorizeDevice(token);
      if (!result.ok) error = result.error;
    } catch (reason) {
      error = String(reason);
    }
    if (generation !== generationRef.current) return;
    setPending(false);
    if (error === null) setAuthorized(true);
    else setLinkError(error);
  }

  function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (pending) return;
    const parsed = parseAuthorizeInput(link);
    if (!parsed.ok) {
      setLinkError(parsed.error);
      return;
    }
    void sendAuthorization(parsed.token);
  }

  function close() {
    props.onOpenChange(false);
  }

  // Name follows a rename while the success view is showing; the captured name covers a vanished entry.
  const successName = success ? daemons.find((daemon) => daemon.daemonId === success.daemonId)?.name || success.name : "";

  if (success) {
    return (
      <AstryxDialog isOpen={open} onOpenChange={props.onOpenChange} purpose="form" width={520}>
        <Layout
          header={<AstryxDialogHeader title="添加设备" onOpenChange={props.onOpenChange} hasDivider={false} />}
          content={
            <LayoutContent>
              <VStack gap={2} hAlign="center">
                <CircleCheck className="size-10 text-success" aria-hidden />
                <Heading level={3}>{`${successName} 已上线`}</Heading>
                <Text type="supporting" justify="center">
                  它已出现在左侧设备列表里。
                </Text>
              </VStack>
            </LayoutContent>
          }
          footer={<DialogFooterActions action={{ label: "完成", onClick: close, hasAutofocus: true }} />}
        />
      </AstryxDialog>
    );
  }

  return (
    <AstryxDialog isOpen={open} onOpenChange={props.onOpenChange} purpose="form" width={520}>
      <Layout
        header={<AstryxDialogHeader title="添加设备" subtitle="把另一台机器接入当前账号。" onOpenChange={props.onOpenChange} hasDivider={false} />}
        content={
          <LayoutContent>
            <VStack gap={4} hAlign="stretch">
              <SegmentedControl value={tab} onChange={(value) => setTab(value === "headless" ? "headless" : "desktop")} label="接入方式" layout="fill" size="sm">
                <SegmentedControlItem value="desktop" label="Desktop" />
                <SegmentedControlItem value="headless" label="Headless" />
              </SegmentedControl>

              {tab === "desktop" ? (
                <VStack gap={3} hAlign="stretch">
                  <Text type="body" size="sm">
                    在另一台 Mac 上安装 Coflux，用同一个账号登录，它会自动接入，这里随即显示已上线。
                  </Text>
                  <HStack gap={2} vAlign="center">
                    <AstryxButton
                      label="下载 Coflux"
                      variant="primary"
                      size="sm"
                      icon={<Download className="size-4" aria-hidden />}
                      onClick={() => window.open(desktopDownloadUrl(desktop.version), "_blank", "noopener")}
                    />
                  </HStack>
                  <Text type="supporting">需要 Apple 芯片、macOS 26 或更高版本；Intel Mac 请用 Headless。</Text>
                  {showThisMacRow(props.daemonState) ? (
                    <HStack gap={2} vAlign="center" hAlign="between">
                      <Text type="body" size="sm">
                        这台 Mac 尚未接入
                      </Text>
                      <AstryxButton label="接入" variant="secondary" size="sm" onClick={props.onOnboardThisMac} />
                    </HStack>
                  ) : null}
                </VStack>
              ) : (
                <VStack gap={4} hAlign="stretch">
                  <VStack gap={2} hAlign="stretch">
                    <Text type="body" size="sm" weight="semibold">
                      让 agent 帮你装
                    </Text>
                    <Text type="supporting">
                      适用于 Linux、Intel Mac 和服务器。把下面这段话发给目标机器上的 agent（Claude Code、Codex 等），它会安装 cofluxd 并把授权链接交给你。
                    </Text>
                    {/* CodeBlock has a copy button by default; the text stays selectable if clipboard access is denied. */}
                    <CodeBlock code={AGENT_PROMPT} language="plaintext" size="sm" isWrapped maxHeight={220} />
                  </VStack>

                  <Collapsible trigger="自己动手" defaultIsOpen={false}>
                    <VStack gap={2} hAlign="stretch" padding={2}>
                      <Text type="supporting">在目标机器的终端运行（需要 Node.js 20+）：</Text>
                      <CodeBlock code={MANUAL_COMMAND} language="plaintext" size="sm" isWrapped />
                      <Text type="supporting">命令会打印一个授权链接，粘贴到下方即可；在已登录的浏览器里打开它也行。</Text>
                    </VStack>
                  </Collapsible>

                  <form onSubmit={submit}>
                    <VStack gap={2} hAlign="stretch">
                      <HStack gap={2} vAlign="end">
                        <StackItem size="fill">
                          <TextInput
                            label="授权链接"
                            value={link}
                            onChange={(value) => {
                              setLink(value);
                              setLinkError(null);
                            }}
                            placeholder="粘贴 https://…/authorize/… 链接或 cf_authz_… token"
                            width="100%"
                            autoComplete="off"
                          />
                        </StackItem>
                        <AstryxButton label="授权" type="submit" variant="primary" isDisabled={pending || !link.trim()} isLoading={pending} />
                      </HStack>
                      {linkError ? <p className="text-sm leading-5 text-destructive">{linkError}</p> : null}
                      {authorized && !linkError ? <Text type="supporting">已授权，等待设备上线…</Text> : null}
                    </VStack>
                  </form>
                </VStack>
              )}
            </VStack>
          </LayoutContent>
        }
      />
    </AstryxDialog>
  );
}
