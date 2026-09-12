import { useStore } from "zustand";
import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu";
import { Text } from "@astryxdesign/core/Text";
import { Router } from "lucide-react";
import type { CofluxClient } from "@coflux/client";

export function PortMenu({ client, workspaceId }: { client: CofluxClient; workspaceId: string | null }) {
  const tasks = useStore(client.store, (state) => state.tasks);
  const ports = useStore(client.store, (state) => state.ports);
  const entries = new Map<string, { port: number; url: string; titles: string[] }>();
  for (const task of tasks) {
    if (task.workspaceId !== workspaceId) continue;
    for (const preview of ports[task.id] ?? []) {
      const existing = entries.get(preview.url);
      if (existing) existing.titles.push(task.title);
      else entries.set(preview.url, { ...preview, titles: [task.title] });
    }
  }
  const previews = [...entries.values()].sort((a, b) => a.port - b.port);
  const count = previews.length;
  return <DropdownMenu
    menuWidth={220}
    hasChevron={false}
    placement="below"
    button={{
      label: `端口转发，${count} 个端口`,
      icon: <span className="relative flex"><Router className="size-3.5" />{count > 0 && <span aria-hidden className="absolute -right-2 -top-1.5 min-w-2.5 rounded-sm bg-background px-0.5 text-center text-[9px] leading-3 text-foreground">{count > 9 ? "9+" : count}</span>}</span>,
      isIconOnly: true,
      variant: "ghost",
      size: "sm",
      tooltip: count > 0 ? `端口转发 · ${count} 个端口` : "端口转发",
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
        onClick={() => window.open(preview.url, "_blank", "noreferrer")}
      />)}
    </div> : <div className="px-2 py-1.5"><Text type="supporting">当前工作区没有转发中的端口。</Text></div>}
  </DropdownMenu>;
}
