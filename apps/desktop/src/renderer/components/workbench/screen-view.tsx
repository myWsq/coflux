import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type WheelEvent as ReactWheelEvent } from "react";
import { useStore } from "zustand";
import { Check, Cloud, Expand, LoaderCircle, Lock, Monitor, ShieldAlert, Shrink, Unplug, X, Zap } from "lucide-react";

import { Button } from "@astryxdesign/core/Button";
import { DropdownMenu, type DropdownMenuOption } from "@astryxdesign/core/DropdownMenu";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import type { CofluxClient } from "@coflux/client";
import { desktop, SCREEN_RESOLUTIONS_KEY } from "@/config";
import { cn } from "@/lib/utils";
import { DRAG_REGION_STYLE, NO_DRAG_REGION_STYLE } from "@/components/workbench/drag-region";
import {
  readScreenResolution,
  SCREEN_RESOLUTION_PRESETS,
  screenResolutionLabel,
  screenResolutionValue,
  writeScreenResolution,
  type ScreenResolution,
  type ScreenResolutionStore,
} from "@/components/workbench/screen-resolution";
import { modifierBits, type ScreenSession, type ScreenSessionState } from "@/components/workbench/screen-session";
import type { ScreenRuntime } from "@/components/workbench/screen-runtime";

/**
 * Remote screens' views (plan 20260929-remote-desktop; a standalone view per device since plan
 * 20261011-standalone-device-screen).
 *
 * The workbench holds one view per open screen in a layer over the whole main area, keeps hidden
 * ones mounted (their session stays paused on the remote, the virtual display in place) and never
 * re-keys a view; the one whose screen is the selection is visible. The picture is a canvas the
 * session draws decoded frames into. By default the remote display follows the view's size 1:1 in
 * points, so the canvas only scales transiently while a resize is in flight; on a fixed resolution
 * picked in the status bar (remembered per device) the picture is contained in the view and resizing
 * it only scales the picture.
 *
 * Keyboard: while the picture has focus every key goes to the remote — ⌘W, ⌘T, ⌘Q, ⌘1–9, ⌘C/V
 * included. The page-level shortcut listener yields (use-global-shortcuts.ts) and main switches
 * its accelerators off (`desktop.screenFocus`). Exactly one combination stays local: ⌃⌥⌘F toggles
 * immersive mode, and its keyup is swallowed with its keydown. Keys are sent by physical code.
 */

export type ScreenViewEntry = {
  daemonId: string;
  /** This screen is the workbench selection. */
  visible: boolean;
};

type ScreenViewsProps = {
  runtime: ScreenRuntime;
  client: CofluxClient;
  entries: readonly ScreenViewEntry[];
  /** The device whose screen is in immersive mode, if any: its view fills the window over everything else. */
  immersiveDaemonId: string | null;
  onToggleImmersive: (daemonId: string) => void;
  /** 断开: ends the remote session and closes the screen. */
  onDisconnect: (daemonId: string) => void;
  /** The picture took or lost keyboard focus. */
  onFocusChange: (daemonId: string, focused: boolean) => void;
  /** The action dock's measured width: the status bar keeps that much free on its right. */
  dockWidth: number;
  /** The left dock's space while the sidebar is collapsed, 0 otherwise: kept free on the status bar's left. */
  leftDockReserve: number;
};

/** As tall as the app's top bar (`h-9`). */
const STATUS_BAR_HEIGHT = 36;
/** The resolution choice per device, on this machine (screen-resolution.ts). */
const SCREEN_RESOLUTION_STORE: ScreenResolutionStore = { storage: localStorage, key: SCREEN_RESOLUTIONS_KEY };
/** The reserved combination: ⌃⌥⌘F toggles immersive mode and never reaches the remote. */
export function isImmersiveToggle(event: { code: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean }): boolean {
  return event.code === "KeyF" && event.ctrlKey && event.altKey && event.metaKey && !event.shiftKey;
}

/** One view per open screen, each filling the layer the workbench places them in. */
export function ScreenViews(props: ScreenViewsProps) {
  return (
    <>
      {props.entries.map((entry) => (
        <ScreenView key={entry.daemonId} entry={entry} {...props} />
      ))}
    </>
  );
}

function useSessionState(session: ScreenSession | null): ScreenSessionState | null {
  return useSyncExternalStore(
    (listener) => (session ? session.subscribe(listener) : () => undefined),
    () => (session ? session.state : null),
  );
}

/**
 * A device's open screen's live state, for readers outside its view (the sidebar's sub-row): null
 * until the view has created its session.
 */
export function useScreenSessionState(runtime: ScreenRuntime, daemonId: string): ScreenSessionState | null {
  const session = useSyncExternalStore(runtime.subscribeSessions, () => runtime.sessionOf(daemonId));
  return useSessionState(session);
}

function ScreenView({ entry, runtime, client, immersiveDaemonId, onToggleImmersive, onDisconnect, onFocusChange, dockWidth, leftDockReserve }: ScreenViewsProps & { entry: ScreenViewEntry }) {
  const { daemonId } = entry;
  const immersive = immersiveDaemonId === daemonId;
  const daemon = useStore(client.store, (state) => state.daemons.find((item) => item.daemonId === daemonId));
  const transport = useStore(client.store, (state) => state.deviceTransports[daemonId]);
  const deviceOnline = daemon?.online ?? false;
  // The session asks for these whenever it needs them; mirrored after every commit.
  const transportMode = transport?.mode ?? "idle";
  const deviceOnlineRef = useRef(deviceOnline);
  const transportModeRef = useRef(transportMode);
  useLayoutEffect(() => {
    deviceOnlineRef.current = deviceOnline;
    transportModeRef.current = transportMode;
  });
  const [session, setSession] = useState<ScreenSession | null>(null);
  const state = useSessionState(session);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pictureRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const swallowKeyUp = useRef(new Set<string>());
  const [hoverTop, setHoverTop] = useState(false);
  const [pictureFocused, setPictureFocused] = useState(false);
  const [resolutionMenuOpen, setResolutionMenuOpen] = useState(false);

  // The session lives as long as the view; disconnecting ends it (runtime.remove). It starts at the
  // device's remembered resolution.
  useEffect(() => {
    const created = runtime.sessionFor(daemonId, {
      deviceOnline: () => deviceOnlineRef.current,
      transportMode: () => transportModeRef.current,
      resolution: readScreenResolution(SCREEN_RESOLUTION_STORE, daemonId),
    });
    setSession(created);
    return () => runtime.release(daemonId);
  }, [runtime, daemonId]);

  useEffect(() => runtime.register(daemonId, { focus: () => pictureRef.current?.focus({ preventScroll: true }) }), [runtime, daemonId]);

  useEffect(() => {
    if (!session) return;
    session.attachCanvas(canvasRef.current);
    return () => session.attachCanvas(null);
  }, [session]);

  useEffect(() => {
    session?.setVisible(entry.visible);
  }, [session, entry.visible]);

  // A device that comes back online while the view waits: try again at once. Only the device coming
  // online triggers it; the rest is read as it is then.
  const retryIfWaiting = useEffectEvent(() => {
    if (session && entry.visible && (state?.phase === "offline" || state?.phase === "connecting")) session.retry();
  });
  useEffect(() => {
    if (deviceOnline) retryIfWaiting();
  }, [deviceOnline]);

  // The remote display follows the picture area's size, 1:1 in points, unless a fixed resolution is
  // chosen (the session then keeps the remote's size and only follows the local scale).
  useEffect(() => {
    const node = pictureRef.current;
    if (!node || !session) return;
    const report = () => {
      const rect = node.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) session.setSize(rect.width, rect.height, window.devicePixelRatio);
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(node);
    return () => observer.disconnect();
  }, [session, immersive]);

  useEffect(() => {
    if (session && immersive !== undefined) session.flushSize();
  }, [session, immersive]);

  // Focus handling: what the shortcut listener and main need to know. Losing focus releases every key
  // and button the remote still holds, so ⌘ before a ⌘Tab the local OS ate never sticks over there.
  function focusPicture(focused: boolean) {
    if (!focused) session?.releaseAll();
    setPictureFocused(focused);
    desktop.screenFocus(focused);
    onFocusChange(daemonId, focused);
  }
  useEffect(() => {
    if (!pictureFocused || !session) return;
    const release = () => session.releaseAll();
    window.addEventListener("blur", release);
    return () => window.removeEventListener("blur", release);
  }, [pictureFocused, session]);
  // A view that unmounts (its screen disconnected) while the picture has focus gets no blur: hand the
  // keyboard back to the page's shortcuts and main's menus here.
  const focusedRef = useRef(false);
  const onFocusChangeRef = useRef(onFocusChange);
  useLayoutEffect(() => {
    focusedRef.current = pictureFocused;
    onFocusChangeRef.current = onFocusChange;
  });
  useEffect(
    () => () => {
      if (!focusedRef.current) return;
      focusedRef.current = false;
      desktop.screenFocus(false);
      onFocusChangeRef.current(daemonId, false);
    },
    [daemonId],
  );
  // Hiding the view while the picture has focus gives the focus up: the state is adjusted during
  // render when `visible` flips, the rest (blur, releasing held input, telling main and the
  // workbench — what focusPicture(false) does) runs in an effect.
  const [syncedVisible, setSyncedVisible] = useState(entry.visible);
  const [releaseOnHide, setReleaseOnHide] = useState(false);
  if (entry.visible !== syncedVisible) {
    setSyncedVisible(entry.visible);
    if (entry.visible) setReleaseOnHide(false);
    else if (pictureFocused) {
      setPictureFocused(false);
      setReleaseOnHide(true);
    }
  }
  const releaseHiddenFocus = useEffectEvent(() => {
    pictureRef.current?.blur();
    session?.releaseAll();
    desktop.screenFocus(false);
    onFocusChange(daemonId, false);
  });
  useEffect(() => {
    if (releaseOnHide) releaseHiddenFocus();
  }, [releaseOnHide]);

  // The picture area's size, for the drawn remote cursor (measured by an observer, not during render).
  const [pictureSize, setPictureSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const node = pictureRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      const rect = node.getBoundingClientRect();
      setPictureSize((current) => (current && current.width === rect.width && current.height === rect.height ? current : { width: rect.width, height: rect.height }));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  function pointAt(event: { clientX: number; clientY: number }): { x: number; y: number } | null {
    const node = pictureRef.current;
    const display = state?.display;
    if (!node || !display) return null;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    // The canvas is drawn contained in the picture area; map through the drawn rectangle.
    const drawn = drawnRect(rect.width, rect.height, display.widthPoints, display.heightPoints);
    const x = ((event.clientX - rect.left - drawn.left) / drawn.width) * display.widthPoints;
    const y = ((event.clientY - rect.top - drawn.top) / drawn.height) * display.heightPoints;
    return { x: Math.min(display.widthPoints, Math.max(0, x)), y: Math.min(display.heightPoints, Math.max(0, y)) };
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!session) return;
    if (isImmersiveToggle(event)) {
      event.preventDefault();
      event.stopPropagation();
      swallowKeyUp.current.add(event.code);
      onToggleImmersive(daemonId);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    // Auto-repeats go through as such: posted CGEvents do not repeat on their own.
    session.sendKey(event.code, true, modifierBits(event), event.repeat);
  }

  function onKeyUp(event: ReactKeyboardEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (swallowKeyUp.current.delete(event.code)) return;
    session?.sendKey(event.code, false, modifierBits(event));
  }

  function onPointer(action: "move" | "down" | "up", event: ReactPointerEvent<HTMLDivElement>) {
    if (action === "down") pictureRef.current?.focus({ preventScroll: true });
    const point = pointAt(event);
    if (!point || !session) return;
    if (action !== "move") event.preventDefault();
    session.sendPointer(action, point.x, point.y, event.button < 0 ? 0 : event.button, modifierBits(event), action === "down" ? Math.max(1, event.detail) : 1);
  }

  function onWheel(event: ReactWheelEvent<HTMLDivElement>) {
    const point = pointAt(event);
    if (!point || !session) return;
    event.preventDefault();
    const precise = event.deltaMode === 0;
    session.sendScroll(point.x, point.y, event.deltaX, event.deltaY, modifierBits(event), precise);
  }

  const routeMode = transport?.mode;
  const routeLabel = routeMode === "direct" || routeMode === "peer" ? "直连" : routeMode === "relay" || routeMode === "remote" ? "中继" : routeMode === "probing" ? "探测中" : "未连接";
  const RouteIcon = routeMode === "direct" || routeMode === "peer" ? Zap : Cloud;
  const rttText = transport?.rttMs === undefined ? "" : ` · ${Math.round(transport.rttMs)}ms`;
  const phase = state?.phase ?? "connecting";
  const readOnly = phase === "streaming" && state?.permissions !== null && state?.permissions !== undefined && !state.permissions.accessibility;
  // An open resolution menu keeps the bar in, or its trigger would slide away under the menu.
  const showStatusBar = !immersive || hoverTop || resolutionMenuOpen;
  const pictureStyle: CSSProperties = immersive ? { top: 0 } : { top: STATUS_BAR_HEIGHT };
  const cursor = state?.cursor;
  const display = state?.display ?? null;
  const cursorStyle = pictureCursorStyle(cursor, display, pictureSize);

  function pickResolution(resolution: ScreenResolution) {
    if (!session) return;
    session.setResolution(resolution);
    writeScreenResolution(SCREEN_RESOLUTION_STORE, daemonId, resolution);
  }

  return (
    <div
      ref={containerRef}
      data-screen-view={daemonId}
      className={cn("absolute inset-0 overflow-hidden bg-black", immersive && "z-40")}
      style={{ visibility: entry.visible ? "visible" : "hidden" }}
      aria-hidden={!entry.visible}
      onPointerMove={(event) => {
        if (!immersive) return;
        const rect = event.currentTarget.getBoundingClientRect();
        setHoverTop(event.clientY - rect.top <= (hoverTop ? STATUS_BAR_HEIGHT + 8 : 4));
      }}
      onPointerLeave={() => immersive && setHoverTop(false)}
    >
      {/* Status bar: the device, connection route and latency, the resolution, 沉浸 and 断开. It sits at the
          window's top edge, so like the files overlay's header it is a window drag band that keeps the
          action dock's measured width free on its right and, with the sidebar collapsed, the left dock's
          on its left; every control in it is no-drag. It comes before the action dock in document order
          (see workbench.tsx), so the dock's no-drag hole holds. In immersive mode (window full screen, no
          docks) it is no drag region and slides in from the top edge. */}
      <div
        className={cn(
          "absolute inset-x-0 top-0 z-10 flex items-center gap-2 border-b border-border bg-background px-3 text-sm text-muted-foreground transition-transform",
          immersive && !showStatusBar && "-translate-y-full",
        )}
        style={{
          height: STATUS_BAR_HEIGHT,
          ...(immersive
            ? null
            : { ...DRAG_REGION_STYLE, paddingRight: Math.max(dockWidth, 12), ...(leftDockReserve > 0 ? { paddingLeft: leftDockReserve } : null) }),
        }}
      >
        <Monitor className="size-3.5 shrink-0" />
        <span className="truncate text-foreground">{daemon?.name ?? "设备"}</span>
        <span className="flex items-center gap-1 whitespace-nowrap">
          <RouteIcon className="size-3 shrink-0" />
          {routeLabel}
          {rttText}
        </span>
        <span className="truncate">{phaseLabel(phase)}</span>
        {readOnly ? (
          <Tooltip content="那台 Mac 未授予 Coflux「辅助功能」权限，只能查看，不能操作" placement="below">
            <span className="flex items-center gap-1 whitespace-nowrap text-warning" style={NO_DRAG_REGION_STYLE}>
              <ShieldAlert className="size-3" />
              只读
            </span>
          </Tooltip>
        ) : null}
        <span className="flex-1" />
        <ResolutionMenu
          resolution={state?.resolution ?? null}
          display={display}
          isDisabled={!session}
          open={resolutionMenuOpen}
          onOpenChange={setResolutionMenuOpen}
          onPick={pickResolution}
          isPictureFocused={() => document.activeElement === pictureRef.current}
          onRestoreFocus={() => pictureRef.current?.focus({ preventScroll: true })}
        />
        <Tooltip content={immersive ? "退出沉浸模式 ⌃⌥⌘F" : "沉浸模式 ⌃⌥⌘F"} placement="below">
          <button
            type="button"
            aria-label={immersive ? "退出沉浸模式" : "沉浸模式"}
            aria-pressed={immersive}
            className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 transition-colors hover:bg-accent hover:text-foreground"
            style={NO_DRAG_REGION_STYLE}
            onClick={() => onToggleImmersive(daemonId)}
          >
            {immersive ? <Shrink className="size-3.5" /> : <Expand className="size-3.5" />}
            沉浸
          </button>
        </Tooltip>
        <Tooltip content="断开：结束远端会话，虚拟显示器随之移除" placement="below">
          <button
            type="button"
            aria-label="断开"
            className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 transition-colors hover:bg-accent hover:text-foreground"
            style={NO_DRAG_REGION_STYLE}
            onClick={() => onDisconnect(daemonId)}
          >
            <X className="size-3.5" />
            断开
          </button>
        </Tooltip>
      </div>

      {/* The picture: focusable, every key and pointer event goes to the remote. */}
      <div
        ref={pictureRef}
        role="application"
        aria-label={`${daemon?.name ?? "设备"} 的屏幕`}
        tabIndex={0}
        className="absolute inset-x-0 bottom-0 outline-none"
        style={{ ...pictureStyle, ...cursorStyle }}
        onFocus={() => focusPicture(true)}
        onBlur={() => focusPicture(false)}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onPointerDown={(event) => onPointer("down", event)}
        onPointerUp={(event) => onPointer("up", event)}
        onPointerMove={(event) => onPointer("move", event)}
        onContextMenu={(event) => event.preventDefault()}
        onWheel={onWheel}
      >
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" style={{ objectFit: "contain" }} />
        {cursor?.visible && cursor.shapeUrl && display && phase === "streaming" ? (
          <img
            src={cursor.shapeUrl}
            alt=""
            aria-hidden
            className="pointer-events-none absolute left-0 top-0"
            style={remoteCursorStyle(cursor, display, pictureSize)}
          />
        ) : null}
        <StateOverlay phase={phase} state={state} deviceOnline={deviceOnline} deviceName={daemon?.name ?? "设备"} daemonId={daemonId} session={session} />
        {phase === "streaming" && !pictureFocused && entry.visible ? (
          <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md bg-background/80 px-2 py-1 text-2xs text-muted-foreground backdrop-blur">
            点击画面后，键盘和鼠标都发往远端
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The status bar's resolution dropdown: 「跟随窗口」 and the fixed presets, the current one checked.
 * Its tooltip names what the remote display actually is.
 */
function ResolutionMenu({
  resolution,
  display,
  isDisabled,
  open,
  onOpenChange,
  onPick,
  isPictureFocused,
  onRestoreFocus,
}: {
  resolution: ScreenResolution;
  display: ScreenSessionState["display"];
  isDisabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (resolution: ScreenResolution) => void;
  isPictureFocused: () => boolean;
  onRestoreFocus: () => void;
}) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  // Opening the menu from a focused picture takes the focus away (the picture's blur releases what
  // the remote holds); closing it hands the focus back, unless it went somewhere on purpose.
  const returnFocusRef = useRef(false);
  function changeOpen(next: boolean) {
    onOpenChange(next);
    if (next) return;
    const restore = returnFocusRef.current;
    returnFocusRef.current = false;
    if (!restore) return;
    // Astryx moves focus after this callback; look once it settled.
    requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (!focused || focused === document.body || focused === anchorRef.current) onRestoreFocus();
    });
  }
  // The app's compact-menu convention (the changes view's ScopeMenu): the current option checked, an
  // empty slot keeping the others aligned.
  const current = screenResolutionValue(resolution);
  const option = (choice: ScreenResolution): DropdownMenuOption => ({
    label: screenResolutionLabel(choice),
    icon: screenResolutionValue(choice) === current ? <Check className="size-3.5" /> : <span className="size-3.5" />,
    onClick: () => onPick(choice),
  });
  return (
    <>
      <DropdownMenu
        isMenuOpen={open}
        onOpenChange={changeOpen}
        menuWidth={200}
        placement="below"
        alignment="end"
        hasChevron={false}
        items={[option(null), ...SCREEN_RESOLUTION_PRESETS.map((preset) => option(preset))]}
        button={{
          ref: anchorRef,
          label: screenResolutionLabel(resolution),
          variant: "ghost",
          size: "sm",
          isDisabled,
          // Read before the pointer moves the focus off the picture.
          onPointerDown: () => {
            if (!open) returnFocusRef.current = isPictureFocused();
          },
          // The standard compact trigger; no-drag because the bar is a window drag band.
          style: { color: "var(--secondary-foreground)", height: 24, paddingInline: 6, gap: 4, flexShrink: 0, ...NO_DRAG_REGION_STYLE },
        }}
      />
      <Tooltip
        anchorRef={anchorRef}
        isEnabled={!open}
        isOpen={open ? false : undefined}
        placement="below"
        content={display ? `远端分辨率 ${display.widthPoints}×${display.heightPoints}@${display.scale}x` : "远端分辨率"}
      />
    </>
  );
}

/** Where the contained canvas is drawn inside the picture area (CSS px, relative to it). */
function drawnRect(areaWidth: number, areaHeight: number, widthPoints: number, heightPoints: number): { left: number; top: number; width: number; height: number } {
  if (widthPoints <= 0 || heightPoints <= 0) return { left: 0, top: 0, width: areaWidth, height: areaHeight };
  const scale = Math.min(areaWidth / widthPoints, areaHeight / heightPoints);
  const width = widthPoints * scale;
  const height = heightPoints * scale;
  return { left: (areaWidth - width) / 2, top: (areaHeight - height) / 2, width, height };
}

/** The local cursor is hidden over a live picture; the remote's is drawn instead. */
function pictureCursorStyle(cursor: ScreenSessionState["cursor"] | undefined, display: { widthPoints: number } | null, size: { width: number; height: number } | null): CSSProperties {
  if (!cursor || !display || !size) return {};
  return cursor.shapeUrl ? { cursor: "none" } : {};
}

function remoteCursorStyle(cursor: ScreenSessionState["cursor"], display: { widthPoints: number; heightPoints: number }, size: { width: number; height: number } | null): CSSProperties {
  if (!size) return { display: "none" };
  const drawn = drawnRect(size.width, size.height, display.widthPoints, display.heightPoints);
  const scale = drawn.width / display.widthPoints;
  return {
    transform: `translate(${drawn.left + (cursor.x - cursor.hotspotX) * scale}px, ${drawn.top + (cursor.y - cursor.hotspotY) * scale}px)`,
    width: cursor.widthPoints * scale,
    height: cursor.heightPoints * scale,
  };
}

function phaseLabel(phase: ScreenSessionState["phase"]): string {
  switch (phase) {
    case "connecting":
      return "正在连接…";
    case "starting":
      return "正在准备远端显示器…";
    case "streaming":
      // The resolution is the status bar's dropdown (and its tooltip).
      return "";
    case "paused":
      return "已暂停";
    case "no-permission":
      return "缺少屏幕录制权限";
    case "locked":
      return "远端已锁定";
    case "detached":
      return "已被其它客户端接管";
    case "offline":
      return "设备离线";
    case "unsupported":
      return "不支持";
    case "error":
      return "连接失败";
    case "closed":
      return "已断开";
  }
}

const SCREEN_SHARING_ERRORS: Record<"offline" | "refused" | "unsupported", string> = {
  refused: "那台 Mac 没有开启「屏幕共享」。请在它的「系统设置 → 通用 → 共享」里打开「屏幕共享」后重试。",
  unsupported: "那台设备上的 coflux 版本太旧，不支持这个功能。请先更新那台设备上的 coflux。",
  offline: "暂时无法连接到那台设备。请确认它在线后重试。",
};

/** The locked state: the lock screen is not capturable, so unlocking is handed to macOS Screen Sharing (main probes and forwards). */
function LockedOverlayBody({ daemonId, deviceOnline }: { daemonId: string; deviceOnline: boolean }) {
  const [pending, setPending] = useState(false);
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = () => {
    setPending(true);
    setError(null);
    desktop
      .screenSharingOpen(daemonId)
      .then((result) => {
        if (result.ok) {
          setOpened(true);
          return;
        }
        setOpened(false);
        setError(SCREEN_SHARING_ERRORS[result.reason]);
      })
      .catch(() => setError(SCREEN_SHARING_ERRORS.offline))
      .finally(() => setPending(false));
  };
  return (
    <>
      <Lock className="size-5 text-muted-foreground" />
      <h2 className="mt-4 text-base font-medium text-foreground">远端已锁定</h2>
      <p className="mt-1.5 text-sm leading-5 text-muted-foreground">可以通过 macOS 屏幕共享解锁那台 Mac，解锁后这里的画面会自动恢复。</p>
      <Button className="mt-5" label={pending ? "正在打开屏幕共享…" : "用 macOS 屏幕共享解锁"} variant="primary" size="sm" isDisabled={!deviceOnline || pending} onClick={open} />
      {error ? <p className="mt-3 text-xs leading-5 text-destructive">{error}</p> : null}
      {opened && !error ? <p className="mt-3 text-xs leading-5 text-muted-foreground">解锁后可以关闭屏幕共享窗口。</p> : null}
    </>
  );
}

function StateOverlay({ phase, state, deviceOnline, deviceName, daemonId, session }: { phase: ScreenSessionState["phase"]; state: ScreenSessionState | null; deviceOnline: boolean; deviceName: string; daemonId: string; session: ScreenSession | null }) {
  if (phase === "streaming" || phase === "paused" || phase === "closed") return null;
  const shell = (children: ReactNode) => (
    <div className="absolute inset-0 flex items-center justify-center bg-terminal">
      <div className="flex max-w-md flex-col items-center text-center">{children}</div>
    </div>
  );
  switch (phase) {
    case "connecting":
    case "starting":
      return shell(
        <>
          <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
          <p className="mt-4 text-sm text-muted-foreground">{phase === "connecting" ? `正在连接「${deviceName}」…` : "正在那台 Mac 上准备虚拟显示器…"}</p>
        </>,
      );
    case "offline":
      return shell(
        <>
          <Unplug className="size-5 text-muted-foreground" />
          <h2 className="mt-4 text-base font-medium text-foreground">「{deviceName}」当前离线</h2>
          <p className="mt-1.5 text-sm leading-5 text-muted-foreground">设备上线后会自动重新连接。</p>
        </>,
      );
    case "no-permission":
      return shell(
        <>
          <ShieldAlert className="size-5 text-warning" />
          <h2 className="mt-4 text-base font-medium text-foreground">那台 Mac 未授予「屏幕录制」权限</h2>
          <p className="mt-1.5 text-sm leading-5 text-muted-foreground">
            已在「{deviceName}」上弹出系统授权请求；也可以在那台 Mac 的「系统设置 → 隐私与安全性 → 屏幕录制」里勾选 Coflux。授予后这里会自动连接。
            {state?.permissions && !state.permissions.accessibility ? "「辅助功能」也尚未授予：授予前只能查看，不能操作。" : ""}
          </p>
        </>,
      );
    case "locked":
      return shell(<LockedOverlayBody daemonId={daemonId} deviceOnline={deviceOnline} />);
    case "detached":
      return (
        <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-2 border-b border-warning/20 bg-warning/10 px-4 py-2 text-xs text-warning backdrop-blur">
          <span className="flex min-w-0 items-center gap-2">
            <Unplug className="size-3.5 shrink-0" />
            <span className="truncate">此屏幕已被其它客户端接管。</span>
          </span>
          <Button label="重新接管" variant="secondary" size="sm" onClick={() => session?.takeOver()} />
        </div>
      );
    case "unsupported":
      return shell(
        <>
          <Monitor className="size-5 text-muted-foreground" />
          <h2 className="mt-4 text-base font-medium text-foreground">这台设备还不能打开屏幕</h2>
          <p className="mt-1.5 text-sm leading-5 text-muted-foreground">{state?.error || "远端需要由 Coflux 桌面版启动的运行时，并更新到带有屏幕助手的版本。"}</p>
        </>,
      );
    case "error":
      return shell(
        <>
          <Unplug className="size-5 text-destructive" />
          <h2 className="mt-4 text-base font-medium text-foreground">连接失败</h2>
          <p className="mt-1.5 text-sm leading-5 text-muted-foreground">{state?.error || "远端没有响应。"}</p>
          <Button className="mt-5" label="重试" variant="secondary" size="sm" isDisabled={!deviceOnline} onClick={() => session?.retry()} />
        </>,
      );
    default:
      return null;
  }
}
