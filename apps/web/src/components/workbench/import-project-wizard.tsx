import { useEffect, useRef, useState } from "react";
import { Folder, MonitorUp } from "lucide-react";
import { FsEntryKind, type DaemonInfo, type FsEntry } from "@coflux/protocol";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog } from "@astryxdesign/core/Dialog";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Selector } from "@astryxdesign/core/Selector";
import { Heading, Text } from "@astryxdesign/core/Text";

import type { FsListResult } from "@/client/store";

type ImportProjectWizardProps = {
  open: boolean;
  daemons: DaemonInfo[];
  onOpenChange: (open: boolean) => void;
  onImport: (daemonId: string, path: string) => void;
  onAddDevice: () => void;
  listDirectory: (daemonId: string, path: string) => Promise<FsListResult>;
};

/**
 * 导入项目两步向导（plan 012）：选设备 → 浏览该设备 home 下的文件树选文件夹。
 * 路径全程为 home 相对段（segments），导入时拼 "~/a/b" 交由 daemon 展开；
 * 选错非 git 目录由既有 ProjectValidate 报错兜底。
 */
export function ImportProjectWizard(props: ImportProjectWizardProps) {
  const onlineDaemons = props.daemons.filter((daemon) => daemon.online);
  const [step, setStep] = useState<"device" | "browse">("device");
  const [daemonId, setDaemonId] = useState("");
  const [segments, setSegments] = useState<string[]>([]);
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // 竞态防护：快速连点目录时只应用最后一次请求的结果
  const requestSeq = useRef(0);

  useEffect(() => {
    if (!props.open) return;
    setStep("device");
    setSegments([]);
    setEntries([]);
    setError("");
    setDaemonId((current) => (onlineDaemons.some((daemon) => daemon.daemonId === current) ? current : (onlineDaemons[0]?.daemonId ?? "")));
    // 与既有 ImportProjectDialog 语义一致：仅依赖 open/daemons。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, props.daemons]);

  async function loadDirectory(nextSegments: string[]) {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError("");
    const result = await props.listDirectory(daemonId, nextSegments.join("/"));
    if (seq !== requestSeq.current) return;
    setLoading(false);
    if (!result.ok) {
      setError(result.error || "读取目录失败");
      return;
    }
    setSegments(nextSegments);
    // 只展示非隐藏目录：导入目标是文件夹，隐藏目录（.git/.cache…）是噪音
    setEntries(result.entries.filter((entry) => entry.kind === FsEntryKind.DIR && !entry.name.startsWith(".")));
  }

  function startBrowse() {
    setStep("browse");
    void loadDirectory([]);
  }

  function importCurrent() {
    const path = segments.length > 0 ? `~/${segments.join("/")}` : "~";
    props.onImport(daemonId, path);
    props.onOpenChange(false);
  }

  const currentName = segments.length > 0 ? segments[segments.length - 1] : "~";

  return (
    <Dialog isOpen={props.open} onOpenChange={props.onOpenChange} width={520}>
      <VStack gap={4} hAlign="stretch">
        <VStack gap={1} hAlign="start">
          <Heading level={2}>导入项目</Heading>
          <Text type="body" color="secondary" size="sm">
            {step === "device" ? "第 1 步（共 2 步）：选择仓库所在的在线设备。" : "第 2 步（共 2 步）：在设备上选择 git 仓库文件夹。"}
          </Text>
        </VStack>

        {step === "device" ? (
          onlineDaemons.length > 0 ? (
            <VStack gap={4} hAlign="stretch">
              <Selector
                label="设备"
                options={onlineDaemons.map((daemon) => ({ value: daemon.daemonId, label: `${daemon.name} · ${daemon.host}` }))}
                value={daemonId}
                onChange={(value) => setDaemonId(value)}
                placeholder="选择在线设备"
              />
              <HStack gap={2} hAlign="end">
                <Button label="取消" variant="ghost" onClick={() => props.onOpenChange(false)} />
                <Button label="下一步" variant="primary" isDisabled={!daemonId} onClick={startBrowse} />
              </HStack>
            </VStack>
          ) : (
            <VStack gap={3} hAlign="center">
              <Icon icon={MonitorUp} size="md" />
              <VStack gap={1} hAlign="center">
                <Text type="body" weight="bold">
                  没有在线设备
                </Text>
                <Text type="body" color="secondary" size="sm">
                  先登记一台设备并启动 daemon，才能导入这台机器上的仓库。
                </Text>
              </VStack>
              <Button label="登记设备" variant="primary" onClick={() => props.onAddDevice()} />
            </VStack>
          )
        ) : (
          <VStack gap={3} hAlign="stretch">
            {/* 面包屑：~ / a / b，点任意一级跳回该层 */}
            <HStack gap={1} vAlign="center" wrap="wrap">
              <Button label="~" variant={segments.length === 0 ? "secondary" : "ghost"} size="sm" onClick={() => void loadDirectory([])} />
              {segments.map((segment, index) => (
                <HStack key={`${index}-${segment}`} gap={1} vAlign="center">
                  <Text type="body" color="secondary" size="sm">
                    /
                  </Text>
                  <Button
                    label={segment}
                    variant={index === segments.length - 1 ? "secondary" : "ghost"}
                    size="sm"
                    onClick={() => void loadDirectory(segments.slice(0, index + 1))}
                  />
                </HStack>
              ))}
            </HStack>

            {error ? <Banner status="error" title={error} container="card" /> : null}

            {loading ? (
              <Text type="body" color="secondary" size="sm">
                读取目录中…
              </Text>
            ) : entries.length > 0 ? (
              <List density="compact" hasDividers>
                {entries.map((entry) => (
                  <ListItem
                    key={entry.name}
                    label={entry.name}
                    startContent={<Icon icon={Folder} size="sm" />}
                    onClick={() => void loadDirectory([...segments, entry.name])}
                  />
                ))}
              </List>
            ) : (
              <Text type="body" color="secondary" size="sm">
                此目录下没有子文件夹。
              </Text>
            )}

            <HStack gap={2} hAlign="end">
              <Button label="上一步" variant="ghost" onClick={() => setStep("device")} />
              <Button label="取消" variant="ghost" onClick={() => props.onOpenChange(false)} />
              <Button label={`导入「${currentName}」`} variant="primary" isDisabled={loading || segments.length === 0} onClick={importCurrent} />
            </HStack>
          </VStack>
        )}
      </VStack>
    </Dialog>
  );
}
