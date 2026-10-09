import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  type TextareaHTMLAttributes,
} from "react";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Ellipsis,
  LoaderCircle,
  MapPinOff,
  Paperclip,
  Pencil,
  RotateCcw,
  SquareDashedMousePointer,
  Trash2,
  Unplug,
  WifiOff,
  X,
} from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu";
import { useToast } from "@astryxdesign/core/Toast";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import type { AnnotationFailure } from "@coflux/client";
import { AnnotationImageKind, type Annotation, type AnnotationImage } from "@coflux/protocol";

import { annotationMeta, cardPlacement, groupByPage, isResolved, pageKey, type AgentTerminal, type CardBox } from "@/components/workbench/browser-annotations";
import type { AnnotationsModel, WorkspaceAnnotations } from "@/components/workbench/browser-annotations-model";
import { displayUrl } from "@/components/workbench/browser-address";
import type { DesktopAnnotatorPick } from "@/desktop-bridge";
import { cn } from "@/lib/utils";

/**
 * Browser annotations UI (plans 20260929-browser-annotations, 20260929-annotation-polish): the
 * toolbar's two-part button, the hint pill, the comment card for a new pick or an edit, the detail
 * card a pin opens in place, and the side panel. All renderer UI drawn over / beside the
 * `<webview>`; the page itself only shows highlights, outlines and pins.
 *
 * Type scale: body text (comments, inputs, agent notes) `text-base` (13 px); secondary text
 * (component names, group headings, hints, meta lines) `text-sm` (12 px); `text-xs` (11 px) only for
 * number badges.
 */

/** Pasted and attached images are compressed to this budget (the terminal paste path's value). */
const IMAGE_BUDGET_BYTES = 3.5 * 1024 * 1024;
const MAX_REFERENCE_IMAGES = 8;
/** The comment input grows with its content up to this many lines, then scrolls. */
const MAX_INPUT_LINES = 8;

export type DraftImage = { key: string; dataUrl: string; mimeType: string; data: Uint8Array; kind: "screenshot" | "reference" };

/** An annotation being written: a new one for a pick, or an edit of a stored one. */
export type AnnotationDraft = {
  key: string;
  annotationId: string | null;
  number: number | null;
  pick: DesktopAnnotatorPick | null;
  /** The card's title (component chain, 「3 个元素 · …」, 「区域 · …」). */
  title: string;
  /** The comment as it was when the card opened (empty for a new one). */
  original: string;
  comment: string;
  images: DraftImage[];
  existing: AnnotationImage[];
  removed: string[];
  saving: boolean;
  error: string | null;
};

/** Whether closing the card by clicking elsewhere would lose something the user wrote or attached. */
export function draftIsDirty(draft: AnnotationDraft): boolean {
  return draft.comment.trim() !== draft.original.trim() || draft.images.some((image) => image.kind === "reference") || draft.removed.length > 0;
}

type ImageUrl = (annotationId: string, imageId: string) => Promise<string | null>;
type AreaSize = { width: number; height: number };

function bytesToDataUrl(data: Uint8Array, mimeType: string): string {
  let binary = "";
  for (let index = 0; index < data.length; index += 0x8000) binary += String.fromCharCode(...data.subarray(index, index + 0x8000));
  return `data:${mimeType};base64,${btoa(binary)}`;
}

/** An attached image as the worker stores it: kept when small enough and of a known type, else JPEG within the budget. */
export async function prepareReferenceImage(blob: Blob): Promise<DraftImage | null> {
  if (!blob.type.startsWith("image/")) return null;
  const keep = ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(blob.type) && blob.size <= IMAGE_BUDGET_BYTES;
  let mimeType = blob.type;
  let data: Uint8Array;
  if (keep) {
    data = new Uint8Array(await blob.arrayBuffer());
  } else {
    const bitmap = await createImageBitmap(blob).catch(() => null);
    if (!bitmap) return null;
    let width = bitmap.width;
    let height = bitmap.height;
    let best: Blob | null = null;
    for (let round = 0; round < 5 && !(best && best.size <= IMAGE_BUDGET_BYTES); round += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width));
      canvas.height = Math.max(1, Math.round(height));
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.85, 0.7, 0.55]) {
        const encoded = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
        if (encoded && (!best || encoded.size < best.size)) best = encoded;
        if (best && best.size <= IMAGE_BUDGET_BYTES) break;
      }
      width /= 2;
      height /= 2;
    }
    if (!best) return null;
    mimeType = "image/jpeg";
    data = new Uint8Array(await best.arrayBuffer());
  }
  return { key: crypto.randomUUID(), dataUrl: bytesToDataUrl(data, mimeType), mimeType, data, kind: "reference" };
}

/* ---------------------------------------------------------------- shared pieces */

/** How long a deletion's 「撤销」 toast stays; the worker keeps deletions restorable for a minute. */
const UNDO_TOAST_MS = 8000;

/**
 * The 「撤销」 toast after a delete, confirm or clear (plan 20260929-annotation-polish), shared by
 * the browser panel and the changes view. The deletion already happened everywhere (the worker keeps
 * the records restorable for a while); 「撤销」 restores exactly the ids it removed.
 */
export function useAnnotationUndo(
  model: AnnotationsModel,
  workspaceId: string,
  failureText: (result: AnnotationFailure, action: string) => string,
): (body: string, annotationIds: string[]) => void {
  const showToast = useToast();
  async function restore(annotationIds: string[]) {
    const result = await model.change(workspaceId, { kind: "restore", annotationIds });
    if (!result.ok) showToast({ body: failureText(result, "撤销"), type: "error" });
  }
  return function offerUndo(body: string, annotationIds: string[]) {
    if (annotationIds.length === 0) return;
    let dismiss: (() => void) | null = null;
    dismiss = showToast({
      body,
      type: "info",
      autoHideDuration: UNDO_TOAST_MS,
      endContent: (
        <Button
          label="撤销"
          variant="secondary"
          size="sm"
          onClick={() => {
            dismiss?.();
            void restore(annotationIds);
          }}
        />
      ),
    });
  };
}

/** A number badge in the pin's colour (the theme accent; success with ✓ once resolved). */
export function NumberBadge({ number, resolved, className }: { number: number; resolved: boolean; className?: string }) {
  return (
    <span
      className={cn(
        "flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-xs font-semibold leading-none tabular-nums",
        resolved ? "bg-(--color-success) text-(--color-on-success)" : "bg-(--color-accent) text-(--color-on-accent)",
        className,
      )}
    >
      {resolved ? <Check className="size-2.5" strokeWidth={3} /> : number}
    </span>
  );
}

export function IconButton({ label, onClick, children, tone = "default", disabled }: { label: string; onClick: () => void; children: ReactNode; tone?: "default" | "danger"; disabled?: boolean }) {
  return (
    <Tooltip content={label} placement="above">
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent disabled:opacity-35 disabled:hover:bg-transparent",
          tone === "danger" ? "hover:text-destructive" : "hover:text-foreground",
        )}
        onClick={(event) => {
          event.stopPropagation();
          onClick();
        }}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** A textarea that grows with its content up to eight lines, then scrolls. */
export function GrowingInput({ inputRef, value, className, ...props }: { inputRef: RefObject<HTMLTextAreaElement | null>; value: string } & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "rows">) {
  useLayoutEffect(() => {
    const node = inputRef.current;
    if (!node) return;
    const style = getComputedStyle(node);
    const px = (name: string) => parseFloat(style.getPropertyValue(name)) || 0;
    const line = px("line-height") || 20;
    const borders = px("border-top-width") + px("border-bottom-width");
    const max = line * MAX_INPUT_LINES + px("padding-top") + px("padding-bottom") + borders;
    node.style.height = "auto";
    const full = node.scrollHeight + borders;
    node.style.height = `${Math.min(full, max)}px`;
    node.style.overflowY = full > max ? "auto" : "hidden";
  }, [inputRef, value]);
  return (
    <textarea
      ref={inputRef}
      value={value}
      rows={1}
      className={cn(
        "w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-base leading-5 text-foreground outline-none placeholder:text-muted-foreground focus:border-ring disabled:opacity-60",
        className,
      )}
      {...props}
    />
  );
}

/** Enter (not while an input method composes, not with ⇧) submits. */
function isSubmitKey(event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229;
}

/** Places a card from its real measured size, inside the page area. */
function usePlacement(ref: RefObject<HTMLDivElement | null>, anchor: CardBox | null, area: AreaSize): CSSProperties {
  const [size, setSize] = useState<AreaSize | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    // offsetWidth/Height: layout size, unaffected by the shake animation's transform.
    const measure = () =>
      setSize((current) => (current && current.width === node.offsetWidth && current.height === node.offsetHeight ? current : { width: node.offsetWidth, height: node.offsetHeight }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  const maxHeight = Math.max(120, area.height - 16);
  if (!size || area.width <= 0) return { left: 0, top: 0, visibility: "hidden", maxHeight };
  const place = cardPlacement(anchor, size, area);
  return { left: place.left, top: place.top, maxHeight };
}

/** Shakes the card (a click elsewhere while it holds unsaved text) and puts the caret back in it. */
function useShake(shake: number, ref: RefObject<HTMLDivElement | null>, focus: RefObject<HTMLTextAreaElement | null>) {
  const initial = useRef(shake);
  useEffect(() => {
    if (shake === initial.current) return;
    ref.current?.animate(
      [
        { transform: "translateX(0)" },
        { transform: "translateX(-6px)" },
        { transform: "translateX(6px)" },
        { transform: "translateX(-4px)" },
        { transform: "translateX(4px)" },
        { transform: "translateX(0)" },
      ],
      { duration: 320, easing: "ease-in-out" },
    );
    focus.current?.focus();
  }, [shake, ref, focus]);
}

function StoredThumb({ annotationId, image, imageUrl, onRemove }: { annotationId: string; image: AnnotationImage; imageUrl: ImageUrl; onRemove?: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void imageUrl(annotationId, image.imageId).then((next) => {
      if (!cancelled) setUrl(next);
    });
    return () => {
      cancelled = true;
    };
  }, [annotationId, image.imageId, imageUrl]);
  return <Thumb src={url} label={image.kind === AnnotationImageKind.SCREENSHOT ? "截图" : "参考图"} onRemove={onRemove} />;
}

/** A 32 px thumbnail; what it is shows as a tooltip, removing it on hover. */
function Thumb({ src, label, onRemove }: { src: string | null; label: string; onRemove?: () => void }) {
  return (
    <Tooltip content={label} placement="above">
      <div className="group relative size-8 shrink-0 overflow-hidden rounded border border-border bg-muted">
        {src ? <img src={src} alt={label} draggable={false} className="size-full object-cover" /> : <LoaderCircle className="m-auto mt-2 size-3.5 animate-spin text-muted-foreground" />}
        {onRemove ? (
          <button
            type="button"
            aria-label={`移除${label}`}
            className="absolute inset-0 hidden items-center justify-center bg-black/55 text-white group-hover:flex"
            onClick={onRemove}
          >
            <X className="size-3.5" />
          </button>
        ) : null}
      </div>
    </Tooltip>
  );
}

function CardHeader({ badge, title, onClose }: { badge: ReactNode; title: string; onClose: () => void }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      {badge}
      <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{title}</span>
      <Tooltip content="关闭 Esc" placement="above">
        <button type="button" aria-label="关闭" className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground" onClick={onClose}>
          <X className="size-3.5" />
        </button>
      </Tooltip>
    </div>
  );
}

const CARD_CLASS = "pointer-events-auto absolute z-30 flex w-80 flex-col gap-2 overflow-y-auto rounded-lg border border-border bg-popover p-2.5 text-popover-foreground shadow-lg";

/* ---------------------------------------------------------------- the comment card */

export function AnnotationCard({
  cardRef,
  draft,
  anchor,
  area,
  shake,
  readOnly,
  imageUrl,
  onChange,
  onAddImages,
  onSave,
  onClose,
}: {
  cardRef: RefObject<HTMLDivElement | null>;
  draft: AnnotationDraft;
  /** The picked elements (or the annotation) in the page area's pixels; null when not on the page. */
  anchor: CardBox | null;
  area: AreaSize;
  shake: number;
  readOnly: boolean;
  imageUrl: ImageUrl;
  onChange: (patch: Partial<AnnotationDraft>) => void;
  onAddImages: (blobs: Blob[]) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const style = usePlacement(cardRef, anchor, area);
  useShake(shake, cardRef, inputRef);
  useEffect(() => {
    inputRef.current?.focus();
  }, [draft.key]);

  const existing = draft.existing.filter((image) => !draft.removed.includes(image.imageId));
  const references = draft.images.filter((image) => image.kind === "reference").length + existing.filter((image) => image.kind === AnnotationImageKind.REFERENCE).length;
  const canSave = !readOnly && !draft.saving && draft.comment.trim().length > 0;

  function onKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (isSubmitKey(event)) {
      event.preventDefault();
      if (canSave) onSave();
    }
  }

  function onPaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const files = [...event.clipboardData.items]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return;
    event.preventDefault();
    onAddImages(files);
  }

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label="批注"
      className={CARD_CLASS}
      style={style}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.nativeEvent.isComposing || event.defaultPrevented) return;
        event.preventDefault();
        onClose();
      }}
    >
      <CardHeader badge={draft.number !== null ? <NumberBadge number={draft.number} resolved={false} /> : null} title={draft.title} onClose={onClose} />
      <GrowingInput
        inputRef={inputRef}
        value={draft.comment}
        disabled={readOnly || draft.saving}
        placeholder="这里要怎么改？"
        aria-label="批注内容"
        onChange={(event) => onChange({ comment: event.target.value, error: null })}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      {draft.error ? (
        <p role="alert" className="text-sm text-destructive">
          {draft.error}
        </p>
      ) : null}
      <div className="flex min-w-0 items-center gap-1.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {draft.annotationId
            ? existing.map((image) => (
                <StoredThumb
                  key={image.imageId}
                  annotationId={draft.annotationId!}
                  image={image}
                  imageUrl={imageUrl}
                  onRemove={readOnly ? undefined : () => onChange({ removed: [...draft.removed, image.imageId] })}
                />
              ))
            : null}
          {draft.images.map((image) => (
            <Thumb
              key={image.key}
              src={image.dataUrl}
              label={image.kind === "screenshot" ? "截图" : "参考图"}
              onRemove={readOnly ? undefined : () => onChange({ images: draft.images.filter((item) => item.key !== image.key) })}
            />
          ))}
          {!readOnly && references < MAX_REFERENCE_IMAGES ? (
            <IconButton label="附加参考图（也可以直接粘贴）" onClick={() => fileRef.current?.click()}>
              <Paperclip className="size-3.5" />
            </IconButton>
          ) : null}
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = "";
              if (files.length > 0) onAddImages(files);
            }}
          />
        </div>
        <Tooltip content="↩ 保存 · ⇧↩ 换行" placement="above">
          <Button label={draft.error ? "重试" : "保存"} variant="primary" size="sm" isDisabled={!canSave} isLoading={draft.saving} onClick={onSave} />
        </Tooltip>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- the detail card */

/** Opened by a pin (or a panel row), in place: the comment, images, the agent's note and actions. */
export function AnnotationDetailCard({
  cardRef,
  annotation,
  title,
  anchor,
  area,
  shake,
  missing,
  readOnly,
  imageUrl,
  onDirtyChange,
  onEdit,
  onDelete,
  onConfirm,
  onReopen,
  onClose,
}: {
  cardRef: RefObject<HTMLDivElement | null>;
  annotation: Annotation;
  title: string;
  anchor: CardBox | null;
  area: AreaSize;
  shake: number;
  missing: boolean;
  readOnly: boolean;
  imageUrl: ImageUrl;
  /** Whether a reopen comment is being written (clicking elsewhere then shakes instead of closing). */
  onDirtyChange: (dirty: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  onConfirm: () => void;
  onReopen: (comment: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const style = usePlacement(cardRef, anchor, area);
  useShake(shake, cardRef, inputRef);
  const [reopening, setReopening] = useState(false);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolved = isResolved(annotation);

  const dirty = reopening && comment.trim().length > 0;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (reopening) inputRef.current?.focus();
  }, [reopening]);

  async function submitReopen() {
    if (!comment.trim() || busy) return;
    setBusy(true);
    setError(null);
    const ok = await onReopen(comment.trim());
    setBusy(false);
    if (ok) {
      setReopening(false);
      setComment("");
    } else setError("重新打开失败，可以重试");
  }

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label={`批注 #${annotation.number}`}
      className={CARD_CLASS}
      style={style}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        onClose();
      }}
    >
      <CardHeader badge={<NumberBadge number={annotation.number} resolved={resolved} />} title={title} onClose={onClose} />
      <p className={cn("whitespace-pre-wrap break-words text-base", resolved ? "text-muted-foreground" : "text-foreground")}>{annotation.comment}</p>
      {missing ? (
        <p className="flex items-center gap-1 text-sm text-warning">
          <MapPinOff className="size-3.5" />
          元素未找到
        </p>
      ) : null}
      {annotation.images.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {annotation.images.map((image) => (
            <StoredThumb key={image.imageId} annotationId={annotation.annotationId} image={image} imageUrl={imageUrl} />
          ))}
        </div>
      ) : null}
      {resolved ? (
        <div className="rounded-md bg-muted/60 px-2 py-1.5">
          <p className="text-sm text-muted-foreground">Agent 的说明</p>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-base text-foreground">{annotation.resolutionNote || "（没有留下说明）"}</p>
        </div>
      ) : null}
      {readOnly ? null : reopening ? (
        <>
          <GrowingInput
            inputRef={inputRef}
            value={comment}
            placeholder="还有哪里不对？"
            aria-label="重新打开的补充说明"
            disabled={busy}
            onChange={(event) => setComment(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Escape") {
                // Leaves the reply, not the card.
                event.preventDefault();
                event.stopPropagation();
                setReopening(false);
              } else if (isSubmitKey(event)) {
                event.preventDefault();
                void submitReopen();
              }
            }}
          />
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-1.5">
            <Button label="取消" variant="ghost" size="sm" onClick={() => setReopening(false)} />
            <Button label="重新打开" variant="primary" size="sm" isLoading={busy} isDisabled={!comment.trim()} onClick={() => void submitReopen()} />
          </div>
        </>
      ) : resolved ? (
        <div className="flex justify-end gap-1.5">
          <Button label="重新打开" variant="ghost" size="sm" icon={<RotateCcw className="size-3.5" />} onClick={() => setReopening(true)} />
          <Button label="确认" variant="secondary" size="sm" icon={<Check className="size-3.5" />} onClick={onConfirm} />
        </div>
      ) : (
        <div className="flex justify-end gap-1.5">
          <Button label="删除" variant="ghost" size="sm" icon={<Trash2 className="size-3.5" />} onClick={onDelete} />
          <Button label="编辑" variant="secondary" size="sm" icon={<Pencil className="size-3.5" />} onClick={onEdit} />
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- the toolbar and the hint */

/**
 * The toolbar's `[⬚↖ | n]`: the icon toggles annotate mode (⌘⇧D), the count toggles the panel. The
 * count is the pending annotations, else ✓ with the resolved ones; absent when there are none.
 */
export function AnnotateButton({
  active,
  count,
  disabledReason,
  panelOpen,
  onToggleMode,
  onTogglePanel,
}: {
  active: boolean;
  count: { kind: "pending" | "resolved"; count: number } | null;
  disabledReason: string | null;
  panelOpen: boolean;
  onToggleMode: () => void;
  onTogglePanel: () => void;
}) {
  const modeLabel = disabledReason ?? (active ? "退出批注模式 ⌘⇧D" : "批注模式 ⌘⇧D");
  const panelLabel = panelOpen ? "隐藏批注列表" : "显示批注列表";
  return (
    <div className="flex h-6 shrink-0 items-center">
      <Tooltip content={modeLabel} placement="below">
        <button
          type="button"
          aria-label={modeLabel}
          aria-pressed={active}
          disabled={disabledReason !== null}
          className={cn(
            "flex size-6 items-center justify-center transition-colors disabled:opacity-35 disabled:hover:bg-transparent",
            count ? "rounded-l-md" : "rounded-md",
            active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
          onClick={onToggleMode}
        >
          <SquareDashedMousePointer className="size-3.5" />
        </button>
      </Tooltip>
      {count ? (
        <Tooltip content={panelLabel} placement="below">
          <button
            type="button"
            aria-label={panelLabel}
            aria-pressed={panelOpen}
            className={cn(
              "flex h-6 items-center gap-0.5 rounded-r-md border-l border-border px-1.5 text-sm tabular-nums transition-colors",
              panelOpen ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
            onClick={onTogglePanel}
          >
            {count.kind === "resolved" ? <Check className="size-3" /> : null}
            {count.count}
          </button>
        </Tooltip>
      ) : null}
    </div>
  );
}

/** The pill at the top of the page while annotate mode waits for a pick. */
export function AnnotationHint() {
  return (
    <div className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-background/95 px-2.5 py-1 text-sm text-muted-foreground shadow">
      点击选择 · ⇧点击多选 · ⇧拖动框选 · ↑↓ 层级 · Esc 退出
    </div>
  );
}

/* ---------------------------------------------------------------- the side panel */

export type PanelNotice = "offline" | "unsupported" | "unreachable" | null;

export function AnnotationsPanel({
  entry,
  currentUrl,
  missing,
  notice,
  selectedId,
  agents,
  onClose,
  onRetry,
  onSelect,
  onHover,
  onEdit,
  onDelete,
  onConfirm,
  onReopen,
  onClearResolved,
  onCopyMarkdown,
  onHandOff,
}: {
  entry: WorkspaceAnnotations;
  currentUrl: string;
  /** Annotations of the current page whose element the page does not have. */
  missing: ReadonlySet<string>;
  notice: PanelNotice;
  selectedId: string | null;
  agents: readonly AgentTerminal[];
  onClose: () => void;
  onRetry: () => void;
  onSelect: (annotation: Annotation) => void;
  /** The row under the pointer: its elements or region are outlined on the page. */
  onHover: (annotationId: string | null) => void;
  onEdit: (annotation: Annotation) => void;
  onDelete: (annotation: Annotation) => void;
  onConfirm: (annotation: Annotation) => void;
  onReopen: (annotation: Annotation, comment: string) => Promise<boolean>;
  onClearResolved: () => void;
  onCopyMarkdown: () => void;
  onHandOff: (taskId: string) => void;
}) {
  const [handOffOpen, setHandOffOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [resolvedOpen, setResolvedOpen] = useState(true);
  const handOffRef = useRef<HTMLButtonElement | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const annotations = entry.annotations ?? [];
  const pending = annotations.filter((annotation) => !isResolved(annotation));
  const resolved = annotations.filter(isResolved).sort((a, b) => a.number - b.number);
  const readOnly = notice !== null;
  const currentKey = currentUrl ? pageKey(currentUrl) : "";

  return (
    <aside aria-label="批注" className="flex w-72 shrink-0 flex-col border-l border-border bg-background" onPointerLeave={() => onHover(null)}>
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <span className="min-w-0 flex-1 truncate text-base font-medium text-foreground">
          批注{pending.length > 0 ? ` · ${pending.length} 条待处理` : ""}
        </span>
        <DropdownMenu
          isMenuOpen={handOffOpen}
          onOpenChange={setHandOffOpen}
          menuWidth={240}
          hasChevron={false}
          placement="below"
          alignment="end"
          button={{
            ref: handOffRef,
            label: "交给 agent",
            icon: <ChevronDown className="size-3" />,
            variant: "ghost",
            size: "sm",
            isDisabled: readOnly || pending.length === 0,
          }}
        >
          {agents.length === 0 ? (
            <DropdownMenuItem label="这个工作区没有正在运行 agent 的终端" isDisabled onClick={() => undefined} />
          ) : (
            agents.map((agent) => (
              <DropdownMenuItem key={agent.taskId} icon={<Bot className="size-3.5" />} label={`${agent.title || "终端"} · ${agent.agent}`} onClick={() => onHandOff(agent.taskId)} />
            ))
          )}
        </DropdownMenu>
        {/* Sibling tooltips after their menus, never button.tooltip (docs/design-guidelines.md). */}
        <Tooltip anchorRef={handOffRef} isOpen={handOffOpen ? false : undefined} content="把待处理的批注交给这个工作区里的 agent" />
        <DropdownMenu
          isMenuOpen={moreOpen}
          onOpenChange={setMoreOpen}
          menuWidth={200}
          hasChevron={false}
          placement="below"
          alignment="end"
          button={{
            ref: moreRef,
            label: "更多",
            icon: <Ellipsis className="size-3.5" />,
            isIconOnly: true,
            variant: "ghost",
            size: "sm",
            style: { color: "var(--muted-foreground)", height: 24, width: 24, minWidth: 24, paddingInline: 0 },
          }}
        >
          <DropdownMenuItem icon={<Copy className="size-3.5" />} label="复制为 markdown" isDisabled={annotations.length === 0} onClick={onCopyMarkdown} />
          <DropdownMenuItem icon={<Trash2 className="size-3.5" />} label="清除全部已完成" isDisabled={readOnly || resolved.length === 0} onClick={onClearResolved} />
        </DropdownMenu>
        <Tooltip anchorRef={moreRef} isOpen={moreOpen ? false : undefined} content="更多" />
        <Tooltip content="关闭批注列表" placement="below">
          <button type="button" aria-label="关闭批注列表" className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" onClick={onClose}>
            <X className="size-3.5" />
          </button>
        </Tooltip>
      </div>

      {notice ? <Notice notice={notice} onRetry={onRetry} /> : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {entry.annotations === null && entry.loading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
          </div>
        ) : annotations.length === 0 && !notice ? (
          <p className="px-4 py-8 text-center text-sm leading-5 text-muted-foreground">按 ⌘⇧D 进入批注模式，点击页面元素写下要怎么改</p>
        ) : null}

        {groupByPage(pending).map((group) => (
          <section key={group.key} className="border-b border-border py-1">
            <h3 className="truncate px-3 pb-0.5 pt-1.5 text-sm font-medium text-muted-foreground">
              {group.title || displayUrl(group.url)}
              {group.key === currentKey ? " · 当前页面" : ""}
            </h3>
            {group.annotations.map((annotation) => (
              <PendingRow
                key={annotation.annotationId}
                annotation={annotation}
                selected={annotation.annotationId === selectedId}
                missing={group.key === currentKey && missing.has(annotation.annotationId)}
                readOnly={readOnly}
                onSelect={() => onSelect(annotation)}
                onHover={onHover}
                onEdit={() => onEdit(annotation)}
                onDelete={() => onDelete(annotation)}
              />
            ))}
          </section>
        ))}

        {resolved.length > 0 ? (
          <section className="py-1">
            <button
              type="button"
              aria-expanded={resolvedOpen}
              className="flex w-full min-w-0 items-center gap-1 px-2 pb-0.5 pt-1.5 text-left text-sm font-medium text-muted-foreground hover:text-foreground"
              onClick={() => setResolvedOpen((open) => !open)}
            >
              <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", resolvedOpen && "rotate-90")} />
              <span className="truncate">已完成 · 等你确认 ({resolved.length})</span>
            </button>
            {resolvedOpen
              ? resolved.map((annotation) => (
                  <ResolvedRow
                    key={annotation.annotationId}
                    annotation={annotation}
                    selected={annotation.annotationId === selectedId}
                    readOnly={readOnly}
                    onSelect={() => onSelect(annotation)}
                    onHover={onHover}
                    onConfirm={() => onConfirm(annotation)}
                    onReopen={(comment) => onReopen(annotation, comment)}
                  />
                ))
              : null}
          </section>
        ) : null}
      </div>
    </aside>
  );
}

function Notice({ notice, onRetry }: { notice: Exclude<PanelNotice, null>; onRetry: () => void }) {
  const content =
    notice === "unsupported"
      ? { icon: <Unplug className="size-3.5 shrink-0" />, text: "该设备 coflux 版本过旧，更新后才能使用浏览器批注。", retry: false }
      : notice === "offline"
        ? { icon: <WifiOff className="size-3.5 shrink-0" />, text: "设备离线：下面是上次加载的批注，只能查看。", retry: true }
        : { icon: <WifiOff className="size-3.5 shrink-0" />, text: "连不上这个工作区所在的设备，批注暂时只能查看。", retry: true };
  return (
    <div className="flex items-start gap-2 border-b border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
      <span className="mt-0.5">{content.icon}</span>
      <span className="min-w-0 flex-1 leading-5">{content.text}</span>
      {content.retry ? (
        <button type="button" className="shrink-0 text-foreground hover:underline" onClick={onRetry}>
          重试
        </button>
      ) : null}
    </div>
  );
}

function PendingRow({
  annotation,
  selected,
  missing,
  readOnly,
  onSelect,
  onHover,
  onEdit,
  onDelete,
}: {
  annotation: Annotation;
  selected: boolean;
  missing: boolean;
  readOnly: boolean;
  onSelect: () => void;
  onHover: (annotationId: string | null) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={cn("group flex cursor-pointer items-start gap-2 px-3 py-1.5 hover:bg-accent/60", selected && "bg-accent")}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onPointerEnter={() => onHover(annotation.annotationId)}
      onPointerLeave={() => onHover(null)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onSelect();
      }}
    >
      <NumberBadge number={annotation.number} resolved={false} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="line-clamp-3 whitespace-pre-wrap break-words text-base text-foreground">{annotation.comment}</p>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
          {missing ? (
            <span className="flex shrink-0 items-center gap-0.5 text-warning">
              <MapPinOff className="size-3" />
              元素未找到
            </span>
          ) : null}
          <span className="truncate">{annotationMeta(annotation)}</span>
          {annotation.followUps.length > 0 ? <span className="shrink-0">· 已重新打开</span> : null}
        </div>
      </div>
      {!readOnly ? (
        <span className="hidden shrink-0 items-center group-hover:flex">
          <IconButton label="编辑" onClick={onEdit}>
            <Pencil className="size-3.5" />
          </IconButton>
          <IconButton label="删除" tone="danger" onClick={onDelete}>
            <Trash2 className="size-3.5" />
          </IconButton>
        </span>
      ) : null}
    </div>
  );
}

function ResolvedRow({
  annotation,
  selected,
  readOnly,
  onSelect,
  onHover,
  onConfirm,
  onReopen,
}: {
  annotation: Annotation;
  selected: boolean;
  readOnly: boolean;
  onSelect: () => void;
  onHover: (annotationId: string | null) => void;
  onConfirm: () => void;
  onReopen: (comment: string) => Promise<boolean>;
}) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [reopening, setReopening] = useState(false);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (reopening) inputRef.current?.focus();
  }, [reopening]);

  async function submitReopen() {
    if (!comment.trim() || busy) return;
    setBusy(true);
    setError(null);
    const ok = await onReopen(comment.trim());
    setBusy(false);
    if (ok) {
      setReopening(false);
      setComment("");
    } else setError("重新打开失败，可以重试");
  }

  return (
    <div
      className={cn("group px-3 py-1.5 hover:bg-accent/40", selected && "bg-accent")}
      onPointerEnter={() => onHover(annotation.annotationId)}
      onPointerLeave={() => onHover(null)}
    >
      <div className="flex cursor-pointer items-start gap-2" onClick={onSelect}>
        <NumberBadge number={annotation.number} resolved className="mt-0.5" />
        <div className="min-w-0 flex-1">
          {/* The agent's note leads: it is what the user reviews. */}
          <p className="line-clamp-3 whitespace-pre-wrap break-words text-base text-foreground">{annotation.resolutionNote || "（没有留下说明）"}</p>
          <p className="mt-0.5 truncate text-sm text-muted-foreground">
            #{annotation.number} · {annotation.comment.replace(/\s+/g, " ").trim()}
          </p>
        </div>
        {!readOnly && !reopening ? (
          <span className="hidden shrink-0 items-center group-hover:flex">
            <IconButton label="确认" onClick={onConfirm}>
              <Check className="size-3.5" />
            </IconButton>
            <IconButton label="重新打开" onClick={() => setReopening(true)}>
              <RotateCcw className="size-3.5" />
            </IconButton>
          </span>
        ) : null}
      </div>
      {!readOnly && reopening ? (
        <div className="mt-1.5 pl-6">
          <GrowingInput
            inputRef={inputRef}
            value={comment}
            placeholder="还有哪里不对？"
            aria-label="重新打开的补充说明"
            disabled={busy}
            onChange={(event) => setComment(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setReopening(false);
              } else if (isSubmitKey(event)) {
                event.preventDefault();
                void submitReopen();
              }
            }}
          />
          {error ? <p className="mt-0.5 text-sm text-destructive">{error}</p> : null}
          <div className="mt-1 flex justify-end gap-1.5">
            <Button label="取消" variant="ghost" size="sm" onClick={() => setReopening(false)} />
            <Button label="重新打开" variant="primary" size="sm" isLoading={busy} isDisabled={!comment.trim()} onClick={() => void submitReopen()} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
