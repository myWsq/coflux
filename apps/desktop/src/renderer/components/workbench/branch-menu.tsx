import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check, Plus } from "lucide-react";
import { Divider } from "@astryxdesign/core/Divider";
import { DropdownMenu, DropdownMenuItem, type DropdownMenuButtonProps } from "@astryxdesign/core/DropdownMenu";
import { Text } from "@astryxdesign/core/Text";

/** 不可选分支的原因（行内短提示 + tooltip 全文） */
export type BranchTaken = { hint: string; reason: string };

type BranchMenuProps = {
  /** 触发按钮（Astryx Button props），由调用方定制形态 */
  button: DropdownMenuButtonProps;
  /** 当前分支（切分支场景）：列表打勾、点击即关闭；创建工作区场景不传 */
  currentBranch?: string;
  listBranches: () => Promise<{ ok: boolean; branches: string[]; error: string }>;
  takenBranches: Map<string, BranchTaken>;
  /** 点击即触发（fire-and-forget）：进度/失败由调用方呈现 */
  onPick: (branch: string, createNew: boolean) => void;
  /** 受控打开（如从右键菜单唤起）；不传则组件内部管理 */
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/** 可操作条目：已有分支行 / "从 HEAD 新建"行 */
type Entry = { kind: "branch"; name: string; taken?: BranchTaken } | { kind: "create"; name: string };

/**
 * Cursor 式分支选择菜单（切分支 / 新建工作区共用）：DropdownMenu compound 模式，
 * 首项是无边框搜索输入。输入精确命中已有分支 = 检出；不精确时首行出现「从 HEAD 新建」。
 */
export function BranchMenu(props: BranchMenuProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = props.isOpen ?? internalOpen;
  const setOpen = (next: boolean) => {
    props.onOpenChange?.(next);
    if (props.isOpen === undefined) setInternalOpen(next);
  };
  return (
    <DropdownMenu
      isMenuOpen={open}
      onOpenChange={setOpen}
      menuWidth={320}
      hasChevron={false}
      placement="below"
      button={props.button}
    >
      {open ? <BranchMenuPanel {...props} close={() => setOpen(false)} /> : null}
    </DropdownMenu>
  );
}

/** 面板随 open 重建（state 天然复位） */
function BranchMenuPanel(props: BranchMenuProps & { close: () => void }) {
  const [query, setQuery] = useState("");
  /** null = 加载中 */
  const [branches, setBranches] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [highlight, setHighlight] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void props.listBranches().then((result) => {
      if (cancelled) return;
      setBranches(result.branches);
      if (!result.ok) setLoadError(result.error);
    });
    // DropdownMenu 打开时会 rAF 聚焦首个 menuitem，双重 rAF 在其后把焦点抢回搜索框
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => inputRef.current?.focus()));
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const trimmed = query.trim();
  const lowered = trimmed.toLowerCase();
  const matches = (branches ?? []).filter((item) => item.toLowerCase().includes(lowered));
  const exactMatch = (branches ?? []).some((item) => item === trimmed);
  const entries: Entry[] = [
    ...(trimmed && !exactMatch && branches !== null ? [{ kind: "create", name: trimmed } as Entry] : []),
    ...matches.map((name) => ({ kind: "branch", name, taken: props.takenBranches.get(name) }) as Entry),
  ];

  /** 当前分支可点（点击即关闭）；被占用的不可点 */
  const isCurrent = (entry: Entry) => entry.kind === "branch" && entry.name === props.currentBranch;
  const actionable = (entry: Entry) => entry.kind === "create" || entry.taken === undefined || isCurrent(entry);

  useEffect(() => {
    setHighlight(entries.findIndex(actionable));
    // 只随查询/数据变化复位高亮
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, branches]);

  useEffect(() => {
    if (highlight < 0) return;
    (listRef.current?.children[highlight] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  function moveHighlight(delta: number) {
    if (entries.length === 0) return;
    setHighlight((index) => {
      let next = index + delta;
      while (next >= 0 && next < entries.length && !actionable(entries[next]!)) next += delta;
      if (next < 0 || next >= entries.length) return index;
      return next;
    });
  }

  function act(entry: Entry) {
    if (!actionable(entry)) return;
    // 点击即关（Cursor 式）：动作在后台执行，进度/失败由调用方呈现
    if (!isCurrent(entry)) props.onPick(entry.name, entry.kind === "create");
    props.close();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // Escape 放行冒泡（菜单自身负责关闭）；其余按键一律截停，
    // 避免 DropdownMenu 容器的方向键导航/首字母 typeahead 抢走输入框焦点
    if (event.key === "Escape") return;
    event.stopPropagation();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveHighlight(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveHighlight(-1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const entry = entries[highlight];
      if (entry) act(entry);
    }
  }

  return (
    <div className="flex w-full flex-col">
      {/* 搜索是固定头部（不在滚动区内），天然"吸顶"；滚动只发生在下面的列表里 */}
      <input
        ref={inputRef}
        className="w-full bg-transparent px-2 pb-2 pt-1 text-base text-foreground outline-none placeholder:text-muted-foreground"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="搜索或输入新分支名"
        aria-label="搜索或输入新分支名"
        autoComplete="off"
        spellCheck={false}
      />
      <Divider />

      {branches === null ? (
        <div className="px-2 py-1.5">
          <Text type="supporting">正在获取分支列表…</Text>
        </div>
      ) : entries.length > 0 ? (
        <div
          ref={listRef}
          className="coflux-branch-list -mr-1 max-h-60 overflow-y-auto pr-1 pt-1"
          onMouseMove={(event) => {
            // 鼠标真实移动才更新高亮（与方向键共用单一高亮源，避免双高亮）
            const row = (event.target as HTMLElement).closest('[role="menuitem"]');
            if (!row || !listRef.current) return;
            const index = Array.prototype.indexOf.call(listRef.current.children, row);
            if (index >= 0 && entries[index] && actionable(entries[index])) setHighlight(index);
          }}
        >
          {entries.map((entry, index) => (
            <DropdownMenuItem
              key={`${entry.kind}:${entry.name}`}
              icon={entry.kind === "create" ? Plus : undefined}
              label={entry.kind === "create" ? `从 HEAD 新建「${entry.name}」` : entry.name}
              isDisabled={!actionable(entry)}
              endContent={
                isCurrent(entry) ? (
                  <Check className="size-3.5 text-success" aria-hidden />
                ) : entry.kind === "branch" && entry.taken ? (
                  <Text type="body" size="sm" color="secondary">
                    {entry.taken.hint}
                  </Text>
                ) : undefined
              }
              onClick={() => act(entry)}
              className={index === highlight ? "is-highlighted" : undefined}
            />
          ))}
        </div>
      ) : (
        <div className="px-2 py-1.5">
          <Text type="supporting">没有匹配的分支。</Text>
        </div>
      )}

      {loadError ? (
        <div className="px-2 py-1">
          <Text type="supporting">{loadError}</Text>
        </div>
      ) : null}
    </div>
  );
}
