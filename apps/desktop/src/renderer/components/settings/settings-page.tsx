import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Layout, LayoutContent, LayoutPanel, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Heading, Text } from "@astryxdesign/core/Text";
import { ArrowLeft, Bot, Monitor, Settings2, type LucideIcon } from "lucide-react";
import type { CofluxClient } from "@coflux/client";

import { ExecutorSection } from "@/components/settings/executor-section";
import { GeneralSection } from "@/components/settings/general-section";
import { MachineSection } from "@/components/settings/machine-section";
import {
  DEFAULT_SETTINGS_SECTION,
  resolveSettingsSection,
  settingsSectionGroups,
  type SettingsSectionId,
} from "@/components/settings/settings-nav";
import { AccountFooter, type SettingsTooltipControl } from "@/components/workbench/account-footer";
import { DESKTOP_DRAG_BAND_STYLE } from "@/components/workbench/drag-region";
import { SidebarResizeHandle } from "@/components/workbench/sidebar-resize-handle";
import type { SidebarWidthControl } from "@/components/workbench/use-sidebar-width";
import { desktop } from "@/config";
import type { DesktopDaemonState } from "@/desktop-bridge";

/**
 * 导航项与「返回」按钮的对齐口径：同高、同横向内边距、同字重。返回按钮是 Astryx Button（sm），
 * 导航项是 ListItem，两者默认规格不一样，不拉齐就会看出上下两块是两套东西。
 */
const SETTINGS_NAV_ITEM_CLASS = "h-7 px-3 py-0 font-medium";

/** 导航项图标：与分区一一对应，缺一个都会让那一行看起来是另一种东西。 */
const SECTION_ICONS: Record<SettingsSectionId, LucideIcon> = {
  general: Settings2,
  machine: Monitor,
  executor: Bot,
};

type SettingsPageProps = {
  client: CofluxClient;
  /** null = 还没拿到第一份本机状态 */
  daemonState: DesktopDaemonState | null;
  /** 本机运行中终端数（按 credentials.json 的 daemonId 匹配） */
  runningTerminals: number;
  /** 断线横幅占住了顶部 28px 时，整页要往下让，否则红绿灯与横幅打架 */
  hasTopBanner: boolean;
  onClose: () => void;
  /** 接入 / 授权 / FDA：先收起设置页，再打开接入引导对话框 */
  onOpenOnboarding: () => void;
  /** 与工作台侧栏共用的同一份宽度：设置页盖上来时侧栏不能突然变宽变窄 */
  widthControl: SidebarWidthControl;
  /** 齿轮 tooltip 的压制开关，与工作台那个脚部共用 */
  settingsTooltip: SettingsTooltipControl;
};

/**
 * 独立设置页：Astryx 的 Layout + 左侧 LayoutPanel 导航（官方 settings 范式，见
 * `astryx template LayoutSidebarLayout`），排法照 Cursor——左栏「返回」在最上、分组的带图标导航项
 * 在中间、账号行在最下；右栏是标题加若干「小标题 + 卡片」的设置组。
 *
 * **是覆盖层而不是页面切换**：终端面板按 task id 常驻挂载（见 workbench.tsx 的终端主区注释），
 * 把工作台换掉会连带卸载 xterm 实例、丢掉回放缓冲。覆盖层让底下那棵树原样活着，关掉设置页就回到
 * 原样的终端。
 *
 * 层级压在断线横幅（z-50）与错误吐司（z-40）之下：设置页开着的时候，中心断了仍然要看得见。
 *
 * 左栏与工作台侧栏是同一条侧栏的两副面孔：**同一份宽度 control**（见 use-sidebar-width.ts）、
 * 同一个拖拽手柄、同一个账号脚部。开设置页时侧栏既不跳宽，也不少掉底下那一行。
 *
 * 两个裸元素是有意为之，都不是布局用途：最外层那个只做 fixed 定位（Electron 窗口内的覆盖层锚点，
 * 设计系统不管窗口层），两条拖拽带是 `-webkit-app-region` 的载体，给红绿灯让位并让顶部能拖动窗口
 * （见 drag-region.ts；带内元素收不到指针事件，所以「返回」按钮放在带子下面而不是塞进去）。
 */
export function SettingsPage(props: SettingsPageProps) {
  const [sectionId, setSectionId] = useState<SettingsSectionId>(DEFAULT_SETTINGS_SECTION);
  const section = resolveSettingsSection(sectionId);
  const { onClose } = props;

  // Esc 退出设置页：设置页开着时终端收不到键盘焦点，不会和终端里的 Esc 抢。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [onClose]);

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 bg-background" style={{ top: props.hasTopBanner ? 28 : 0 }}>
      <Layout
        height="fill"
        start={
          <LayoutPanel
            role="navigation"
            label="设置分区"
            width={props.widthControl.width}
            padding={0}
            isScrollable={false}
            // 分隔线走 border-border 而不是 hasDivider：工作台侧栏用的就是这个 token，
            // 两条侧栏的右边框必须同色，否则一开设置页就看得出换了一条。
            className="relative flex h-full flex-col border-r border-border bg-sidebar text-base"
          >
            <div className="shrink-0" style={DESKTOP_DRAG_BAND_STYLE} />
            {/* 导航区吃掉剩余高度，把账号脚部顶到底——和工作台侧栏同一个做法（那边是
                flex-1 的滚动区 + shrink-0 的脚部）。 */}
            <VStack gap={3} hAlign="stretch" padding={2} isScrollable className="min-h-0 flex-1">
              {/* 靠左对齐：撑满一栏宽的按钮把「返回」摆在正中，和它下面左对齐的分区列表对不上。 */}
              <Button
                label="返回"
                variant="ghost"
                size="sm"
                icon={<ArrowLeft className="size-4" />}
                className="justify-start"
                onClick={onClose}
              />
              {settingsSectionGroups().map((group) => (
                <List key={group[0]!.id} density="compact">
                  {group.map((item) => {
                    const Icon = SECTION_ICONS[item.id];
                    return (
                      <ListItem
                        key={item.id}
                        label={item.label}
                        startContent={<Icon className="size-4 shrink-0" />}
                        isSelected={item.id === section.id}
                        onClick={() => setSectionId(item.id)}
                        // 逐项对齐上面那颗「返回」按钮：28px 高（--size-element-sm）、12px 横向
                        // 内边距（--spacing-3）、medium 字重。Item 自己那套是 8px 内边距、常规字重，
                        // 排在按钮下面一眼就能看出文字起点差了 4px。图标两边都是 16px，不用动。
                        className={SETTINGS_NAV_ITEM_CLASS}
                      />
                    );
                  })}
                </List>
              ))}
            </VStack>
            {/* 账号脚部与工作台侧栏是同一个组件：设置页开着的时候，左下角那一行不该凭空消失。
                这里齿轮处于按下态，再点就是关掉设置页——和 ⌘, 同一个开关语义。 */}
            <AccountFooter
              client={props.client}
              isSettingsOpen
              onToggleSettings={onClose}
              tooltipControl={props.settingsTooltip}
            />
            <SidebarResizeHandle control={props.widthControl} />
          </LayoutPanel>
        }
        content={
          <LayoutContent padding={0}>
            {/* 右侧同高的拖拽带：设置页没有 tab 栏，这条带子让整页顶部都能拖动窗口。 */}
            <div style={DESKTOP_DRAG_BAND_STYLE} />
            {/* 内容列居中并留出余量：设置项贴着左栏排会显得挤，宽窗口下更明显。 */}
            <VStack gap={6} hAlign="stretch" padding={8} maxWidth={860} className="mx-auto">
              <VStack gap={1} hAlign="stretch">
                <Heading level={3}>{section.label}</Heading>
                <Text type="supporting">{section.description}</Text>
              </VStack>

              {section.id === "general" ? <GeneralSection client={props.client} /> : null}
              {section.id === "machine" ? (
                props.daemonState ? (
                  <MachineSection
                    state={props.daemonState}
                    runningTerminals={props.runningTerminals}
                    bridge={desktop}
                    onOpenOnboarding={props.onOpenOnboarding}
                  />
                ) : (
                  <Text type="supporting">正在读取本机状态…</Text>
                )
              ) : null}
              {section.id === "executor" ? <ExecutorSection bridge={desktop} /> : null}
            </VStack>
          </LayoutContent>
        }
      />
    </div>
  );
}
