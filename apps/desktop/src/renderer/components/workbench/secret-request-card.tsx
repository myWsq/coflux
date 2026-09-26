import { useState } from "react";
import { KeyRound, X } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import type { SecretAnswer, SecretAnswerResult, SecretRequestState } from "@coflux/client";

import { phaseAfterAnswer, type SecretCardPhase } from "@/components/workbench/secret-request";

type AnswerSecret = (requestId: string, answer: SecretAnswer) => Promise<SecretAnswerResult>;

/**
 * Agent secret request cards (plan 20260926-agent-secret-input), overlaid on the requesting
 * terminal's pane. They never take focus on their own: the user clicks into the input. Every desktop
 * of the account shows them; the first answer wins and a request that leaves the live set (answered
 * on another desktop, expired, the agent stopped waiting) simply stops being rendered.
 *
 * The typed value stays in this component's state until it is sent to the device's worker over the
 * end-to-end Device channel; it is cleared once the card closes. Notification and badge come from
 * the request's inbox entry, not from here.
 */
export function SecretRequestCards({
  requests,
  source,
  onAnswer,
}: {
  requests: readonly SecretRequestState[];
  /** 设备 · 工作区 · 终端 */
  source: string;
  onAnswer: AnswerSecret;
}) {
  if (requests.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex flex-col items-end gap-2 px-4">
      {requests.map((request) => (
        <SecretRequestCard key={request.requestId} request={request} source={source} onAnswer={onAnswer} />
      ))}
    </div>
  );
}

function SecretRequestCard({ request, source, onAnswer }: { request: SecretRequestState; source: string; onAnswer: AnswerSecret }) {
  const [value, setValue] = useState("");
  const [phase, setPhase] = useState<SecretCardPhase>({ kind: "pending" });
  if (phase.kind === "closed") return null;
  const submitting = phase.kind === "submitting";

  async function submit(answer: SecretAnswer) {
    if (submitting) return;
    if (answer.kind === "provide" && answer.value.length === 0) return;
    setPhase({ kind: "submitting", answer: answer.kind });
    const next = phaseAfterAnswer(answer.kind, await onAnswer(request.requestId, answer));
    // A closed card forgets the value; a failed one keeps it for the retry.
    if (next.kind === "closed") setValue("");
    setPhase(next);
  }

  const deadline = new Date(request.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div
      role="dialog"
      aria-label={`Agent 请求密钥 ${request.name}`}
      className="pointer-events-auto w-96 max-w-full rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg"
    >
      <div className="flex items-start gap-2">
        <KeyRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">
            Agent 请求密钥 <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{request.name}</code>
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">{source}</div>
        </div>
        <Button
          label="关闭（视为取消）"
          tooltip="关闭：告诉 agent 这次取消了"
          icon={<X className="size-3.5" />}
          isIconOnly
          variant="ghost"
          size="sm"
          isDisabled={submitting}
          onClick={() => void submit({ kind: "cancel" })}
        />
      </div>
      <div className="mt-2 rounded-md border border-border bg-muted/40 px-2 py-1.5">
        <div className="text-[11px] text-muted-foreground">Agent 写的理由（不是 coflux 的说明）</div>
        <div className="mt-0.5 whitespace-pre-wrap break-words text-sm">{request.reason}</div>
      </div>
      <div className="mt-2">
        <TextInput
          label={`${request.name} 的值`}
          isLabelHidden
          type="password"
          autoComplete="off"
          value={value}
          onChange={(next) => setValue(next)}
          onEnter={() => void submit({ kind: "provide", value })}
          placeholder={`粘贴或输入 ${request.name}`}
          isDisabled={submitting}
          width="100%"
        />
      </div>
      {phase.kind === "failed" ? (
        <div role="alert" className="mt-1.5">
          <Text type="supporting">{phase.error}，可以重试。</Text>
        </div>
      ) : null}
      <div className="mt-2 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          只交给该设备的 coflux，agent 看不到这个值 · {deadline} 过期
        </span>
        <Button
          label="拒绝"
          variant="secondary"
          size="sm"
          isDisabled={submitting}
          isLoading={phase.kind === "submitting" && phase.answer === "decline"}
          onClick={() => void submit({ kind: "decline" })}
        />
        <Button
          label="提供"
          variant="primary"
          size="sm"
          isDisabled={submitting || value.length === 0}
          isLoading={phase.kind === "submitting" && phase.answer === "provide"}
          onClick={() => void submit({ kind: "provide", value })}
        />
      </div>
    </div>
  );
}
