import { useRef, useState, type SyntheticEvent } from "react";
import { useStore } from "zustand";
import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu";
import { Text } from "@astryxdesign/core/Text";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { AppWindow, Router } from "lucide-react";
import type { CofluxClient } from "@coflux/client";

export type ForwardedPort = { port: number; url: string; titles: string[] };

/**
 * A workspace's forwarded ports, one entry per preview URL, by port. Shared by this menu and the
 * blank browser tab's port list (plan 20260924-desktop-browser-tab), which read the same state.
 */
export function listForwardedPorts(
  tasks: readonly { workspaceId: string; id: string; title: string }[],
  ports: Readonly<Record<string, readonly { port: number; url: string }[] | undefined>>,
  workspaceId: string | null,
): ForwardedPort[] {
  const entries = new Map<string, ForwardedPort>();
  for (const task of tasks) {
    if (task.workspaceId !== workspaceId) continue;
    for (const preview of ports[task.id] ?? []) {
      const existing = entries.get(preview.url);
      if (existing) existing.titles.push(task.title);
      else entries.set(preview.url, { port: preview.port, url: preview.url, titles: [task.title] });
    }
  }
  return [...entries.values()].sort((a, b) => a.port - b.port);
}

/** Keeps a press on the row's trailing button from also activating the row (the system browser). */
function stopRowActivation(event: SyntheticEvent) {
  event.stopPropagation();
}

export function PortMenu({
  client,
  workspaceId,
  onOpenInBrowser,
}: {
  client: CofluxClient;
  workspaceId: string | null;
  /** The row's trailing button (plan 20260924-desktop-browser-tab): `http://localhost:<port>` in a built-in browser tab. */
  onOpenInBrowser?: (port: number) => void;
}) {
  const tasks = useStore(client.store, (state) => state.tasks);
  const ports = useStore(client.store, (state) => state.ports);
  const previews = listForwardedPorts(tasks, ports, workspaceId);
  const count = previews.length;
  // 受控：DropdownMenu 只有拿到 isMenuOpen 才会调 onOpenChange，而 tooltip 的压制要跟着菜单开合走。
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  return <>
    <DropdownMenu
    isMenuOpen={open}
    onOpenChange={setOpen}
    menuWidth={240}
    hasChevron={false}
    placement="below"
    alignment="end"
    button={{
      ref: anchorRef,
      label: `端口转发，${count} 个端口`,
      icon: <span className="relative flex"><Router className="size-3.5" />{count > 0 && <span aria-hidden className="absolute -right-2 -top-1.5 min-w-2.5 rounded-sm bg-background px-0.5 text-center text-[9px] leading-3 text-foreground">{count > 9 ? "9+" : count}</span>}</span>,
      isIconOnly: true,
      variant: "ghost",
      size: "sm",
      style: { color: "var(--muted-foreground)", height: 24, width: 24, minWidth: 24, paddingInline: 0 },
    }}
  >
    {count > 0 ? <div className="-mr-1 max-h-60 overflow-y-auto pr-1">
      {previews.map((preview) => <DropdownMenuItem
        key={preview.url}
        label={<span className="flex min-w-0 items-center gap-3">
          <span className="shrink-0 tabular-nums">:{preview.port}</span>
          <span className="truncate text-muted-foreground">{preview.titles.join("、")}</span>
        </span>}
        // The row itself still opens the system browser (the preview URL), as before.
        onClick={() => window.open(preview.url, "_blank", "noreferrer")}
        endContent={onOpenInBrowser ? (
          <Tooltip content="用内置浏览器打开" placement="start">
            <button
              type="button"
              aria-label="用内置浏览器打开"
              className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onPointerDown={stopRowActivation}
              onPointerUp={stopRowActivation}
              onMouseDown={stopRowActivation}
              onMouseUp={stopRowActivation}
              onKeyDown={stopRowActivation}
              onClick={(event) => {
                event.stopPropagation();
                event.preventDefault();
                setOpen(false);
                onOpenInBrowser(preview.port);
              }}
            >
              <AppWindow className="size-3.5" />
            </button>
          </Tooltip>
        ) : undefined}
      />)}
    </div> : <div className="px-2 py-1.5"><Text type="supporting">当前工作区没有转发中的端口。</Text></div>}
    </DropdownMenu>
    {/* 同铃铛：sibling Tooltip 挂在菜单之后，绕开 button.tooltip（见 docs/design-guidelines.md）。 */}
    <Tooltip anchorRef={anchorRef} isOpen={open ? false : undefined} content={count > 0 ? `端口转发 · ${count} 个端口` : "端口转发"} />
  </>;
}
