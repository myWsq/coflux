import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useStore } from "zustand";
import {
  AppWindow,
  ArrowLeft,
  ArrowRight,
  Camera,
  Cookie,
  Copy,
  Crop,
  Ellipsis,
  ExternalLink,
  Globe,
  History,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  RotateCw,
  ShieldAlert,
  SquareCode,
  Trash2,
  Unplug,
  WifiOff,
  X,
} from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { DropdownMenu, DropdownMenuDivider, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { useToast } from "@astryxdesign/core/Toast";
import { ANNOTATION_UPLOAD_TOO_LARGE, MAX_ANNOTATION_UPLOAD_BYTES, type AnnotationFailure, type CofluxClient } from "@coflux/client";
import { AnnotationImageKind, AnnotationPutSchema, create, type Annotation } from "@coflux/protocol";

import { BROWSER_DEVTOOLS_PARTITION } from "../../../shared/browser-partitions";
import type { DesktopBrowserScope } from "../../../shared/desktop-bridge";
import {
  displayUrl,
  hostLabel,
  isLoopbackUrl,
  isWebUrl,
  localPortUrl,
  loopbackPortOf,
  resolveAddressInput,
} from "@/components/workbench/browser-address";
import {
  clearHistory,
  rankSuggestions,
  recordVisit,
  updateHistoryTitle,
  type BrowserSuggestion,
  type HistoryEntry,
} from "@/components/workbench/browser-library";
import type { BrowserRuntime } from "@/components/workbench/browser-runtime";
import {
  agentTerminals,
  annotationCount,
  annotationsMarkdown,
  annotationTitle,
  dataUrlToImage,
  HAND_OFF_INSTRUCTION,
  isResolved,
  pageAnnotations,
  pageKey,
  pinsForPage,
  type CardBox,
} from "@/components/workbench/browser-annotations";
import { annotationsModelFor, useWorkspaceAnnotations } from "@/components/workbench/browser-annotations-model";
import {
  AnnotateButton,
  AnnotationCard,
  AnnotationDetailCard,
  AnnotationHint,
  AnnotationsPanel,
  draftIsDirty,
  prepareReferenceImage,
  useAnnotationUndo,
  type AnnotationDraft,
  type PanelNotice,
} from "@/components/workbench/browser-annotations-ui";
import { entityHandle } from "@/components/workbench/entity-handle";
import { listForwardedPorts, type ForwardedPort } from "@/components/workbench/port-menu";
import { SHORTCUT_MODIFIER_PREFIX } from "@/components/workbench/shortcut-modifier";
import { desktop } from "@/config";
import type {
  DesktopAnnotatorBox,
  DesktopAnnotatorPick,
  DesktopAnnotatorState,
  DesktopAnnotatorViewport,
  DesktopBrowserCertificate,
  DesktopBrowserEvent,
  DesktopBrowserMode,
  DesktopBrowserPrepared,
  DesktopBrowserTunnelFailure,
} from "@/desktop-bridge";
import { cn } from "@/lib/utils";

/**
 * Built-in browser tabs (plan 20260924-desktop-browser-tab), aligned with Cursor's in-editor browser
 * minus select-element / agent control.
 *
 * The layer mirrors the terminal pane layer (terminal-panes.tsx): it covers the whole main area,
 * sits after the workspace containers, is pointer-events-none as a whole, and holds one view per
 * browser tab, keyed by tab id and placed on its group's body rectangle. A view is never
 * re-parented or re-keyed — moving a `<webview>` to another parent reloads its page — so moving a
 * tab between groups only changes the rectangle. A tab that is not on screen stays mounted and is
 * hidden with `visibility: hidden` at its last rectangle, never `display: none` (a webview must keep
 * its internal `display: flex`), so its page keeps running — HMR sockets included — until the tab is
 * closed.
 *
 * The `<webview>` elements are created imperatively inside a host node React renders no children
 * into, in the order the main process requires: prepare the scope's partition → insert the
 * element with that partition and `src="about:blank"` → once attached, navigate through main.
 */

export type BrowserViewEntry = {
  tabId: string;
  workspaceId: string;
  /** The device the workspace lives on; main compares it with this Mac's to decide what `localhost` is. */
  daemonId: string;
  /**
   * Whose browser state the tab uses: its workspace's project, or its device on the device view
   * (plan 20260929-browser-scope-partitions). Derived by the Workbench, never stored with the tab.
   */
  scope: DesktopBrowserScope;
  /** Its group's active tab in the selected workspace, changes overlay closed. */
  visible: boolean;
  /** The focused group's active tab. */
  focused: boolean;
  /** Its group's body rectangle (percentages of the main area). */
  frame: CSSProperties;
};

type BrowserViewsProps = {
  runtime: BrowserRuntime;
  client: CofluxClient;
  entries: readonly BrowserViewEntry[];
  /** A pointer went down anywhere in a view: its group becomes the focused one. */
  onPointerFocus: (tabId: string) => void;
};

/** The subset of Electron's `<webview>` element this file uses (no Electron types in the renderer). */
type WebviewElement = HTMLElement & { getWebContentsId: () => number };

type Failure =
  | { kind: "refused"; url: string }
  | { kind: "network"; url: string; code: number; description: string }
  /** A remote workspace's loopback load failed in the device tunnel (plan 20260924-remote-localhost-tunnel). */
  | { kind: "tunnel"; url: string; reason: DesktopBrowserTunnelFailure }
  | { kind: "certificate"; url: string; host: string; certificate: DesktopBrowserCertificate | null }
  | { kind: "crashed"; url: string };


/** Chromium net error codes the error pages distinguish. */
const NET_ERR_ABORTED = -3;
const NET_ERR_BLOCKED_BY_CLIENT = -20;
const NET_ERR_CONNECTION_REFUSED = -102;

function isCertificateError(code: number): boolean {
  return code <= -200 && code > -300;
}

/** The page for a failed load main has nothing more specific about. */
function loadFailure(url: string, code: number, description: string): Failure {
  if (code === NET_ERR_CONNECTION_REFUSED) return { kind: "refused", url };
  return { kind: "network", url, code, description };
}

function createWebview(partition: string, options: { allowPopups: boolean }): WebviewElement {
  const element = document.createElement("webview") as WebviewElement;
  // Attributes before insertion: the guest attaches when the element enters the document, and the
  // main-process gate only admits a prepared partition on about:blank.
  element.setAttribute("partition", partition);
  element.setAttribute("src", "about:blank");
  // Without it no handler ever sees a popup; main's handler denies every one and opens a tab instead.
  if (options.allowPopups) element.setAttribute("allowpopups", "");
  element.style.position = "absolute";
  element.style.inset = "0";
  element.style.width = "100%";
  element.style.height = "100%";
  return element;
}

export function BrowserViews({ runtime, client, entries, onPointerFocus }: BrowserViewsProps) {
  const showToast = useToast();
  useEffect(
    () =>
      runtime.onDownload((event) => {
        if (event.state === "completed") showToast({ body: `已下载到「下载」文件夹：${event.filename}`, type: "info" });
        else if (event.state === "interrupted") showToast({ body: `下载失败：${event.filename}`, type: "error" });
      }),
    [runtime, showToast],
  );
  return (
    <div className="pointer-events-none absolute inset-0">
      {entries.map((entry) => (
        <BrowserView key={entry.tabId} entry={entry} runtime={runtime} client={client} onPointerFocus={onPointerFocus} />
      ))}
    </div>
  );
}

function ToolbarButton({
  label,
  onClick,
  disabled,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip content={label} placement="below">
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-35 disabled:hover:bg-transparent",
          pressed ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
        onClick={onClick}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function BrowserView({
  entry,
  runtime,
  client,
  onPointerFocus,
}: {
  entry: BrowserViewEntry;
  runtime: BrowserRuntime;
  client: CofluxClient;
  onPointerFocus: (tabId: string) => void;
}) {
  const { tabId, workspaceId, daemonId, visible } = entry;
  const { kind: scopeKind, id: scopeId } = entry.scope;
  // A stable object for effects: the entry's is rebuilt on every Workbench render.
  const scope = useMemo<DesktopBrowserScope>(() => ({ kind: scopeKind, id: scopeId }), [scopeKind, scopeId]);
  const showToast = useToast();
  const tab = useStore(runtime.tabs, (state) => state.tabs[tabId]);
  const library = useStore(runtime.library, (state) => state.library);
  const tasks = useStore(client.store, (state) => state.tasks);
  const ports = useStore(client.store, (state) => state.ports);

  const [prepared, setPrepared] = useState<DesktopBrowserPrepared | null>(null);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [mode, setMode] = useState<DesktopBrowserMode | null>(() => runtime.modeOf(scope));
  const [guestId, setGuestId] = useState<number | null>(null);
  const [history, setHistory] = useState({ canGoBack: false, canGoForward: false, zoomFactor: 1 });
  const [failure, setFailure] = useState<Failure | null>(null);
  const [editing, setEditing] = useState(false);
  const [addressText, setAddressText] = useState("");
  // When editing began or the address text was last typed: the "now" suggestions are ranked against
  // (read from the clock in those handlers, never during render).
  const [typedAt, setTypedAt] = useState(0);
  const [highlight, setHighlight] = useState(-1);
  const [devtoolsOpen, setDevtoolsOpen] = useState(false);
  const [frozenFrame, setFrozenFrame] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [trusting, setTrusting] = useState(false);
  // Browser annotations (plans 20260929-browser-annotations, 20260929-annotation-polish).
  const [annotating, setAnnotating] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [draft, setDraft] = useState<AnnotationDraft | null>(null);
  /** The draft as last rendered, for the async attach path's size budget. */
  const draftRef = useRef<AnnotationDraft | null>(null);
  useEffect(() => {
    draftRef.current = draft;
  });
  /** The annotation whose detail card is open (a pin or a panel row), and whether the page scrolls to it. */
  const [detail, setDetail] = useState<{ id: string; scroll: boolean } | null>(null);
  /** The detail card holds an unsent reopen comment. */
  const [detailDirty, setDetailDirty] = useState(false);
  /** Bumped to shake the open card (a click elsewhere while it holds unsaved text). */
  const [shake, setShake] = useState(0);
  /** The panel row under the pointer: its elements or region are outlined on the page. */
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [anchorBox, setAnchorBox] = useState<{ rect: DesktopAnnotatorBox | null; viewport: DesktopAnnotatorViewport } | null>(null);
  const [missing, setMissing] = useState<{ url: string; ids: ReadonlySet<string> }>({ url: "", ids: new Set() });
  const [annotatorAvailable, setAnnotatorAvailable] = useState(true);
  const [pageSize, setPageSize] = useState({ width: 0, height: 0 });
  const sessionAgents = useStore(client.store, (state) => state.sessionAgents);
  const workspaces = useStore(client.store, (state) => state.workspaces);
  const annotationSummary = useStore(client.store, (state) => state.annotationSummaries[workspaceId]);
  const daemonOnline = useStore(client.store, (state) => state.daemons.find((daemon) => daemon.daemonId === daemonId)?.online ?? false);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const webviewHostRef = useRef<HTMLDivElement | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const devtoolsHostRef = useRef<HTMLDivElement | null>(null);
  const webviewRef = useRef<WebviewElement | null>(null);
  const addressRef = useRef<HTMLInputElement | null>(null);
  const moreAnchorRef = useRef<HTMLButtonElement | null>(null);
  const guestIdRef = useRef<number | null>(null);
  /** A URL asked for before the guest attached; loaded as soon as it does. */
  const pendingUrlRef = useRef<string | null>(null);
  const selectionStartRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  /** The user asked for this tab's focus before its guest attached. */
  const wantFocusRef = useRef(false);

  const url = tab?.url ?? "";
  const title = tab?.title ?? "";
  const loading = tab?.loading ?? false;
  const blank = url === "" && failure === null;

  // ---- browser annotations (plans 20260929-browser-annotations, 20260929-annotation-polish) ----
  const annotationsModel = annotationsModelFor(client);
  const annotationsEntry = useWorkspaceAnnotations(client, workspaceId, visible && (isWebUrl(url) || panelOpen));
  // The panel, the pins and the count show page annotations only: code comments belong to the
  // changes view (plan 20261001-changes-review-comments), though they share the store and numbering.
  const loadedAnnotations = annotationsEntry.annotations;
  const annotations = useMemo(() => (loadedAnnotations ? pageAnnotations(loadedAnnotations) : null), [loadedAnnotations]);
  const panelEntry = useMemo(() => ({ ...annotationsEntry, annotations }), [annotationsEntry, annotations]);
  const offerUndo = useAnnotationUndo(annotationsModel, workspaceId, annotationFailureText);
  const annotationNotice: PanelNotice =
    annotationsEntry.status === "unsupported" ? "unsupported" : annotationsEntry.status === "unreachable" ? (daemonOnline ? "unreachable" : "offline") : null;
  const annotationsReadOnly = annotationNotice !== null;
  const annotateDisabledReason =
    annotationNotice === "unsupported"
      ? "该设备 coflux 版本过旧，更新后才能使用浏览器批注"
      : annotationsReadOnly
        ? "连不上这个工作区所在的设备，暂时不能添加批注"
        : !isWebUrl(url) || failure
          ? "打开网页后才能批注"
          : !annotatorAvailable
            ? "这个页面暂时无法批注，稍后重试"
            : null;
  const pageActive = isWebUrl(url) && !failure;
  const pagePins = pageActive && annotations ? pinsForPage(annotations, url) : [];
  const detailAnnotation = detail && annotations ? (annotations.find((annotation) => annotation.annotationId === detail.id) ?? null) : null;
  const cardOpen = draft !== null || detailAnnotation !== null;
  const cardDirty = (draft !== null && draftIsDirty(draft)) || (detailAnnotation !== null && detailDirty);
  const annotatorAnchor: DesktopAnnotatorState["anchor"] = draft?.pick
    ? { kind: "pick", token: draft.pick.token }
    : draft?.annotationId
      ? { kind: "pin", id: draft.annotationId, scroll: true }
      : detailAnnotation && detail
        ? { kind: "pin", id: detailAnnotation.annotationId, scroll: detail.scroll }
        : null;
  const outlined = [...new Set([draft?.annotationId, detailAnnotation?.annotationId, hoveredId].filter((id): id is string => !!id))];
  const annotatorState: DesktopAnnotatorState = {
    mode: annotating && !cardOpen && annotateDisabledReason === null,
    // While a card is open the page swallows clicks and reports them as clicks outside the card.
    capture: cardOpen && pageActive,
    pins: pagePins,
    anchor: annotatorAnchor,
    outlined,
  };
  const annotatorKey = JSON.stringify(annotatorState);
  const pageMissing = missing.url && pageKey(missing.url) === pageKey(url) ? missing.ids : new Set<string>();
  const annotationImageUrl = useCallback(
    (annotationId: string, imageId: string) => annotationsModel.imageUrl(workspaceId, annotationId, imageId),
    [annotationsModel, workspaceId],
  );
  /** The anchor in the page area's pixels (page CSS pixels scale onto the webview). */
  const cardAnchor: CardBox | null =
    anchorBox?.rect && anchorBox.viewport.width > 0 && pageSize.width > 0
      ? (() => {
          const scale = pageSize.width / anchorBox.viewport.width;
          const rect = anchorBox.rect;
          return { x: rect.x * scale, y: rect.y * scale, width: rect.width * scale, height: rect.height * scale };
        })()
      : null;

  function annotationFailureText(result: AnnotationFailure, action: string): string {
    if (result.reason === "unsupported") return "该设备 coflux 版本过旧，不支持浏览器批注";
    if (result.reason === "unreachable") return `${action}失败：连不上这个工作区所在的设备`;
    return `${action}失败：${result.error}`;
  }

  function closeCard() {
    setDraft(null);
    setDetail(null);
    setDetailDirty(false);
    setAnchorBox(null);
    // Back to picking: the page takes the keys (↑↓, ⇧) again.
    if (annotating) focusPage();
  }

  /** A click elsewhere: an empty card closes, one holding unsaved text shakes instead. */
  function clickedOutsideCard() {
    if (cardDirty) setShake((value) => value + 1);
    else closeCard();
  }

  function onAnnotatorPick(pick: DesktopAnnotatorPick) {
    const shot = pick.screenshot ? dataUrlToImage(pick.screenshot) : null;
    setDetail(null);
    setDetailDirty(false);
    setAnchorBox({ rect: pick.rect, viewport: pick.viewport });
    setDraft({
      key: crypto.randomUUID(),
      annotationId: null,
      number: null,
      pick,
      title: annotationTitle(pick.targets, pick.region !== null),
      original: "",
      comment: "",
      images: shot && pick.screenshot ? [{ key: crypto.randomUUID(), dataUrl: pick.screenshot, mimeType: shot.mimeType, data: shot.data, kind: "screenshot" }] : [],
      existing: [],
      removed: [],
      saving: false,
      error: null,
    });
  }

  /** A pin click (in annotate mode or not) opens its detail card in place. */
  function openDetail(annotationId: string, scroll: boolean) {
    if (detail?.id === annotationId && draft === null) return;
    if (cardDirty) {
      setShake((value) => value + 1);
      return;
    }
    setDraft(null);
    setDetailDirty(false);
    setAnchorBox(null);
    setDetail({ id: annotationId, scroll });
  }

  function selectAnnotation(annotation: Annotation) {
    openDetail(annotation.annotationId, true);
    if (pageKey(annotation.pageUrl) !== pageKey(liveRef.current.url)) navigate(annotation.pageUrl);
  }

  function editAnnotation(annotation: Annotation) {
    if (cardDirty && draft?.annotationId !== annotation.annotationId) {
      setShake((value) => value + 1);
      return;
    }
    if (pageKey(annotation.pageUrl) !== pageKey(liveRef.current.url)) navigate(annotation.pageUrl);
    setAnchorBox(null);
    setDetail(null);
    setDetailDirty(false);
    setDraft({
      key: crypto.randomUUID(),
      annotationId: annotation.annotationId,
      number: annotation.number,
      pick: null,
      title: annotationTitle(annotation.targets, annotation.region !== undefined),
      original: annotation.comment,
      comment: annotation.comment,
      images: [],
      existing: annotation.images,
      removed: [],
      saving: false,
      error: null,
    });
  }

  async function addDraftImages(blobs: Blob[]) {
    const prepared = (await Promise.all(blobs.map((blob) => prepareReferenceImage(blob).catch(() => null)))).filter((image): image is NonNullable<typeof image> => image !== null);
    if (prepared.length === 0) {
      showToast({ body: "无法读取这张图片", type: "error" });
      return;
    }
    // One save is one Device frame: keep the new images of a draft within the upload budget, refusing
    // the image that would cross it (the store refuses an oversized save again before sending).
    let used = (draftRef.current?.images ?? []).reduce((total, image) => total + image.data.byteLength, 0);
    const accepted = prepared.filter((image) => {
      if (used + image.data.byteLength > MAX_ANNOTATION_UPLOAD_BYTES) return false;
      used += image.data.byteLength;
      return true;
    });
    if (accepted.length < prepared.length) showToast({ body: `${ANNOTATION_UPLOAD_TOO_LARGE}（这张没有附加）`, type: "error" });
    if (accepted.length === 0) return;
    setDraft((current) => (current ? { ...current, images: [...current.images, ...accepted], error: null } : current));
  }

  async function saveDraft() {
    const current = draft;
    if (!current || current.saving || !current.comment.trim()) return;
    setDraft({ ...current, saving: true, error: null });
    const pick = current.pick;
    const put = create(AnnotationPutSchema, {
      annotation: current.annotationId
        ? { annotationId: current.annotationId, comment: current.comment.trim() }
        : {
            comment: current.comment.trim(),
            pageUrl: pick?.url ?? liveRef.current.url,
            pageTitle: pick?.title ?? liveRef.current.title,
            targets: (pick?.targets ?? []).map((target) => ({ element: { ...target.element }, source: target.source ? { ...target.source } : undefined })),
            region: pick?.region ? { ...pick.region } : undefined,
          },
      addImages: current.images.map((image) => ({
        kind: image.kind === "screenshot" ? AnnotationImageKind.SCREENSHOT : AnnotationImageKind.REFERENCE,
        mimeType: image.mimeType,
        data: image.data,
      })),
      removeImageIds: current.removed,
    });
    const result = await annotationsModel.change(workspaceId, { kind: "put", put });
    if (result.ok) {
      if (draftRef.current?.key === current.key) closeCard();
      return;
    }
    // The card keeps its input: saving again retries.
    setDraft((latest) => (latest?.key === current.key ? { ...latest, saving: false, error: annotationFailureText(result, "保存") } : latest));
  }

  /** Deletes a pending annotation, or confirms a resolved one; both can be undone for a while. */
  async function removeAnnotation(annotation: Annotation, confirming: boolean) {
    const id = annotation.annotationId;
    setDetail((current) => (current?.id === id ? null : current));
    setDetailDirty(false);
    const result = await annotationsModel.change(workspaceId, { kind: "delete", annotationIds: [id] });
    if (!result.ok) {
      showToast({ body: annotationFailureText(result, confirming ? "确认" : "删除"), type: "error" });
      return;
    }
    offerUndo(confirming ? `已确认批注 #${annotation.number}` : `已删除批注 #${annotation.number}`, result.removedIds);
  }

  async function reopenAnnotation(annotation: Annotation, comment: string): Promise<boolean> {
    const result = await annotationsModel.change(workspaceId, { kind: "reopen", annotationId: annotation.annotationId, comment });
    if (!result.ok) showToast({ body: annotationFailureText(result, "重新打开"), type: "error" });
    return result.ok;
  }

  /** 「清除全部已完成」: the resolved page annotations, by id — the worker's clear-resolved would
   * also remove resolved code comments. */
  async function clearResolved() {
    const annotationIds = (annotations ?? []).filter(isResolved).map((annotation) => annotation.annotationId);
    if (annotationIds.length === 0) return;
    const result = await annotationsModel.change(workspaceId, { kind: "delete", annotationIds });
    if (!result.ok) {
      showToast({ body: annotationFailureText(result, "清除"), type: "error" });
      return;
    }
    offerUndo(`已清除 ${result.removedIds.length} 条已完成的批注`, result.removedIds);
  }

  function copyAnnotationsMarkdown() {
    if (!annotations || annotations.length === 0) return;
    const workspace = workspaces.find((item) => item.id === workspaceId);
    const label = `${workspace?.name ? `${workspace.name} ` : ""}(${entityHandle("workspace", workspaceId)})`;
    desktop.writeClipboard(annotationsMarkdown(annotations, label));
    showToast({ body: "已把批注复制为 markdown", type: "info" });
  }

  async function handOff(taskId: string) {
    const terminal = agentTerminals(tasks, sessionAgents, workspaceId).find((item) => item.taskId === taskId);
    const result = await client.handOffAnnotations(workspaceId, taskId, HAND_OFF_INSTRUCTION);
    if (result.ok) {
      showToast({ body: `已交给「${terminal?.title || "终端"}」里的 ${terminal?.agent ?? "agent"}`, type: "info" });
      return;
    }
    if (result.held) showToast({ body: "这个终端正被另一台设备使用，没有输入。在那台设备上操作，或换一个终端。", type: "error" });
    else showToast({ body: annotationFailureText(result, "交给 agent "), type: "error" });
  }

  /** The icon segment and ⌘⇧D (in the page or the tab chrome). Entering never opens the panel. */
  function toggleAnnotating() {
    if (annotating) {
      setAnnotating(false);
      return;
    }
    if (annotateDisabledReason !== null) {
      showToast({ body: annotateDisabledReason, type: "info" });
      return;
    }
    setAnnotating(true);
    // The page must hold focus for ↑↓, ⇧ and Esc to reach the page script.
    focusPage();
  }

  /** Esc from the page: a card closes first, then annotate mode ends. */
  function onAnnotatorEscape() {
    if (cardOpen) closeCard();
    else setAnnotating(false);
  }

  // Handlers registered once per mount read the current values through this mirror.
  const liveRef = useRef({ url, title, mode, failure, visible, editing });
  useEffect(() => {
    liveRef.current = { url, title, mode, failure, visible, editing };
  });

  // Read from the webview's event handlers at the moment the event fires.
  const currentMode = useEffectEvent((): DesktopBrowserMode | null => runtime.modeOf(scope) ?? liveRef.current.mode);

  /** Loads a URL the address bar, a suggestion, a port or a retry resolved — always through main. */
  function navigate(target: string) {
    setFailure(null);
    setEditing(false);
    setHighlight(-1);
    const nextUrl = target === "about:blank" ? "" : target;
    runtime.updateTab(tabId, nextUrl === liveRef.current.url ? { url: nextUrl } : { url: nextUrl, title: "", favicon: null });
    const guest = guestIdRef.current;
    if (guest === null) {
      pendingUrlRef.current = target;
      return;
    }
    desktop.browserNavigate(guest, target);
  }

  function focusAddress() {
    const input = addressRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }

  function focusPage() {
    const live = liveRef.current;
    if (live.url === "" || live.failure) {
      focusAddress();
      return;
    }
    const element = webviewRef.current;
    if (!element || guestIdRef.current === null) {
      // Asked before the guest attached (a tab that was just opened or restored): focus it on attach.
      wantFocusRef.current = true;
      return;
    }
    element.focus();
  }

  function retry() {
    const target = failure?.url ?? url;
    if (target) navigate(target);
  }

  function reload() {
    if (failure) {
      retry();
      return;
    }
    const guest = guestIdRef.current;
    if (guest !== null && url) desktop.browserCommand(guest, "reload");
  }

  function toggleDevTools() {
    if (guestIdRef.current === null) return;
    setDevtoolsOpen((open) => !open);
  }

  // Keeps the latest closures reachable from handlers registered once.
  const actionsRef = useRef({
    navigate,
    focusAddress,
    focusPage,
    reload,
    toggleDevTools,
    retry,
    onAnnotatorPick,
    openDetail,
    onAnnotatorEscape,
    clickedOutsideCard,
    toggleAnnotating,
  });
  useEffect(() => {
    actionsRef.current = {
      navigate,
      focusAddress,
      focusPage,
      reload,
      toggleDevTools,
      retry,
      onAnnotatorPick,
      openDetail,
      onAnnotatorEscape,
      clickedOutsideCard,
      toggleAnnotating,
    };
  });

  // The page's annotate mode, pins and anchor, pushed to main whenever they change (main re-applies
  // them after every navigation of the guest).
  useEffect(() => {
    if (guestId === null) return;
    desktop.browserAnnotatorSync(guestId, JSON.parse(annotatorKey) as DesktopAnnotatorState);
  }, [guestId, annotatorKey]);

  // A detail card whose annotation is gone (deleted or confirmed, here or elsewhere) closes; a later
  // 「撤销」 does not bring the card back. Adjusted during render.
  if (detail && annotations && !annotations.some((annotation) => annotation.annotationId === detail.id)) {
    setDetail(null);
    setDetailDirty(false);
  }

  // The page area's size, for placing the comment card over the element (page CSS pixels scale onto it).
  useEffect(() => {
    const region = pageRef.current;
    if (!region) return;
    const observer = new ResizeObserver(() => {
      const box = region.getBoundingClientRect();
      setPageSize((current) => (current.width === box.width && current.height === box.height ? current : { width: box.width, height: box.height }));
    });
    observer.observe(region);
    return () => observer.disconnect();
  }, []);

  // 1. Prepare the scope's partition (main decides local vs remote from the local daemon id).
  useEffect(() => {
    let cancelled = false;
    runtime.prepare(scope, daemonId).then(
      (result) => {
        if (cancelled) return;
        setPrepared(result);
        setMode(runtime.modeOf(scope) ?? result.mode);
      },
      (error: unknown) => {
        if (!cancelled) setPrepareError(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [runtime, scope, daemonId]);

  // 2. Insert the webview only once the partition is prepared, then 3. navigate once it attached.
  useEffect(() => {
    const host = webviewHostRef.current;
    if (!prepared || !host) return;
    const element = createWebview(prepared.partition, { allowPopups: true });
    webviewRef.current = element;
    let attached = false;

    const on = (name: string, handler: (event: Event) => void) => element.addEventListener(name, handler);
    on("dom-ready", () => {
      if (attached) return;
      attached = true;
      let id: number;
      try {
        id = element.getWebContentsId();
      } catch {
        return;
      }
      guestIdRef.current = id;
      runtime.bindGuest(tabId, id);
      setGuestId(id);
      const initial = pendingUrlRef.current ?? runtime.tabs.getState().tabs[tabId]?.url ?? "";
      pendingUrlRef.current = null;
      if (initial) actionsRef.current.navigate(initial);
      if (wantFocusRef.current) {
        wantFocusRef.current = false;
        if (liveRef.current.visible) actionsRef.current.focusPage();
      }
    });
    on("did-start-loading", () => runtime.updateTab(tabId, { loading: true }));
    on("did-stop-loading", () => runtime.updateTab(tabId, { loading: false }));
    on("did-navigate", (event) => {
      const next = (event as Event & { url: string }).url;
      // The initial about:blank the guest attaches on is not a page of this tab.
      if (!next || next === "about:blank") return;
      setFailure(null);
      runtime.updateTab(tabId, next === liveRef.current.url ? { url: next } : { url: next, title: "", favicon: null });
      runtime.updateLibrary((current) => recordVisit(current, { url: next, title: "" }, Date.now()));
    });
    on("did-navigate-in-page", (event) => {
      const detail = event as Event & { url: string; isMainFrame: boolean };
      if (!detail.isMainFrame || !detail.url || detail.url === "about:blank") return;
      runtime.updateTab(tabId, { url: detail.url });
      runtime.updateLibrary((current) => recordVisit(current, { url: detail.url, title: liveRef.current.title }, Date.now()));
    });
    on("page-title-updated", (event) => {
      const next = (event as Event & { title: string }).title ?? "";
      const pageUrl = liveRef.current.url;
      runtime.updateTab(tabId, { title: next });
      if (pageUrl) runtime.updateLibrary((current) => updateHistoryTitle(current, pageUrl, next));
    });
    on("did-fail-load", (event) => {
      const detail = event as Event & { errorCode: number; errorDescription: string; validatedURL: string; isMainFrame: boolean };
      if (!detail.isMainFrame || detail.errorCode === NET_ERR_ABORTED) return;
      const failedUrl = detail.validatedURL || liveRef.current.url;
      if (!failedUrl || failedUrl === "about:blank") return;
      runtime.updateTab(tabId, { url: failedUrl, loading: false });
      if (isCertificateError(detail.errorCode)) {
        const host = hostLabel(failedUrl).replace(/:\d+$/, "").toLowerCase();
        setFailure({ kind: "certificate", url: failedUrl, host, certificate: null });
        const guest = guestIdRef.current;
        if (guest !== null) {
          void desktop.browserCertificate(guest, host).then((certificate) =>
            setFailure((current) => (current?.kind === "certificate" && current.url === failedUrl ? { ...current, certificate } : current)),
          );
        }
        return;
      }
      const fallback = loadFailure(failedUrl, detail.errorCode, detail.errorDescription);
      const guest = guestIdRef.current;
      if (currentMode() === "remote" && isLoopbackUrl(failedUrl) && guest !== null) {
        // The device tunnel failed in main, which remembers why. Asked here rather than pushed from
        // there: a push and this event travel different paths, and the generic page would win races.
        const settle = (reason: DesktopBrowserTunnelFailure | null) => {
          if (runtime.tabs.getState().tabs[tabId]?.url !== failedUrl) return;
          if (reason) setFailure({ kind: "tunnel", url: failedUrl, reason });
          // Refused before reaching the tunnel (main's fallback block): the device is not reachable.
          else if (detail.errorCode === NET_ERR_BLOCKED_BY_CLIENT) setFailure({ kind: "tunnel", url: failedUrl, reason: "offline" });
          else setFailure(fallback);
        };
        void desktop.browserTunnelFailure(guest, failedUrl).then(settle, () => settle(null));
        return;
      }
      setFailure(fallback);
    });
    on("render-process-gone", () => {
      runtime.updateTab(tabId, { loading: false });
      setFailure({ kind: "crashed", url: liveRef.current.url });
    });

    host.appendChild(element);
    return () => {
      element.remove();
      webviewRef.current = null;
      guestIdRef.current = null;
      runtime.unbindGuest(tabId);
      setGuestId(null);
    };
  }, [prepared, runtime, tabId]);

  // Main-process events about this tab, and the hooks the Workbench drives it through.
  useEffect(
    () =>
      runtime.register(tabId, scope, {
        onEvent: (event: DesktopBrowserEvent) => {
          switch (event.kind) {
            case "key":
              if (event.action === "focus-address") actionsRef.current.focusAddress();
              else if (event.action === "toggle-annotate") actionsRef.current.toggleAnnotating();
              else actionsRef.current.toggleDevTools();
              return;
            case "favicon":
              if (event.pageUrl === liveRef.current.url || !event.pageUrl) runtime.updateTab(tabId, { favicon: event.dataUrl });
              return;
            case "history":
              setHistory({ canGoBack: event.canGoBack, canGoForward: event.canGoForward, zoomFactor: event.zoomFactor });
              return;
            case "devtools-closed":
              setDevtoolsOpen(false);
              return;
            case "mode":
              setMode(event.mode);
              // `localhost` changed meaning: a loopback page that failed for the old one may load now.
              if (liveRef.current.failure?.kind === "tunnel") actionsRef.current.retry();
              return;
            case "annotator-pick":
              actionsRef.current.onAnnotatorPick(event.pick);
              return;
            case "annotator-anchor":
              setAnchorBox({ rect: event.rect, viewport: event.viewport });
              return;
            case "annotator-pin-click":
              actionsRef.current.openDetail(event.annotationId, false);
              return;
            case "annotator-pins":
              setMissing({ url: event.url, ids: new Set(event.missing) });
              return;
            case "annotator-escape":
              actionsRef.current.onAnnotatorEscape();
              return;
            case "annotator-outside-click":
              actionsRef.current.clickedOutsideCard();
              return;
            case "annotator-status":
              setAnnotatorAvailable(event.available);
              return;
            default:
              return;
          }
        },
        focus: () => actionsRef.current.focusPage(),
        reload: () => actionsRef.current.reload(),
      }),
    [runtime, tabId, scope],
  );

  // Docked DevTools: a second webview as the DevTools host, still on its initial about:blank when
  // main points the page's DevTools at it. Closing tears the host down; the next open gets a new one.
  useEffect(() => {
    const host = devtoolsHostRef.current;
    const page = guestId;
    if (!devtoolsOpen || !host || page === null) return;
    const element = createWebview(BROWSER_DEVTOOLS_PARTITION, { allowPopups: false });
    let opened = false;
    element.addEventListener("dom-ready", () => {
      if (opened) return;
      opened = true;
      let hostId: number;
      try {
        hostId = element.getWebContentsId();
      } catch {
        setDevtoolsOpen(false);
        return;
      }
      void desktop.browserOpenDevTools(page, hostId).then((ok) => {
        if (!ok) setDevtoolsOpen(false);
      });
    });
    host.appendChild(element);
    return () => {
      desktop.browserCloseDevTools(page);
      element.remove();
    };
  }, [devtoolsOpen, guestId]);

  function cancelRegion() {
    const guest = guestIdRef.current;
    if (guest !== null) desktop.browserReleaseFreeze(guest);
    setFrozenFrame(null);
    setSelection(null);
    selectionStartRef.current = null;
  }

  // 框选截图: Escape leaves the frozen frame without capturing.
  const cancelRegionOnEscape = useEffectEvent(() => cancelRegion());
  useEffect(() => {
    if (!frozenFrame) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancelRegionOnEscape();
    }
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [frozenFrame]);

  // A tab that leaves the screen leaves annotate mode (a card being written stays), and drops an
  // unfinished region capture (what cancelRegion does). The state is adjusted during render when
  // `visible` flips; releasing the freeze in main runs in an effect.
  const [syncedVisible, setSyncedVisible] = useState<boolean | null>(null);
  const [releaseFreezeOnHide, setReleaseFreezeOnHide] = useState(false);
  if (visible !== syncedVisible) {
    setSyncedVisible(visible);
    if (!visible) setAnnotating(false);
    if (visible) setReleaseFreezeOnHide(false);
    else if (frozenFrame) {
      setFrozenFrame(null);
      setSelection(null);
      setReleaseFreezeOnHide(true);
    }
  }
  const releaseHiddenFreeze = useEffectEvent(() => {
    const guest = guestIdRef.current;
    if (guest !== null) desktop.browserReleaseFreeze(guest);
    selectionStartRef.current = null;
  });
  useEffect(() => {
    if (releaseFreezeOnHide) releaseHiddenFreeze();
  }, [releaseFreezeOnHide]);

  // A blank new tab starts in its address bar (checked once, as the view mounts).
  const focusBlankAddress = useEffectEvent(() => {
    if (blank && entry.focused && visible) focusAddress();
  });
  useEffect(() => {
    focusBlankAddress();
  }, []);

  async function captureVisible() {
    const guest = guestIdRef.current;
    if (guest === null) return;
    const ok = await desktop.browserCaptureVisible(guest).catch(() => false);
    showToast(ok ? { body: "已把可见区域的截图复制到剪贴板", type: "info" } : { body: "截图失败", type: "error" });
  }

  async function startRegionCapture() {
    const guest = guestIdRef.current;
    if (guest === null) return;
    const frame = await desktop.browserFreeze(guest).catch(() => null);
    if (!frame) {
      showToast({ body: "截图失败", type: "error" });
      return;
    }
    setSelection(null);
    setFrozenFrame(frame);
  }

  function regionPoint(event: ReactPointerEvent<HTMLDivElement>): { x: number; y: number } {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width))),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / Math.max(1, rect.height))),
    };
  }

  function finishRegion(event: ReactPointerEvent<HTMLDivElement>) {
    const start = selectionStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    selectionStartRef.current = null;
    const end = regionPoint(event);
    const rect = {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
    };
    const box = event.currentTarget.getBoundingClientRect();
    // A click, not a drag: keep the frozen frame and let the user drag again.
    if (rect.width * box.width < 4 || rect.height * box.height < 4) {
      setSelection(null);
      return;
    }
    const guest = guestIdRef.current;
    setFrozenFrame(null);
    setSelection(null);
    if (guest === null) return;
    void desktop.browserCaptureRegion(guest, rect).then(
      (ok) => showToast(ok ? { body: "已把框选区域的截图复制到剪贴板", type: "info" } : { body: "截图失败", type: "error" }),
      () => showToast({ body: "截图失败", type: "error" }),
    );
  }

  function copyUrl() {
    if (!url) return;
    desktop.writeClipboard(url);
    showToast({ body: "已复制网址", type: "info" });
  }

  function clearData(target: "cookies" | "cache" | "certificates") {
    const labels = { cookies: "Cookies", cache: "缓存", certificates: "已信任的证书" } as const;
    // The tab's scope: clearing from one worktree clears the project's state for all of them.
    const owner = scope.kind === "project" ? "这个项目" : "这台设备";
    void desktop.browserClearData(scope, target).then(
      (ok) => showToast(ok ? { body: `已清除${owner}的${labels[target]}`, type: "info" } : { body: `清除${labels[target]}失败`, type: "error" }),
      () => showToast({ body: `清除${labels[target]}失败`, type: "error" }),
    );
  }

  function zoomCommand(command: "zoom-in" | "zoom-out" | "zoom-reset") {
    const guest = guestIdRef.current;
    if (guest !== null) desktop.browserCommand(guest, command);
  }

  async function trustAndRetry(current: Extract<Failure, { kind: "certificate" }>) {
    const guest = guestIdRef.current;
    if (guest === null) return;
    setTrusting(true);
    const ok = await desktop.browserTrustCertificate(guest, current.host).catch(() => false);
    setTrusting(false);
    if (!ok) {
      showToast({ body: "信任证书失败，请重试加载后再试", type: "error" });
      return;
    }
    navigate(current.url);
  }

  // Address bar suggestions: only while the user is editing what is there.
  const suggestions: BrowserSuggestion[] = editing && addressText.trim() && addressText !== displayUrl(url) ? rankSuggestions(library, addressText, typedAt, 8) : [];

  function submitAddress() {
    const picked = highlight >= 0 ? suggestions[highlight] : undefined;
    if (picked) {
      navigate(picked.url);
    } else {
      const resolved = resolveAddressInput(addressText);
      if (!resolved) return;
      navigate(resolved.url);
    }
    // The page takes the caret once there is one to take.
    requestAnimationFrame(() => webviewRef.current?.focus());
  }

  function onAddressKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    // Enter and Escape belong to the input method while it is composing (Chinese input above all).
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" && suggestions.length > 0) {
      event.preventDefault();
      setHighlight((index) => (index + 1 >= suggestions.length ? 0 : index + 1));
      return;
    }
    if (event.key === "ArrowUp" && suggestions.length > 0) {
      event.preventDefault();
      setHighlight((index) => (index <= 0 ? suggestions.length - 1 : index - 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      submitAddress();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setEditing(false);
      setHighlight(-1);
      setAddressText(displayUrl(url));
      if (url && !failure) webviewRef.current?.focus();
    }
  }

  // ⌘L, ⌥⌘I and ⌘⇧D while the caret is in the tab's own chrome (inside the page, main forwards them).
  function onViewKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && !event.nativeEvent.isComposing) {
      // A card handles Esc itself while the caret is in it.
      const inCard = event.target instanceof Node && cardRef.current?.contains(event.target);
      if (cardOpen && !inCard) {
        event.preventDefault();
        closeCard();
        return;
      }
      if (!cardOpen && annotating) {
        event.preventDefault();
        setAnnotating(false);
        return;
      }
    }
    if (!event.metaKey || event.ctrlKey) return;
    if (event.code === "KeyD" && event.shiftKey && !event.altKey) {
      event.preventDefault();
      toggleAnnotating();
      return;
    }
    if (event.code === "KeyL" && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      focusAddress();
      return;
    }
    if (event.code === "KeyI" && event.altKey && !event.shiftKey) {
      event.preventDefault();
      toggleDevTools();
    }
  }

  const workspacePorts = listForwardedPorts(tasks, ports, workspaceId);
  const zoomPercent = Math.round(history.zoomFactor * 100);
  const addressValue = editing ? addressText : displayUrl(url);
  const isRemote = mode === "remote";

  return (
    <div
      ref={rootRef}
      className={cn("absolute isolate flex flex-col bg-terminal", visible ? "pointer-events-auto" : "invisible")}
      style={entry.frame}
      aria-hidden={!visible}
      onPointerDownCapture={(event) => {
        onPointerFocus(tabId);
        // A press in the tab's own chrome while a card is open counts as a click elsewhere (clicks in
        // the page arrive from the page script). Menus and tooltips are popovers: not elsewhere.
        const target = event.target instanceof Element ? event.target : null;
        if (cardOpen && target && !cardRef.current?.contains(target) && !target.closest("[popover]")) clickedOutsideCard();
      }}
      onKeyDownCapture={onViewKeyDown}
    >
      {/* Toolbar: ← → ⟳, the address bar with ☆ and suggestions, Console, ⋯ (Cursor 3.20's layout). */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-background px-2">
        <ToolbarButton label="返回" disabled={!history.canGoBack || guestId === null} onClick={() => guestId !== null && desktop.browserCommand(guestId, "back")}>
          <ArrowLeft className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton label="前进" disabled={!history.canGoForward || guestId === null} onClick={() => guestId !== null && desktop.browserCommand(guestId, "forward")}>
          <ArrowRight className="size-3.5" />
        </ToolbarButton>
        {loading ? (
          <ToolbarButton label="停止加载" onClick={() => guestId !== null && desktop.browserCommand(guestId, "stop")}>
            <X className="size-3.5" />
          </ToolbarButton>
        ) : (
          <ToolbarButton label={`重新加载 ${SHORTCUT_MODIFIER_PREFIX}R`} disabled={!url} onClick={reload}>
            <RotateCw className="size-3.5" />
          </ToolbarButton>
        )}
        <div className="relative mx-1 min-w-0 flex-1">
          <input
            ref={addressRef}
            value={addressValue}
            placeholder="输入网址或搜索"
            aria-label="地址栏"
            spellCheck={false}
            autoComplete="off"
            className="h-6 w-full rounded-md bg-muted/60 px-2.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:bg-background"
            onFocus={(event) => {
              setAddressText(displayUrl(url));
              setTypedAt(Date.now());
              setEditing(true);
              setHighlight(-1);
              const input = event.currentTarget;
              requestAnimationFrame(() => input.select());
            }}
            onBlur={() => {
              setEditing(false);
              setHighlight(-1);
            }}
            onChange={(event) => {
              setAddressText(event.target.value);
              setTypedAt(Date.now());
              setEditing(true);
              setHighlight(-1);
            }}
            onKeyDown={onAddressKeyDown}
          />
          {suggestions.length > 0 ? (
            <div role="listbox" aria-label="地址建议" className="absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-md border border-border bg-popover py-1 shadow-lg">
              {suggestions.map((suggestion, index) => (
                <button
                  key={suggestion.url}
                  type="button"
                  role="option"
                  aria-selected={index === highlight}
                  className={cn(
                    "flex w-full min-w-0 items-center gap-2 px-2.5 py-1 text-left text-sm",
                    index === highlight ? "bg-accent text-foreground" : "text-secondary-foreground hover:bg-accent/60",
                  )}
                  // Keep the caret in the address bar: a blur would close the list before the click lands.
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => {
                    navigate(suggestion.url);
                    requestAnimationFrame(() => webviewRef.current?.focus());
                  }}
                >
                  <History className="size-3 shrink-0 opacity-60" />
                  <span className="min-w-0 max-w-[50%] shrink truncate text-foreground">{suggestion.title || hostLabel(suggestion.url)}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{displayUrl(suggestion.url)}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <AnnotateButton
          active={annotating && annotateDisabledReason === null}
          count={annotationCount(annotationSummary, annotations)}
          disabledReason={guestId === null ? "打开网页后才能批注" : annotateDisabledReason}
          panelOpen={panelOpen}
          onToggleMode={toggleAnnotating}
          onTogglePanel={() => setPanelOpen((open) => !open)}
        />
        <ToolbarButton label="控制台 ⌥⌘I" pressed={devtoolsOpen} disabled={guestId === null} onClick={toggleDevTools}>
          <SquareCode className="size-3.5" />
        </ToolbarButton>
        <DropdownMenu
          isMenuOpen={menuOpen}
          onOpenChange={setMenuOpen}
          menuWidth={240}
          hasChevron={false}
          placement="below"
          alignment="end"
          button={{
            ref: moreAnchorRef,
            label: "更多",
            icon: <Ellipsis className="size-3.5" />,
            isIconOnly: true,
            variant: "ghost",
            size: "sm",
            style: { color: "var(--muted-foreground)", height: 24, width: 24, minWidth: 24, paddingInline: 0 },
          }}
        >
          <DropdownMenuItem icon={<Camera className="size-3.5" />} label="截取可见区域" isDisabled={!url || guestId === null} onClick={() => void captureVisible()} />
          <DropdownMenuItem icon={<Crop className="size-3.5" />} label="框选截图" isDisabled={!url || guestId === null} onClick={() => void startRegionCapture()} />
          <DropdownMenuDivider />
          <DropdownMenuItem icon={<Copy className="size-3.5" />} label="复制当前网址" isDisabled={!url} onClick={copyUrl} />
          <DropdownMenuItem
            icon={<ExternalLink className="size-3.5" />}
            label="在系统浏览器中打开"
            isDisabled={!isWebUrl(url)}
            onClick={() => window.open(url, "_blank", "noopener")}
          />
          <DropdownMenuItem
            icon={<RefreshCw className="size-3.5" />}
            label="硬刷新（清除缓存）"
            isDisabled={!url || guestId === null}
            onClick={() => guestId !== null && desktop.browserCommand(guestId, "hard-reload")}
          />
          <DropdownMenuDivider />
          {/* Zoom row: − 100% +, the percentage following the page's actual zoom. */}
          <div className="flex items-center justify-between gap-2 px-2 py-1 text-sm">
            <span className="text-secondary-foreground">缩放</span>
            <span className="flex items-center gap-1">
              <button
                type="button"
                aria-label="缩小"
                className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => zoomCommand("zoom-out")}
              >
                <Minus className="size-3.5" />
              </button>
              <button
                type="button"
                aria-label="恢复 100%"
                className="min-w-12 rounded-md px-1 text-center text-sm tabular-nums text-foreground hover:bg-accent"
                onClick={() => zoomCommand("zoom-reset")}
              >
                {zoomPercent}%
              </button>
              <button
                type="button"
                aria-label="放大"
                className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => zoomCommand("zoom-in")}
              >
                <Plus className="size-3.5" />
              </button>
            </span>
          </div>
          <DropdownMenuDivider />
          <DropdownMenuItem
            icon={<History className="size-3.5" />}
            label="清除浏览历史"
            onClick={() => {
              runtime.updateLibrary(clearHistory);
              showToast({ body: "已清除浏览历史", type: "info" });
            }}
          />
          <DropdownMenuItem icon={<Cookie className="size-3.5" />} label="清除 Cookies" onClick={() => clearData("cookies")} />
          <DropdownMenuItem icon={<Trash2 className="size-3.5" />} label="清除缓存" onClick={() => clearData("cache")} />
          <DropdownMenuItem icon={<ShieldAlert className="size-3.5" />} label="清除已信任的证书" onClick={() => clearData("certificates")} />
        </DropdownMenu>
        {/* Sibling tooltip after the menu, never button.tooltip (docs/design-guidelines.md). */}
        <Tooltip anchorRef={moreAnchorRef} isOpen={menuOpen ? false : undefined} content="更多" />
      </div>

      {/* Page area. The webview host has no React children, so React never touches the element
          inserted into it; the overlays are its later siblings and draw over the page. */}
      <div className="flex min-h-0 flex-1">
      <div ref={pageRef} className="relative min-w-0 flex-1">
        <div ref={webviewHostRef} className="absolute inset-0" />

        {blank ? (
          // A blank new tab: the address bar is focused; the workspace's forwarded ports and recent pages are one click away.
          <NewTabPage ports={workspacePorts} recent={library.history.slice(0, NEW_TAB_RECENT_COUNT)} isRemote={isRemote} onOpen={navigate} />
        ) : null}

        {failure ? <FailurePage failure={failure} scopeKind={scope.kind} trusting={trusting} onRetry={retry} onTrust={trustAndRetry} /> : null}

        {prepareError && !prepared ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-terminal px-6">
            <p className="max-w-sm text-center text-sm leading-5 text-destructive">无法准备浏览器：{prepareError}</p>
          </div>
        ) : null}

        {frozenFrame ? (
          // 框选截图: the page's frame frozen under a crosshair; drag a rectangle, Esc cancels.
          <div
            className="absolute inset-0 z-20 cursor-crosshair select-none touch-none"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              const point = regionPoint(event);
              selectionStartRef.current = { pointerId: event.pointerId, ...point };
              setSelection({ x0: point.x, y0: point.y, x1: point.x, y1: point.y });
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const start = selectionStartRef.current;
              if (!start || start.pointerId !== event.pointerId) return;
              const point = regionPoint(event);
              setSelection({ x0: start.x, y0: start.y, x1: point.x, y1: point.y });
            }}
            onPointerUp={finishRegion}
            onPointerCancel={() => {
              selectionStartRef.current = null;
              setSelection(null);
            }}
          >
            <img src={frozenFrame} alt="" draggable={false} className="pointer-events-none absolute inset-0 h-full w-full" />
            <div className="pointer-events-none absolute inset-0 bg-black/30" />
            {selection ? (
              <div
                className="pointer-events-none absolute border border-primary bg-primary/10"
                style={{
                  left: `${Math.min(selection.x0, selection.x1) * 100}%`,
                  top: `${Math.min(selection.y0, selection.y1) * 100}%`,
                  width: `${Math.abs(selection.x1 - selection.x0) * 100}%`,
                  height: `${Math.abs(selection.y1 - selection.y0) * 100}%`,
                }}
              />
            ) : null}
            <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-md border border-border bg-background/95 px-2.5 py-1 text-sm text-muted-foreground shadow">
              拖动框选区域，截图会复制到剪贴板 · Esc 取消
            </div>
          </div>
        ) : null}

        {annotatorState.mode ? <AnnotationHint /> : null}

        {draft ? (
          <AnnotationCard
            key={draft.key}
            cardRef={cardRef}
            draft={draft}
            anchor={cardAnchor}
            area={pageSize}
            shake={shake}
            readOnly={annotationsReadOnly}
            imageUrl={annotationImageUrl}
            onChange={(patch) => setDraft((current) => (current ? { ...current, ...patch } : current))}
            onAddImages={(blobs) => void addDraftImages(blobs)}
            onSave={() => void saveDraft()}
            onClose={closeCard}
          />
        ) : detailAnnotation ? (
          <AnnotationDetailCard
            key={detailAnnotation.annotationId}
            cardRef={cardRef}
            annotation={detailAnnotation}
            title={annotationTitle(detailAnnotation.targets, detailAnnotation.region !== undefined)}
            anchor={cardAnchor}
            area={pageSize}
            shake={shake}
            missing={pageMissing.has(detailAnnotation.annotationId)}
            readOnly={annotationsReadOnly}
            imageUrl={annotationImageUrl}
            onDirtyChange={setDetailDirty}
            onEdit={() => editAnnotation(detailAnnotation)}
            onDelete={() => void removeAnnotation(detailAnnotation, false)}
            onConfirm={() => void removeAnnotation(detailAnnotation, true)}
            onReopen={async (comment) => {
              const ok = await reopenAnnotation(detailAnnotation, comment);
              if (ok) closeCard();
              return ok;
            }}
            onClose={closeCard}
          />
        ) : null}
      </div>

      {panelOpen ? (
        <AnnotationsPanel
          entry={panelEntry}
          currentUrl={isWebUrl(url) ? url : ""}
          missing={pageMissing}
          notice={annotationNotice}
          selectedId={detailAnnotation?.annotationId ?? draft?.annotationId ?? null}
          agents={agentTerminals(tasks, sessionAgents, workspaceId)}
          onClose={() => {
            setPanelOpen(false);
            setHoveredId(null);
          }}
          onRetry={() => void annotationsModel.refresh(workspaceId)}
          onSelect={selectAnnotation}
          onHover={setHoveredId}
          onEdit={editAnnotation}
          onDelete={(annotation) => void removeAnnotation(annotation, false)}
          onConfirm={(annotation) => void removeAnnotation(annotation, true)}
          onReopen={reopenAnnotation}
          onClearResolved={() => void clearResolved()}
          onCopyMarkdown={copyAnnotationsMarkdown}
          onHandOff={(taskId) => void handOff(taskId)}
        />
      ) : null}
      </div>

      {devtoolsOpen ? (
        // Docked DevTools, below the page (Cursor's default). Its own host node, a later sibling of
        // the page area: opening and closing it never moves the page's webview.
        <div className="relative h-[40%] min-h-24 shrink-0 border-t border-border bg-background">
          <div ref={devtoolsHostRef} className="absolute inset-0" />
          <Tooltip content="关闭控制台 ⌥⌘I" placement="start">
            <button
              type="button"
              aria-label="关闭控制台"
              className="absolute right-1 top-1 z-10 flex size-5 items-center justify-center rounded bg-background/80 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => setDevtoolsOpen(false)}
            >
              <X className="size-3" />
            </button>
          </Tooltip>
        </div>
      ) : null}
    </div>
  );
}

const NEW_TAB_RECENT_COUNT = 5;

/**
 * A blank tab's page. Quiet by design (Cursor's new tab is empty): the tab strip already says what it
 * is and the focused address bar says what to type, so it only lists what is one click away.
 */
function NewTabPage({
  ports,
  recent,
  isRemote,
  onOpen,
}: {
  ports: readonly ForwardedPort[];
  recent: readonly HistoryEntry[];
  isRemote: boolean;
  onOpen: (url: string) => void;
}) {
  const remoteNote = isRemote ? "这个工作区在另一台设备上，localhost 指向那台设备。" : null;

  if (ports.length === 0 && recent.length === 0) {
    return (
      <div className="absolute inset-0 z-10 flex items-center justify-center bg-terminal px-6">
        <div className="flex max-w-sm flex-col items-center text-center">
          <Globe className="size-6 text-muted-foreground/50" strokeWidth={1.5} />
          <p className="mt-3 text-sm text-muted-foreground">输入网址、端口号或搜索内容</p>
          {remoteNote ? <p className="mt-1 text-sm text-muted-foreground/70">{remoteNote}</p> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 z-10 overflow-y-auto bg-terminal px-6">
      <div className="mx-auto flex w-full max-w-md flex-col gap-5 pb-10 pt-[12vh]">
        {ports.length > 0 ? (
          <NewTabSection label="转发中的端口">
            {ports.map((preview) => (
              <NewTabRow
                key={preview.url}
                icon={<AppWindow className="size-3.5" />}
                primary={<span className="tabular-nums">localhost:{preview.port}</span>}
                secondary={preview.titles.join("、")}
                onClick={() => onOpen(localPortUrl(preview.port))}
              />
            ))}
          </NewTabSection>
        ) : null}
        {recent.length > 0 ? (
          <NewTabSection label="最近访问">
            {recent.map((entry) => (
              <NewTabRow
                key={entry.url}
                icon={<History className="size-3.5" />}
                primary={entry.title || displayUrl(entry.url)}
                secondary={entry.title ? hostLabel(entry.url) : ""}
                onClick={() => onOpen(entry.url)}
              />
            ))}
          </NewTabSection>
        ) : null}
        {remoteNote ? <p className="px-2 text-sm text-muted-foreground/70">{remoteNote}</p> : null}
      </div>
    </div>
  );
}

function NewTabSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col">
      <h3 className="mb-1 px-2 text-sm font-medium text-muted-foreground">{label}</h3>
      {children}
    </section>
  );
}

function NewTabRow({ icon, primary, secondary, onClick }: { icon: ReactNode; primary: ReactNode; secondary: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="group flex h-8 min-w-0 items-center gap-2.5 rounded-md px-2 text-left transition-colors hover:bg-accent"
      onClick={onClick}
    >
      <span className="flex shrink-0 text-muted-foreground transition-colors group-hover:text-foreground">{icon}</span>
      <span className="min-w-0 truncate text-sm text-foreground">{primary}</span>
      {secondary ? <span className="ml-auto min-w-0 max-w-[55%] shrink-0 truncate pl-3 text-sm text-muted-foreground">{secondary}</span> : null}
    </button>
  );
}

function FailurePage({
  failure,
  scopeKind,
  trusting,
  onRetry,
  onTrust,
}: {
  failure: Failure;
  /** Who a trusted certificate is trusted for: the project (all its worktrees) or the device. */
  scopeKind: DesktopBrowserScope["kind"];
  trusting: boolean;
  onRetry: () => void;
  onTrust: (failure: Extract<Failure, { kind: "certificate" }>) => void;
}) {
  const host = hostLabel(failure.url);
  let icon = <WifiOff className="size-5" />;
  let heading = "无法打开此页面";
  let body = "";
  if (failure.kind === "refused") {
    const port = loopbackPortOf(failure.url);
    heading = `无法连接到 ${host}`;
    body = port !== null ? `这个工作区所在设备的 ${port} 端口上没有程序在监听。启动开发服务器后重试。` : "对方拒绝了连接。";
  } else if (failure.kind === "network") {
    body = `${failure.description || "网络错误"}（${failure.code}）`;
  } else if (failure.kind === "tunnel") {
    const port = loopbackPortOf(failure.url);
    if (failure.reason === "refused") {
      heading = `设备上的 localhost:${port ?? ""} 没有服务在监听`;
      body = "在这个工作区的终端里启动开发服务器后重试。";
    } else if (failure.reason === "unsupported") {
      icon = <Unplug className="size-5" />;
      heading = "该设备的 coflux 版本过旧";
      body = "更新后才能在内置浏览器中访问它的 localhost。";
    } else {
      icon = <Unplug className="size-5" />;
      heading = "设备离线或无法连接";
      body = "这个工作区所在的设备现在连不上。确认它在线后重试。";
    }
  } else if (failure.kind === "certificate") {
    icon = <ShieldAlert className="size-5" />;
    heading = "此站点的证书不受信任";
    body = `${failure.host} 出示的证书没有通过验证${failure.certificate?.error ? `（${failure.certificate.error}）` : ""}。只在确认这是你自己的开发服务器时才信任它；${scopeKind === "project" ? "信任对这个项目的所有工作区生效" : "信任只对这台设备生效"}。`;
  } else if (failure.kind === "crashed") {
    heading = "页面已崩溃";
    body = "重新加载即可恢复。";
  }
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center overflow-y-auto bg-terminal px-6">
      <div className="flex max-w-md flex-col items-center text-center">
        <div className="mb-4 flex size-10 items-center justify-center rounded-lg border border-border text-muted-foreground">{icon}</div>
        <h2 className="text-base font-medium text-foreground">{heading}</h2>
        <p className="mt-1.5 text-sm leading-5 text-muted-foreground">{body}</p>
        {failure.kind === "certificate" && failure.certificate ? (
          <dl className="mt-3 grid w-full grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border border-border px-3 py-2 text-left text-sm text-muted-foreground">
            <dt>颁发给</dt>
            <dd className="truncate text-foreground">{failure.certificate.subject || "—"}</dd>
            <dt>颁发者</dt>
            <dd className="truncate text-foreground">{failure.certificate.issuer || "—"}</dd>
            <dt>指纹</dt>
            <dd className="break-all font-mono text-foreground">{failure.certificate.fingerprint}</dd>
          </dl>
        ) : null}
        <p className="mt-2 max-w-full truncate font-mono text-sm text-muted-foreground">{failure.url}</p>
        <div className="mt-5 flex items-center gap-2">
          {failure.kind === "certificate" ? (
            <Button
              label="信任证书"
              variant="primary"
              size="sm"
              isLoading={trusting}
              isDisabled={!failure.certificate}
              onClick={() => onTrust(failure)}
            />
          ) : null}
          <Button label="重试" variant={failure.kind === "certificate" ? "secondary" : "primary"} size="sm" icon={<RotateCw />} onClick={onRetry} />
        </div>
      </div>
    </div>
  );
}

/** The tab strip chip's leading glyph: spinner while loading, the page's favicon, else a globe. */
export function BrowserTabGlyph({ favicon, loading, className }: { favicon: string | null; loading: boolean; className?: string }) {
  if (loading) return <LoaderCircle className={cn("size-3 shrink-0 animate-spin text-muted-foreground", className)} />;
  if (favicon) return <img src={favicon} alt="" draggable={false} className={cn("size-3 shrink-0 rounded-[2px] object-contain", className)} />;
  return <Globe className={cn("size-3 shrink-0", className)} />;
}
