import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Layout, LayoutContent, LayoutPanel, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Heading, Text } from "@astryxdesign/core/Text";
import { ArrowLeft } from "lucide-react";
import type { CofluxClient } from "@coflux/client";

import { ExecutorSection } from "@/components/settings/executor-section";
import { GeneralSection } from "@/components/settings/general-section";
import { MachineSection } from "@/components/settings/machine-section";
import {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_SECTIONS,
  resolveSettingsSection,
  type SettingsSectionId,
} from "@/components/settings/settings-nav";
import { DESKTOP_DRAG_BAND_STYLE } from "@/components/workbench/drag-region";
import { SidebarResizeHandle } from "@/components/workbench/sidebar-resize-handle";
import type { SidebarWidthControl } from "@/components/workbench/use-sidebar-width";
import { desktop } from "@/config";
import type { DesktopDaemonState } from "@/desktop-bridge";

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
};

/**
 * 独立设置页：Astryx 的 Layout + 左侧 LayoutPanel 导航（官方 settings 范式，见
 * `astryx template LayoutSidebarLayout`），整页覆盖在工作台之上。
 *
 * **是覆盖层而不是页面切换**：终端面板按 task id 常驻挂载（见 workbench.tsx 的终端主区注释），
 * 把工作台换掉会连带卸载 xterm 实例、丢掉回放缓冲。覆盖层让底下那棵树原样活着，关掉设置页就回到
 * 原样的终端。
 *
 * 层级压在断线横幅（z-50）与错误吐司（z-40）之下：设置页开着的时候，中心断了仍然要看得见。
 *
 * 左栏宽度与工作台侧栏是**同一份** control（见 use-sidebar-width.ts），拖拽手柄也是同一个组件：
 * 设置页盖上来时侧栏既不会跳宽也不会跳窄，在这儿拖完回到工作台也还是这个宽度。
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
            // 分隔线走 border-border 而不是 hasDivider：工作台侧栏用的就是这个 token，
            // 两条侧栏的右边框必须同色，否则一开设置页就看得出换了一条。
            className="relative border-r border-border bg-sidebar text-base"
          >
            <div style={DESKTOP_DRAG_BAND_STYLE} />
            <VStack gap={1} hAlign="stretch" padding={2}>
              <Button label="返回" variant="ghost" size="sm" icon={<ArrowLeft className="size-4" />} onClick={onClose} />
              <List density="compact">
                {SETTINGS_SECTIONS.map((item) => (
                  <ListItem
                    key={item.id}
                    label={item.label}
                    isSelected={item.id === section.id}
                    onClick={() => setSectionId(item.id)}
                  />
                ))}
              </List>
            </VStack>
            <SidebarResizeHandle control={props.widthControl} />
          </LayoutPanel>
        }
        content={
          <LayoutContent padding={0}>
            {/* 右侧同高的拖拽带：设置页没有 tab 栏，这条带子让整页顶部都能拖动窗口。 */}
            <div style={DESKTOP_DRAG_BAND_STYLE} />
            <VStack gap={5} hAlign="stretch" padding={6}>
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
