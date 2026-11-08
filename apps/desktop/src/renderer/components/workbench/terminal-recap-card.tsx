import { useEffect, useRef, useState, type ReactNode } from "react";
import { Tooltip } from "@astryxdesign/core/Tooltip";

import { ActivityDots, type ActivityDotsStatus } from "@/components/workbench/pending-dots";
import { formatRecapAge, loadRecap, type Recap } from "@/components/workbench/terminal-recap";
import type { TranscriptExec } from "@/components/workbench/terminal-transcript";

/** The agent state as the card words it, matching the sidebar's workspace card. */
function statusOf(state: string): { dots: ActivityDotsStatus; label: string } | null {
  if (state === "active") return { dots: "active", label: "正在执行" };
  if (state === "approval") return { dots: "approval", label: "等待批准" };
  if (state === "question") return { dots: "question", label: "等待回答" };
  if (state === "error") return { dots: "error", label: "出错停止" };
  if (state === "done" || state === "waiting") return { dots: "done", label: "本轮完成" };
  return null;
}

/**
 * The hover card of a terminal tab running Claude: the full title, the agent's state and, when one
 * is current, Claude Code's session recap. The recap is read once per opening — no polling, and
 * nothing is read for tabs nobody hovers. While a turn runs (`active`) there is no recap to show.
 */
export function ClaudeTabCard({
  exec,
  workspaceId,
  agentSessionId,
  agentState,
  title,
  children,
}: {
  /** `client.execInWorkspace`, which routes to whichever device owns the workspace. */
  exec: TranscriptExec;
  workspaceId: string;
  agentSessionId: string;
  agentState: string;
  title: string;
  children: ReactNode;
}) {
  // The last recap read for this tab, tagged with the session it belongs to.
  const [held, setHeld] = useState<{ sessionId: string; recap: Recap } | null>(null);
  // The age is measured against the moment the card opened or its result arrived.
  const [now, setNow] = useState(() => Date.now());

  // A turn starting makes the held recap stale for good: drop it rather than hide it, so a later
  // opening does not flash it again while the fresh read is in flight.
  const [syncedState, setSyncedState] = useState(agentState);
  if (agentState !== syncedState) {
    setSyncedState(agentState);
    if (agentState === "active" && held) setHeld(null);
  }

  // What a result arriving later is checked against; handlers read the latest values from here.
  const live = useRef({ open: false, request: 0, exec, workspaceId, agentSessionId, agentState });
  useEffect(() => {
    live.current.exec = exec;
    live.current.workspaceId = workspaceId;
    live.current.agentSessionId = agentSessionId;
    live.current.agentState = agentState;
  }, [exec, workspaceId, agentSessionId, agentState]);

  const onOpenChange = (open: boolean) => {
    const current = live.current;
    current.open = open;
    const request = ++current.request;
    if (!open) return;
    setNow(Date.now());
    if (current.agentState === "active") return;
    const sessionId = current.agentSessionId;
    const state = current.agentState;
    void loadRecap(current.exec, { agentSessionId: sessionId, workspaceId: current.workspaceId }).then((recap) => {
      const latest = live.current;
      // Discard a result that outlived its card, or whose session or state has since moved on.
      if (latest.request !== request || !latest.open || latest.agentSessionId !== sessionId || latest.agentState !== state) return;
      setNow(Date.now());
      setHeld(recap ? { sessionId, recap } : null);
    });
  };

  const status = statusOf(agentState);
  const recap = agentState !== "active" && held && held.sessionId === agentSessionId ? held.recap : null;
  const card = (
    <div className="flex max-w-sm flex-col gap-1">
      <div className="whitespace-pre-wrap break-words font-medium">{title}</div>
      {status ? (
        <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <ActivityDots status={status.dots} />
          <span className="truncate">{status.label}</span>
        </span>
      ) : null}
      {recap ? (
        <div className="flex flex-col gap-0.5">
          <span className="whitespace-pre-wrap break-words text-sm text-foreground">{recap.text}</span>
          {recap.timestamp !== null ? (
            <span className="text-xs text-muted-foreground">{formatRecapAge(now, recap.timestamp)}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  return (
    <Tooltip content={card} placement="below" hasHoverIndication={false} onOpenChange={onOpenChange}>
      {children}
    </Tooltip>
  );
}
