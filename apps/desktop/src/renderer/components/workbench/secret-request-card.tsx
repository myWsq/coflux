import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { KeyRound, X } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import type { SecretAnswer, SecretAnswerResult, SecretRequestState } from "@coflux/client";

import { multilineSecretFromPaste, phaseAfterAnswer, type SecretCardPhase } from "@/components/workbench/secret-request";

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
 *
 * Multi-line values (plan 20261002-secret-skill): a password input flattens line breaks before
 * `onChange` sees the text, so the paste event is the only place the original exists. A paste with
 * an inner line break (`multilineSecretFromPaste`) replaces the value and swaps the field for a
 * masked textarea, where Enter inserts a line break and ⌘Enter submits. There is no manual toggle;
 * any other paste, typing and Enter-to-submit behave as in the single-line field.
 */
export function SecretRequestCards({
  requests,
  source,
  deviceName,
  onAnswer,
}: {
  requests: readonly SecretRequestState[];
  /** 设备 · 工作区 · 终端 */
  source: string;
  deviceName: string;
  onAnswer: AnswerSecret;
}) {
  if (requests.length === 0) return null;
  return (
    // Lifted above the pane's dictation button while it is shown (plan 20261110-desktop-dictation
    // D11): the pane sets `--dictation-clearance`.
    <div className="pointer-events-none absolute inset-x-0 bottom-[calc(1rem+var(--dictation-clearance,0px))] z-30 flex flex-col items-end gap-2 px-4">
      {requests.map((request) => (
        <SecretRequestCard key={request.requestId} request={request} source={source} deviceName={deviceName} onAnswer={onAnswer} />
      ))}
    </div>
  );
}

function SecretRequestCard({
  request,
  source,
  deviceName,
  onAnswer,
}: {
  request: SecretRequestState;
  source: string;
  deviceName: string;
  onAnswer: AnswerSecret;
}) {
  const [value, setValue] = useState("");
  const [multiline, setMultiline] = useState(false);
  const [phase, setPhase] = useState<SecretCardPhase>({ kind: "pending" });
  const areaRef = useRef<HTMLTextAreaElement>(null);

  // The textarea replaces the focused password input: carry the focus over, caret at the end.
  useEffect(() => {
    if (!multiline) return;
    const area = areaRef.current;
    if (!area) return;
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }, [multiline]);

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

  // Bubbles up from the single-line input; cancelling it here still stops the input's own paste.
  function onSingleLinePaste(event: ClipboardEvent<HTMLDivElement>) {
    if (multiline || submitting) return;
    const pasted = multilineSecretFromPaste(event.clipboardData.getData("text/plain"));
    if (pasted === null) return;
    event.preventDefault();
    setValue(pasted);
    setMultiline(true);
  }

  function onMultilineKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Enter" || !event.metaKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit({ kind: "provide", value });
  }

  // The masked text must not leave the field in clear text through the clipboard or a drag either.
  function blockExport(event: { preventDefault(): void }) {
    event.preventDefault();
  }

  const deadline = new Date(request.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div
      role="dialog"
      aria-label={`Agent 请求输入 ${request.name}`}
      className="pointer-events-auto w-96 max-w-full rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg"
    >
      <div className="flex items-start gap-2">
        <KeyRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-base font-medium">
            Agent 请求输入 <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm">{request.name}</code>
          </div>
          <div className="mt-0.5 truncate text-sm text-muted-foreground">{source}</div>
        </div>
        <Button
          label="取消请求"
          tooltip="取消请求"
          icon={<X className="size-3.5" />}
          isIconOnly
          variant="ghost"
          size="sm"
          isDisabled={submitting}
          onClick={() => void submit({ kind: "cancel" })}
        />
      </div>
      {request.reason ? (
        <div className="mt-2 rounded-md border border-border bg-muted/40 px-2 py-1.5">
          <div className="text-sm text-muted-foreground">Agent 说</div>
          <div className="mt-0.5 whitespace-pre-wrap break-words text-base">{request.reason}</div>
        </div>
      ) : null}
      <div className="mt-2" onPaste={onSingleLinePaste}>
        {multiline ? (
          // -webkit-text-security draws every character as a disc while keeping the line structure.
          <div className="[&_textarea]:[-webkit-text-security:disc]">
            <TextArea
              ref={areaRef}
              label={`${request.name} 的值`}
              isLabelHidden
              autoComplete="off"
              hasSpellCheck={false}
              rows={5}
              value={value}
              onChange={(next) => setValue(next)}
              onKeyDown={onMultilineKeyDown}
              onCopy={blockExport}
              onCut={blockExport}
              onDragStart={blockExport}
              isDisabled={submitting}
              width="100%"
            />
          </div>
        ) : (
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
        )}
      </div>
      {multiline ? <div className="mt-1 text-sm text-muted-foreground">多行值，换行原样保留 · ⌘Enter 提供</div> : null}
      {phase.kind === "failed" ? (
        <div role="alert" className="mt-1.5">
          <Text type="supporting">{phase.error}，可以重试。</Text>
        </div>
      ) : null}
      <div className="mt-1.5 text-sm text-muted-foreground">只交给 {deviceName || "该设备"}，Agent 看不到 · {deadline} 过期</div>
      <div className="mt-2 flex items-center justify-end gap-2">
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
