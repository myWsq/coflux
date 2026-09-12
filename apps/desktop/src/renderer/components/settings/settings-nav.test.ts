import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_SECTIONS,
  resolveSettingsSection,
  settingsSectionGroups,
} from "./settings-nav";

test("默认分区在目录里，且解析空值时退回它", () => {
  assert.ok(SETTINGS_SECTIONS.some((section) => section.id === DEFAULT_SETTINGS_SECTION));
  assert.equal(resolveSettingsSection(null).id, DEFAULT_SETTINGS_SECTION);
  assert.equal(resolveSettingsSection(undefined).id, DEFAULT_SETTINGS_SECTION);
  assert.equal(resolveSettingsSection("").id, DEFAULT_SETTINGS_SECTION);
});

test("认不出的分区 id 不抛错，退回默认分区", () => {
  assert.equal(resolveSettingsSection("nope").id, DEFAULT_SETTINGS_SECTION);
});

test("已知分区按 id 原样取回", () => {
  for (const section of SETTINGS_SECTIONS) {
    assert.equal(resolveSettingsSection(section.id).id, section.id);
  }
});

test("每个分区都有非空标题与说明，id 不重复", () => {
  const ids = new Set<string>();
  for (const section of SETTINGS_SECTIONS) {
    assert.ok(section.label.trim().length > 0, `${section.id} 缺标题`);
    assert.ok(section.description.trim().length > 0, `${section.id} 缺说明`);
    assert.equal(ids.has(section.id), false, `${section.id} 重复`);
    ids.add(section.id);
  }
});

test("分组保留原顺序、不丢分区，同组的连在一起", () => {
  const groups = settingsSectionGroups();
  assert.deepEqual(
    groups.flat().map((section) => section.id),
    SETTINGS_SECTIONS.map((section) => section.id),
  );
  for (const group of groups) {
    assert.ok(group.length > 0);
    assert.equal(new Set(group.map((section) => section.group)).size, 1);
  }
  // 相邻两组的组号必须不同，否则本该连着排的被空行劈开了。
  for (let i = 1; i < groups.length; i += 1) {
    assert.notEqual(groups[i - 1]![0]!.group, groups[i]![0]!.group);
  }
});
