import { Bot } from "lucide-react";

import { CodexLogo } from "@/components/settings/agent-logos";
import { ClawdGlyph } from "@/components/workbench/clawd-glyph";
import { ActivityDots } from "@/components/workbench/pending-dots";
import { cn } from "@/lib/utils";

/** An agent's status glyph, shared by the terminal tab (plan 075) and the sidebar's 「当前」 rows
 * (plan 20261110-sidebar-current-terminals): claude 用 Clawd 像素小动物并按状态换姿态；
 * 干活健身、待批准/待回答挥旗、未读完成撒花；看过完成态后冻成 gym 第 0 帧站姿。
 * Codex shows its logo (plan 20261001-desktop-agents) and any other agent the lucide robot, both
 * with the state tints (approval/question→warning, error→destructive, done→success). Clawd has no
 * pose for a program stopped on an error, so claude shows the red error cross instead: no Clawd
 * pose reads apart from both done and waiting. */
export function AgentGlyph({
  agent,
  state,
  seen,
  className,
}: {
  agent: string;
  state: string;
  /** 完成态已被用户看过（点开过该 tab）→ 不再撒花。 */
  seen?: boolean;
  className?: string;
}) {
  if (agent === "claude") {
    if (state === "error") return <ActivityDots status="error" />;
    const pose =
      state === "active"
        ? "active"
        : state === "approval" || state === "question"
          ? "raise"
          : (state === "done" || state === "waiting") && !seen
            ? "rest"
            : "idle";
    return <ClawdGlyph pose={pose} className={className} />;
  }
  const tone =
    state === "approval" || state === "question"
      ? "text-warning"
      : state === "error"
        ? "text-destructive"
        : state === "done"
          ? "text-success"
          : "";
  if (agent === "codex") return <CodexLogo className={cn("size-3 shrink-0", tone, className)} />;
  return <Bot className={cn("size-3 shrink-0", tone, className)} />;
}
