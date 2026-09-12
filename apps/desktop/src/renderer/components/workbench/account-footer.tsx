import { useStore } from "zustand";
import { Avatar } from "@astryxdesign/core/Avatar";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu";
import { Kbd } from "@astryxdesign/core/Kbd";
import { HStack } from "@astryxdesign/core/Layout";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { ArrowUp, Cog, LogOut, RefreshCw } from "lucide-react";
import type { CofluxClient } from "@coflux/client";

import { accountIdentity, resolveAccountFooter } from "@/components/workbench/account-footer-view";
import { useDesktopUpdateState } from "@/components/workbench/use-desktop-update";
import { desktop } from "@/config";
import { cn } from "@/lib/utils";

/** 账号菜单定宽。跟着侧栏宽度走的话，侧栏拖宽菜单就跟着变成一大片空白。 */
const ACCOUNT_MENU_WIDTH = 200;

/**
 * 侧栏底部的账号脚部（plan 110，Cursor 左下角那一行）：头像 + 登录身份，尾部一个设置按钮。
 *
 * 身份只显示一行用户名。所连服务器不再挂在名字下面当副标题——它是设置项，挪进了设置页的「通用」，
 * 脚部因此收成单行，比原来矮一截。
 *
 * **整行仍然是账号菜单的触发按钮，但整行不做背景高亮**：ghost 按钮默认的整块 hover 底色横跨
 * 一整条，在侧栏底部显得又重又脏。这里把按钮自己的 hover/active 背景全部关掉，只留
 * `group-hover` 让用户名那几个字变色——点击范围一点没变，变的只是反馈的落点。
 *
 * 尾部的设置按钮是独立按钮（不是画在触发器内部的图标），因此有正常的按钮 hover 效果；它必须
 * `stopPropagation`，否则点它会顺带掀开账号菜单。设置页开着时它自己处于按下态，再点就是关掉——
 * 所以它和菜单里那一项都是 **toggle**，文案随状态改口，tooltip 与菜单项都带 ⌘,（这条键在
 * use-global-shortcuts 与应用菜单里都真的接着，macOS 的「偏好设置」惯例）。
 *
 * 只有「新版本已下载」时尾部换成强调色「更新」按钮，设置按钮让位——此时最该点的是更新。
 * 脚部**不**触发更新检查（见 use-desktop-update.ts）。
 */
export function AccountFooter({
  client,
  isSettingsOpen,
  onToggleSettings,
}: {
  client: CofluxClient;
  /** 设置页是否开着：决定齿轮的按下态与两处文案的口径 */
  isSettingsOpen: boolean;
  onToggleSettings: () => void;
}) {
  const loginName = useStore(client.store, (state) => state.loginName);
  const update = useDesktopUpdateState(desktop);

  const identity = accountIdentity(loginName);
  const view = resolveAccountFooter(update, desktop.version);
  const settingsLabel = isSettingsOpen ? "关闭设置" : "设置";

  return (
    <div className="flex shrink-0 items-center gap-1 border-t border-border px-2 py-1.5">
      <DropdownMenu
        placement="above"
        menuWidth={ACCOUNT_MENU_WIDTH}
        className="w-[200px]"
        hasChevron={false}
        button={{
          // children 覆盖可见内容，label 仍是无障碍名
          label: "账号菜单",
          variant: "ghost",
          // 背景三态全部压平。注意要压的是 **background-image**：astryx 的 ghost 按钮用
          // `linear-gradient(--color-overlay-hover, …)` 画 hover/active 的整块底色，不是
          // background-color，所以 bg-transparent 压不掉它，得用 bg-none。
          // （Tailwind 的 utilities 层排在 astryx-base 之后，见 index.css 的 @layer 声明。）
          className:
            "group h-auto min-w-0 flex-1 justify-start rounded-md px-1.5 py-1 text-left hover:bg-none active:bg-none aria-expanded:bg-none",
          children: (
            <span className="flex min-w-0 items-center gap-2">
              <Avatar name={identity.avatarName} size="xsmall" />
              <span className={identityClassName(identity.isPlaceholder)} title={identity.label}>
                {identity.label}
              </span>
            </span>
          ),
        }}
      >
        <DropdownMenuItem
          icon={<RefreshCw className="size-3.5" />}
          label={view.updateItem.label}
          description={view.updateItem.detail || undefined}
          isDisabled={view.updateItem.isDisabled}
          onClick={() => (view.updateItem.action === "install" ? desktop.installUpdate() : desktop.checkForUpdates())}
        />
        <DropdownMenuItem
          icon={<Cog className="size-3.5" />}
          label={settingsLabel}
          endContent={<Kbd keys="mod+," />}
          onClick={onToggleSettings}
        />
        <Divider />
        <DropdownMenuItem icon={<LogOut className="size-3.5" />} label="登出" onClick={() => { void desktop.logoutLocal().then((confirmed) => { if (confirmed) client.logout(false); }); }} />
      </DropdownMenu>

      {view.tail === "install" ? (
        <Button
          className="shrink-0"
          label="更新"
          tooltip={view.installHint}
          variant="primary"
          size="sm"
          icon={<ArrowUp className="size-3.5" />}
          onClick={() => desktop.installUpdate()}
        />
      ) : (
        <Tooltip
          content={
            <HStack gap={2} vAlign="center">
              <span>{settingsLabel}</span>
              <Kbd keys="mod+," />
            </HStack>
          }
        >
          <button
            aria-label={settingsLabel}
            aria-pressed={isSettingsOpen}
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-md transition-colors",
              isSettingsOpen
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
            onClick={(event) => {
              event.stopPropagation();
              onToggleSettings();
            }}
          >
            <Cog className="size-4" />
          </button>
        </Tooltip>
      )}
    </div>
  );
}

/** 身份未知时用更淡的字重提示这是占位，不是真名字。 */
function identityClassName(isPlaceholder: boolean): string {
  const base = "max-w-full truncate text-base transition-colors";
  return isPlaceholder
    ? `${base} text-muted-foreground group-hover:text-secondary-foreground`
    : `${base} text-secondary-foreground group-hover:text-foreground`;
}
