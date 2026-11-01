import { useStore } from "zustand";

import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { isProjectArchived, type CofluxClient } from "@coflux/client";
import type { Project } from "@coflux/protocol";

import { SettingsGroup, SettingsRow } from "@/components/settings/settings-group";

const OUTDATED_HINT = "当前连接的服务器版本较旧，不支持归档项目；升级服务器后才能在这里管理。";

/**
 * Settings → 「已归档项目」 (plan 20261030-project-archive): every archived project of the account,
 * newest archive first, each with 取消归档 (back to the sidebar) and 删除 (the workbench's own
 * removal confirm dialog). Deleting may still be refused, e.g. for an offline device with worktrees;
 * that refusal is the centre's existing error, so nothing here promises otherwise.
 */
export function ArchivedProjectsSection({
  client,
  onRemoveProject,
}: {
  client: CofluxClient;
  onRemoveProject: (project: Project) => void;
}) {
  const supported = useStore(client.store, (state) => state.projectArchiveSupported);
  const projects = useStore(client.store, (state) => state.projects);
  const daemons = useStore(client.store, (state) => state.daemons);

  if (!supported) return <Text type="supporting">{OUTDATED_HINT}</Text>;

  const archived = projects
    .filter(isProjectArchived)
    .sort((left, right) => (right.archivedAt ?? 0) - (left.archivedAt ?? 0));
  if (archived.length === 0) return <Text type="supporting">没有已归档的项目</Text>;

  return (
    <SettingsGroup>
      {archived.map((project) => {
        const daemon = daemons.find((item) => item.daemonId === project.daemonId);
        const archivedOn = new Date(project.archivedAt ?? 0).toLocaleDateString("zh-CN");
        return (
          <SettingsRow
            key={project.id}
            label={project.name}
            description={`${daemon?.name ?? "设备记录缺失"} · ${project.repoPath} · 归档于 ${archivedOn}`}
            control={
              <HStack gap={2} vAlign="center">
                <Button label="取消归档" variant="secondary" size="sm" onClick={() => client.setProjectArchived(project.id, false)} />
                <Button label="删除" variant="destructive" size="sm" onClick={() => onRemoveProject(project)} />
              </HStack>
            }
          />
        );
      })}
    </SettingsGroup>
  );
}
