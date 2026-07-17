import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Folder, Monitor, MonitorUp, Search } from "lucide-react";
import { FsEntryKind, type DaemonInfo, type FsEntry } from "@coflux/protocol";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, Layout, LayoutContent, LayoutFooter, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";

import type { FsListResult } from "@/client/store";

type ImportProjectWizardProps = {
  open: boolean;
  daemons: DaemonInfo[];
  onOpenChange: (open: boolean) => void;
  onImport: (daemonId: string, path: string) => void;
  onAddDevice: () => void;
  listDirectory: (daemonId: string, path: string) => Promise<FsListResult>;
};

/** Dialog 定高：header/搜索/底栏固定，中间列表超出内部滚动 */
const DIALOG_HEIGHT = 420;

/** 拆绝对路径为段：`/Users/wsq` → `["Users","wsq"]`；`/` → `[]` */
function splitAbsPath(abs: string): string[] {
  if (!abs || abs === "/") return [];
  return abs.replace(/\/+$/, "").split("/").filter(Boolean);
}

/** 由段还原绝对路径：index < 0 → `/`；否则含该段 */
function joinAbsPath(segments: string[], endIndex: number): string {
  if (endIndex < 0) return "/";
  return `/${segments.slice(0, endIndex + 1).join("/")}`;
}

function parentAbsPath(abs: string): string | null {
  const segments = splitAbsPath(abs);
  if (segments.length === 0) return null;
  return joinAbsPath(segments, segments.length - 2);
}

/**
 * 导入项目两步向导（plan 012）：选设备 → 浏览该设备文件系统选文件夹。
 * 默认从 HOME 起步；路径栏按绝对路径拆段（`/ Users / wsq / …`），段可点跳转。
 * 选错非 git 目录由既有 ProjectValidate 报错兜底。
 */
export function ImportProjectWizard(props: ImportProjectWizardProps) {
  const onlineDaemons = props.daemons.filter((daemon) => daemon.online);
  const [step, setStep] = useState<"device" | "browse">("device");
  const [daemonId, setDaemonId] = useState("");
  const [query, setQuery] = useState("");
  /** 首次 `~` 列出的 HOME，用于禁止「导入家目录本身」 */
  const [homeAbs, setHomeAbs] = useState("");
  /** 当前目录绝对路径（FsListed.path） */
  const [cwdAbs, setCwdAbs] = useState("");
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [pathFilter, setPathFilter] = useState("");
  /** -1 = 未进入键盘选择；按 ↓ 才从 0 开始高亮 */
  const [highlight, setHighlight] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requestSeq = useRef(0);
  const deviceInputRef = useRef<HTMLInputElement>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const pathSegments = useMemo(() => splitAbsPath(cwdAbs), [cwdAbs]);

  const filteredDaemons = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return onlineDaemons;
    return onlineDaemons.filter(
      (daemon) => daemon.name.toLowerCase().includes(q) || daemon.host.toLowerCase().includes(q),
    );
  }, [onlineDaemons, query]);

  const filteredEntries = useMemo(() => {
    const q = pathFilter.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((entry) => entry.name.toLowerCase().includes(q));
  }, [entries, pathFilter]);

  const listLength = step === "device" ? filteredDaemons.length : filteredEntries.length;

  useEffect(() => {
    if (!props.open) return;
    setStep("device");
    setQuery("");
    setHomeAbs("");
    setCwdAbs("");
    setEntries([]);
    setPathFilter("");
    setHighlight(-1);
    setError("");
    setDaemonId("");
    queueMicrotask(() => deviceInputRef.current?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, props.daemons]);

  useEffect(() => {
    setHighlight(-1);
  }, [step, query, pathFilter, entries]);

  useEffect(() => {
    if (highlight >= 0 && highlight >= listLength) {
      setHighlight(listLength === 0 ? -1 : listLength - 1);
    }
  }, [highlight, listLength]);

  useEffect(() => {
    if (highlight < 0) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-import-index="${highlight}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [highlight, step, listLength]);

  const canImport = Boolean(cwdAbs && homeAbs && cwdAbs !== homeAbs && !loading);

  async function loadDirectory(targetDaemonId: string, path: string) {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError("");
    // 保留上一屏列表/路径，等结果到齐再换（避免切换闪动）
    const result = await props.listDirectory(targetDaemonId, path);
    if (seq !== requestSeq.current) return;
    setLoading(false);
    if (!result.ok) {
      setError(result.error || "读取目录失败");
      return;
    }
    setPathFilter("");
    if (result.path) {
      setCwdAbs(result.path);
      if (path === "~") setHomeAbs(result.path);
    }
    // 与 Cursor 一致：展示全部子目录（含隐藏），方便定位仓库
    setEntries(result.entries.filter((entry) => entry.kind === FsEntryKind.DIR));
    queueMicrotask(() => pathInputRef.current?.focus());
  }

  function selectDevice(id: string) {
    setDaemonId(id);
    setHomeAbs("");
    setCwdAbs("");
    setStep("browse");
    void loadDirectory(id, "~");
  }

  function enterFolder(name: string) {
    const next = !cwdAbs || cwdAbs === "/" ? `/${name}` : `${cwdAbs}/${name}`;
    void loadDirectory(daemonId, next);
  }

  function jumpToSegment(index: number) {
    void loadDirectory(daemonId, joinAbsPath(pathSegments, index));
  }

  function moveHighlight(delta: number) {
    if (listLength === 0) return;
    setHighlight((index) => {
      if (index < 0) return delta > 0 ? 0 : -1;
      const next = index + delta;
      if (next < 0) return -1;
      return Math.min(listLength - 1, next);
    });
  }

  function onDeviceKeyDown(event: KeyboardEvent<HTMLInputElement>) {
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
      if (highlight < 0) return;
      const selected = filteredDaemons[highlight];
      if (selected) {
        event.preventDefault();
        selectDevice(selected.daemonId);
      }
    }
  }

  function onPathKeyDown(event: KeyboardEvent<HTMLInputElement>) {
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
    if (event.key === "Backspace" && pathFilter === "") {
      const parent = parentAbsPath(cwdAbs);
      if (parent) {
        event.preventDefault();
        void loadDirectory(daemonId, parent);
      }
      return;
    }
    if (event.key === "Tab") {
      if (highlight < 0) return;
      const selected = filteredEntries[highlight];
      if (!selected) return;
      event.preventDefault();
      if (pathFilter.trim().toLowerCase() === selected.name.toLowerCase()) {
        enterFolder(selected.name);
      } else {
        setPathFilter(selected.name);
      }
      return;
    }
    if (event.key === "Enter" && event.metaKey) {
      // 由窗口级监听统一处理，避免与 Enter 进入文件夹冲突
      event.preventDefault();
      return;
    }
    if (event.key === "Enter") {
      if (highlight < 0) return;
      event.preventDefault();
      const selected = filteredEntries[highlight];
      if (selected) enterFolder(selected.name);
    }
  }

  function importCurrent() {
    if (!canImport || !cwdAbs) return;
    props.onImport(daemonId, cwdAbs);
    props.onOpenChange(false);
  }

  function goToDeviceStep() {
    setStep("device");
    queueMicrotask(() => deviceInputRef.current?.focus());
  }

  /** Esc / 点遮罩：第 2 步先回退；仅第 1 步才真正关闭。右上角 × 仍直接关闭。 */
  function handleOpenChange(open: boolean) {
    if (!open && step === "browse") {
      goToDeviceStep();
      return;
    }
    props.onOpenChange(open);
  }

  const onImport = props.onImport;
  const onOpenChange = props.onOpenChange;

  useEffect(() => {
    if (!props.open || step !== "browse") return;
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== "Enter" || !event.metaKey) return;
      if (!canImport || !cwdAbs) return;
      event.preventDefault();
      onImport(daemonId, cwdAbs);
      onOpenChange(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.open, step, canImport, cwdAbs, daemonId, onImport, onOpenChange]);

  const currentName = pathSegments.length > 0 ? pathSegments[pathSegments.length - 1]! : cwdAbs || "/";
  const stepLabel = step === "device" ? "第 1 步（共 2 步）" : "第 2 步（共 2 步）";
  const showDeviceFooter = step === "device" && onlineDaemons.length > 0;
  const showBrowseFooter = step === "browse";

  return (
    <Dialog
      isOpen={props.open}
      onOpenChange={handleOpenChange}
      purpose="form"
      width={520}
      maxHeight={DIALOG_HEIGHT}
      style={{ height: DIALOG_HEIGHT }}
    >
      <Layout
        header={
          <DialogHeader
            title="导入项目"
            endContent={
              <Text type="body" color="secondary" size="sm">
                {stepLabel}
              </Text>
            }
            onOpenChange={props.onOpenChange}
            hasDivider={false}
          />
        }
        content={
          <LayoutContent>
            {step === "device" ? (
              onlineDaemons.length > 0 ? (
                <VStack gap={2} hAlign="stretch" style={{ height: "100%", minHeight: 0 }}>
                  <div className="coflux-pathbar" onClick={() => deviceInputRef.current?.focus()}>
                    <span className="coflux-pathbar__icon" aria-hidden>
                      <Search />
                    </span>
                    <input
                      ref={deviceInputRef}
                      className="coflux-pathbar__input"
                      value={query}
                      onChange={(event) => {
                        setQuery(event.target.value);
                      }}
                      onKeyDown={onDeviceKeyDown}
                      placeholder="搜索设备名或主机"
                      aria-label="搜索设备名或主机"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>

                  {filteredDaemons.length > 0 ? (
                    <div ref={listRef} role="listbox" aria-label="在线设备" className="coflux-import-list">
                      {filteredDaemons.map((daemon, index) => (
                        <button
                          key={daemon.daemonId}
                          type="button"
                          role="option"
                          aria-selected={index === highlight}
                          data-import-index={index}
                          className={`coflux-import-row${index === highlight ? " is-active" : ""}`}
                          onMouseEnter={() => setHighlight(index)}
                          onClick={() => selectDevice(daemon.daemonId)}
                        >
                          <span className="coflux-import-row__icon">
                            <Monitor aria-hidden />
                          </span>
                          <Text type="body" className="coflux-import-row__name" maxLines={1}>
                            {daemon.name}
                          </Text>
                          <Text type="body" color="secondary" size="sm">
                            设备
                          </Text>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <Text type="supporting">没有匹配的设备。</Text>
                  )}
                </VStack>
              ) : (
                <VStack gap={3} hAlign="center">
                  <Icon icon={MonitorUp} size="md" />
                  <VStack gap={1} hAlign="center">
                    <Text type="body" weight="bold">
                      没有在线设备
                    </Text>
                    <Text type="supporting">先登记一台设备并启动 daemon，才能导入这台机器上的仓库。</Text>
                  </VStack>
                  <Button label="登记设备" variant="primary" onClick={() => props.onAddDevice()} />
                </VStack>
              )
            ) : (
              <VStack gap={2} hAlign="stretch" style={{ height: "100%", minHeight: 0 }}>
                <div className="coflux-pathbar" onClick={() => pathInputRef.current?.focus()}>
                  <button type="button" className="coflux-pathbar__seg" title="/" onClick={() => jumpToSegment(-1)}>
                    /
                  </button>
                  {pathSegments.map((segment, index) => (
                    <span key={`${index}-${segment}`} style={{ display: "contents" }}>
                      {index > 0 ? <span className="coflux-pathbar__sep">/</span> : null}
                      <button type="button" className="coflux-pathbar__seg" title={segment} onClick={() => jumpToSegment(index)}>
                        {segment}
                      </button>
                    </span>
                  ))}
                  {pathSegments.length > 0 ? <span className="coflux-pathbar__sep">/</span> : null}
                  <input
                    ref={pathInputRef}
                    className="coflux-pathbar__input"
                    value={pathFilter}
                    onChange={(event) => {
                      setPathFilter(event.target.value);
                    }}
                    onKeyDown={onPathKeyDown}
                    placeholder="过滤…"
                    aria-label="过滤或进入文件夹"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>

                {error ? <Banner status="error" title={error} container="card" /> : null}

                {loading && entries.length === 0 ? (
                  <Text type="supporting">读取目录中…</Text>
                ) : filteredEntries.length > 0 ? (
                  <div
                    ref={listRef}
                    role="listbox"
                    aria-label="文件夹"
                    aria-busy={loading}
                    className="coflux-import-list"
                    style={loading ? { opacity: 0.55 } : undefined}
                  >
                    {filteredEntries.map((entry, index) => (
                      <button
                        key={entry.name}
                        type="button"
                        role="option"
                        aria-selected={index === highlight}
                        data-import-index={index}
                        className={`coflux-import-row${index === highlight ? " is-active" : ""}`}
                        onMouseEnter={() => setHighlight(index)}
                        onClick={() => enterFolder(entry.name)}
                      >
                        <span className="coflux-import-row__icon">
                          <Folder aria-hidden />
                        </span>
                        <Text type="body" className="coflux-import-row__name" maxLines={1}>
                          {entry.name}
                        </Text>
                      </button>
                    ))}
                  </div>
                ) : (
                  <Text type="supporting">
                    {loading ? "读取目录中…" : pathFilter.trim() ? "没有匹配的文件夹。" : "此目录下没有子文件夹。"}
                  </Text>
                )}
              </VStack>
            )}
          </LayoutContent>
        }
        footer={
          showDeviceFooter ? (
            <LayoutFooter hasDivider={false}>
              <HStack gap={2} hAlign="between" vAlign="center">
                <Text type="supporting">↑↓ 选择，Enter 进入</Text>
                <Button label="登记设备" variant="ghost" size="sm" onClick={() => props.onAddDevice()} />
              </HStack>
            </LayoutFooter>
          ) : showBrowseFooter ? (
            <LayoutFooter hasDivider={false}>
              <HStack gap={2} hAlign="between" vAlign="center">
                <Button label="上一步 Esc" variant="ghost" onClick={goToDeviceStep} />
                <Button label={`导入「${currentName}」 ⌘↵`} variant="primary" isDisabled={!canImport} onClick={importCurrent} />
              </HStack>
            </LayoutFooter>
          ) : undefined
        }
      />
    </Dialog>
  );
}
