import { useEffect, useRef, useState } from "react";
import { CircleCheck, Download } from "lucide-react";
import { useStore } from "zustand";
import type { CofluxClient, DeviceJoinKeyResult } from "@coflux/client";
import type { DaemonInfo } from "@coflux/protocol";
import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Dialog as AstryxDialog, DialogHeader as AstryxDialogHeader } from "@astryxdesign/core/Dialog";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, Layout, LayoutContent, VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";

import { DialogFooterActions } from "@/components/dialog-footer";
import {
  advanceBaselineTracker,
  desktopDownloadUrl,
  headlessAgentPrompt,
  joinKeyMinutesLeft,
  manualInstallCommand,
  newDevices,
  showThisMacRow,
  startBaselineTracker,
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

/**
 * The Headless tab's one-time join key for this opening of the dialog. `previous` is the key a mint
 * replaces: kept on failure so 重试 still revokes it (a failed mint revoked nothing).
 */
type JoinKeyState =
  | { status: "idle" }
  | { status: "minting" }
  | { status: "ready"; key: string; expiresAt: number }
  | { status: "error"; error: string; previous: string };

/**
 * 添加设备 (plan 20260923-add-device-dialog): Desktop (install Coflux.app on another Apple-silicon
 * Mac) and Headless (cofluxd, set up by an agent or by hand). The Headless tab mints a one-time join
 * key the first time it is shown in an opening (plan 20260924-device-join-keys) and embeds it in both
 * the agent prompt and the command, so running the command is the whole job. Whichever route is used,
 * any device id that was not in the account when the dialog started watching flips the dialog to
 * success in place. Closing does not revoke the key (an agent may still be installing); a mint still
 * in flight may complete, but its result is dropped and reopening mints a fresh key.
 */
export function AddDeviceDialog(props: AddDeviceDialogProps) {
  const { open, client } = props;
  const status = useStore(client.store, (state) => state.status);
  const daemons = useStore(client.store, (state) => state.daemons);
  const snapshotRevision = useStore(client.store, (state) => state.snapshotRevision);

  const [tab, setTab] = useState<AddDeviceTab>("desktop");
  const [tracker, setTracker] = useState<BaselineTracker<DaemonInfo>>(() => ({ baseline: null, daemonsAtConnect: null }));
  const [success, setSuccess] = useState<{ daemonId: string; name: string } | null>(null);
  const [joinKey, setJoinKey] = useState<JoinKeyState>({ status: "idle" });
  const [now, setNow] = useState(() => Date.now());
  const [wasOpen, setWasOpen] = useState(false);
  // Bumped on every open / close: a result that belongs to an earlier opening is dropped.
  const generationRef = useRef(0);
  // Bumped on every mint: only the latest mint's answer is shown (换一个 pressed twice).
  const mintRef = useRef(0);

  // Every opening starts clean on the Desktop tab with a fresh baseline. Reset during render (not in
  // an effect) so the first committed frame never shows the previous opening's success view or
  // diffs against its baseline.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setTab("desktop");
      setTracker(startBaselineTracker(status, daemons, snapshotRevision > 0));
      setSuccess(null);
      setJoinKey({ status: "idle" });
    }
  }

  useEffect(() => {
    generationRef.current += 1;
  }, [open]);

  async function mintJoinKey(replaces: string) {
    const generation = generationRef.current;
    const mint = ++mintRef.current;
    setJoinKey({ status: "minting" });
    let result: DeviceJoinKeyResult;
    try {
      result = await client.createDeviceJoinKey(replaces);
    } catch (reason) {
      result = { ok: false, error: String(reason) };
    }
    if (generation !== generationRef.current || mint !== mintRef.current) return;
    setNow(Date.now());
    setJoinKey(result.ok ? { status: "ready", key: result.key, expiresAt: result.expiresAt } : { status: "error", error: result.error, previous: replaces });
  }

  // First show of the Headless tab in this opening mints its key; tab switches keep it. Declared after
  // the generation bump so the mint belongs to the current opening.
  useEffect(() => {
    if (open && tab === "headless" && joinKey.status === "idle") void mintJoinKey("");
    // mintJoinKey is recreated every render; the state it reads is captured at call time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab, joinKey.status]);

  // Countdown: re-render once a second while a key is showing.
  const counting = open && joinKey.status === "ready";
  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [counting]);

  useEffect(() => {
    if (!open) return;
    setTracker((previous) => advanceBaselineTracker(previous, status, daemons));
  }, [open, status, daemons]);

  // Freeze the first new device during render, so the frame that brings it also shows the success view.
  // Skipped on the reset render itself: `tracker` / `success` there still hold the previous opening's
  // values, whose baseline would flag devices that joined while the dialog was closed.
  const found = open && open === wasOpen && !success ? newDevices(tracker.baseline, daemons)[0] : undefined;
  if (found) setSuccess({ daemonId: found.daemonId, name: found.name });

  function close() {
    props.onOpenChange(false);
  }

  // 换一个 revokes the key it replaces immediately (server side); after a failed mint, 重试 replaces the
  // key the failed attempt meant to replace.
  function replaceJoinKey() {
    if (joinKey.status === "ready") void mintJoinKey(joinKey.key);
    else if (joinKey.status === "error") void mintJoinKey(joinKey.previous);
  }

  const readyKey = joinKey.status === "ready" ? joinKey : null;
  const minutesLeft = readyKey ? joinKeyMinutesLeft(readyKey.expiresAt, now) : 0;

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
                      适用于 Linux、Intel Mac 和服务器。把下面这段话发给目标机器上的 agent（Claude Code、Codex 等），它会安装 cofluxd 并接入当前账号。
                    </Text>
                    {readyKey ? (
                      // CodeBlock has a copy button by default; the text stays selectable if clipboard access is denied.
                      <CodeBlock code={headlessAgentPrompt(DAEMON_URL, readyKey.key)} language="plaintext" size="sm" isWrapped maxHeight={220} />
                    ) : joinKey.status === "error" ? (
                      <VStack gap={1} hAlign="stretch">
                        <HStack gap={2} vAlign="center">
                          <p className="text-sm leading-5 text-destructive">生成密钥失败</p>
                          <AstryxButton label="重试" variant="secondary" size="sm" onClick={replaceJoinKey} />
                        </HStack>
                        <Text type="supporting">{joinKey.error}</Text>
                      </VStack>
                    ) : (
                      <Skeleton height={120} radius={2} />
                    )}
                  </VStack>

                  <Collapsible trigger="自己动手" defaultIsOpen={false}>
                    <VStack gap={2} hAlign="stretch" padding={2}>
                      <Text type="supporting">在目标机器的终端运行（需要 Node.js 20+）：</Text>
                      {readyKey ? (
                        <CodeBlock code={manualInstallCommand(DAEMON_URL, readyKey.key)} language="plaintext" size="sm" isWrapped />
                      ) : joinKey.status === "error" ? (
                        <Text type="supporting">生成密钥后显示命令。</Text>
                      ) : (
                        <Skeleton height={40} radius={2} />
                      )}
                    </VStack>
                  </Collapsible>

                  {readyKey ? (
                    <HStack gap={2} vAlign="center">
                      {minutesLeft > 0 ? (
                        <>
                          <Spinner size="sm" shade="subtle" />
                          <Text type="supporting">{`等待设备接入… 密钥 ${minutesLeft} 分钟内有效，只能用一次 ·`}</Text>
                        </>
                      ) : (
                        <Text type="supporting">密钥已过期 ·</Text>
                      )}
                      <Link type="supporting" onClick={replaceJoinKey}>
                        换一个
                      </Link>
                    </HStack>
                  ) : null}
                </VStack>
              )}
            </VStack>
          </LayoutContent>
        }
      />
    </AstryxDialog>
  );
}
