import type { ReactNode } from "react";
import { Card } from "@astryxdesign/core/Card";
import { VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";

/**
 * 设置页的分组（照 Cursor / macOS 系统设置的排法）：一个灰色小标题 + 一张卡片，
 * 卡片里每条设置是一行「左边名字与说明、右边控件」，行与行之间一道分隔线。
 *
 * 行用 Astryx 的 ListItem：它本来就是 `startContent + label + description + endContent` 这个
 * 形状，控件塞进 endContent；卡片 padding 归零让列表边到边（密集数据不套内边距，见项目 Astryx 规则）。
 */
export function SettingsGroup({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <VStack gap={1.5} hAlign="stretch">
      {title ? <Text type="label" color="secondary">{title}</Text> : null}
      <Card padding={0} variant="muted" width="100%">
        <List hasDividers density="balanced">
          {children}
        </List>
      </Card>
    </VStack>
  );
}

/**
 * 一条设置行。`control` 放右边的开关 / 按钮 / 取值；纯展示的行不传即可。
 * 不接 onClick：整行可点会和行内的控件抢，Astryx 的 List 文档也明确不建议在可点行里再放可点元素。
 *
 * 横向内边距压过 Item 自带的 8–12px：那套间距是给下拉菜单、选择器里的密集条目用的，放到设置卡片里
 * 文字几乎贴着卡片边。加到 16px 才和 Cursor / 系统设置的设置行看齐。分隔线仍然边到边——padding
 * 在边框内沿，不影响 border 的宽度。
 */
export function SettingsRow({
  label,
  description,
  control,
}: {
  label: string;
  description?: ReactNode;
  control?: ReactNode;
}) {
  return <ListItem label={label} description={description} endContent={control} className="px-4 py-1" />;
}
