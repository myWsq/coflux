/**
 * 设置页的分区目录：有哪些分区、什么顺序、标题与说明各是什么。
 *
 * 纯数据 + 纯函数，与 account-footer-view.ts 同一做法：渲染层只管把它画出来，
 * 「默认分区一定存在」「未知 id 退回默认」这类约束由 node --test 守住，不散在 JSX 里。
 */

export type SettingsSectionId = "general" | "agents" | "archived-projects" | "machine" | "executor";

export type SettingsSection = {
  id: SettingsSectionId;
  /** 左栏导航项与右侧内容区共用的标题 */
  label: string;
  /** 右侧内容区标题下的一句说明（左栏不显示） */
  description: string;
  /** 同一组的分区在左栏里连着排，组与组之间空一行（照 Cursor 的分法） */
  group: number;
};

/**
 * 顺序即左栏的显示顺序：先账号所在的「通用」，再自成一组的「Agents」（plan 20261001-desktop-agents），
 * then 「已归档项目」 in a group of its own (plan 20261030-project-archive)，最后本机与 executor 这两项运行时设置。
 */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: "general",
    label: "通用",
    description: "当前账号连接的服务器，以及桌面版本与更新。",
    group: 0,
  },
  {
    id: "agents",
    label: "Agents",
    description: "在新建标签页菜单里直接启动的编码 agent，以及各自的启动命令。配置存在账号上，账号下的所有设备共用。",
    group: 1,
  },
  {
    id: "archived-projects",
    label: "已归档项目",
    description: "归档的项目不在侧栏里显示；可以在这里取消归档，或彻底删除。",
    group: 2,
  },
  {
    id: "machine",
    label: "这台 Mac",
    description: "本机运行组件的状态：终端在这台机器上由它拉起并保持在线。",
    group: 3,
  },
  {
    id: "executor",
    label: "Executor",
    description: "agent 甩给 coflux 执行的任务用哪个模型，以及对应的凭据。",
    group: 3,
  },
];

/** 左栏按组切开渲染，组间空一行；组内顺序就是 SETTINGS_SECTIONS 的顺序。 */
export function settingsSectionGroups(): SettingsSection[][] {
  const groups: SettingsSection[][] = [];
  for (const section of SETTINGS_SECTIONS) {
    const last = groups[groups.length - 1];
    if (last && last[0]!.group === section.group) last.push(section);
    else groups.push([section]);
  }
  return groups;
}

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = "general";

/**
 * 把一个可能来路不明的分区 id（历史状态、后续可能加的深链）解析成分区对象。
 * 认不出就退回默认分区——设置页永远有内容可画，不会白屏。
 */
export function resolveSettingsSection(id: string | null | undefined): SettingsSection {
  const found = SETTINGS_SECTIONS.find((section) => section.id === id);
  if (found) return found;
  const fallback = SETTINGS_SECTIONS.find((section) => section.id === DEFAULT_SETTINGS_SECTION);
  // SETTINGS_SECTIONS 是常量，默认分区必然在其中；这行只是让类型收敛，测试同时守住这个前提。
  if (!fallback) throw new Error(`默认设置分区 ${DEFAULT_SETTINGS_SECTION} 不在目录里`);
  return fallback;
}
