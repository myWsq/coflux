import { createRoot } from "react-dom/client";
import { Theme, defineTheme } from "@astryxdesign/core/theme";
import { LayerProvider } from "@astryxdesign/core/Layer";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";

import { App } from "./App";
import { LEGACY_TOKEN_KEY, desktop } from "./config";
import { loadSessionToken } from "./session-token";
import "./index.css";

// tooltip 全局样式：默认那版在深色面上贴得太紧、层次不足。照 Cursor 的做法——略微抬起的
// 卡片（popover 底色 + 高阴影 + 一道极淡的亮边把它从深色背景里剥出来），内容左对齐、留白
// 够站得下"标题 + 图标条目"两层。值全部走 token，不写死颜色。
const cofluxTheme = defineTheme({
  name: "coflux",
  extends: neutralTheme,
  // 字阶与字体族：theme-neutral 是 14px + Figtree，本项目正文是 13px + Inter（--coflux-text-*，
  // 与 Tailwind 字阶同一份真相源，见 index.css）。两套并存的话，Astryx 组件的字会整体比手写的
  // 部分大一号——菜单、列表、设置页哪儿都对不上。
  //
  // 必须写在这里、而不是在 CSS 里覆盖：主题 token 由 Theme 运行时注入成
  // `@layer astryx-theme { @scope ([data-astryx-theme="coflux"]) … }`，位置在 index.css 之后，
  // 同层同特异性下后来者赢。曾经 index.css 里有一份同样的覆盖，作用域根写的是 `="neutral"`——
  // DOM 上的属性值是主题名 coflux，那份从来没匹配上，也就从来没生效过。
  tokens: {
    "--font-family-body": "var(--coflux-font-sans)",
    "--font-family-heading": "var(--coflux-font-sans)",
    "--font-family-code": "var(--coflux-font-mono)",
    "--font-size-2xs": "var(--coflux-text-2xs)",
    "--font-size-xs": "var(--coflux-text-xs)",
    "--font-size-sm": "var(--coflux-text-sm)",
    "--font-size-base": "var(--coflux-text-base)",
    "--font-size-lg": "var(--coflux-text-lg)",
    "--font-size-xl": "var(--coflux-text-xl)",
    "--font-size-2xl": "var(--coflux-text-2xl)",
    "--text-body-size": "var(--font-size-base)",
    "--text-label-size": "var(--font-size-base)",
    "--text-code-size": "var(--font-size-base)",
    "--text-supporting-size": "var(--font-size-sm)",
    "--text-large-size": "var(--font-size-lg)",
    "--text-heading-1-size": "var(--font-size-2xl)",
    "--text-heading-2-size": "var(--font-size-xl)",
    "--text-heading-3-size": "var(--font-size-lg)",
    "--text-heading-4-size": "var(--font-size-base)",
    "--text-heading-5-size": "var(--font-size-sm)",
    "--text-heading-6-size": "var(--font-size-xs)",
  },
  components: {
    tooltip: {
      base: {
        backgroundColor: "var(--color-background-popover)",
        // 前景必须跟着背景一起改：默认 tooltip 在 dark 下是反色（浅底深字），只换底色
        // 会留下深底深字看不清——尤其那些没有自带文字类的 tooltip。
        color: "var(--color-text-primary)",
        // tooltip 作为附注不该和正文一样响：退一档到 12px（--font-size-sm）。
        fontSize: "var(--font-size-sm)",
        borderRadius: "var(--radius-element)",
        boxShadow: "var(--shadow-high)",
        // padding 归零、不加边框，都是因为 Tooltip 是两层 DOM：.astryx-tooltip 是外层容器，
        // 真正裹住文字的是内层 div，后者自带 padding-top: --spacing-1 / padding-inline-start:
        // --spacing-2（4px / 8px，本来就合适）。在外层再给 padding 只会与内层叠加，越调越胖；
        // 而内层那份用 StyleX 的 `:not(#\#)` 堆到特异性 (0,5,0)，单类的 .astryx-tooltip
        // (0,1,0) 压根盖不掉——所以能做的只有别往上加。同理边框：默认没有，之前那道就是这里
        // 加出来的，去掉即可，深浅由 popover 底色与阴影区分足矣。
        padding: "0",
        borderWidth: "0",
        textAlign: "start",
      },
    },
  },
});

// 会话 token 先经桥接从主进程取回（plan 106：safeStorage 真相源，含一次性 localStorage 迁移），
// 再挂 React——createCofluxClient 创建时 token 必须已就绪。冷启动遮罩盖住这段等待。
async function boot(): Promise<void> {
  const initialToken = await loadSessionToken(desktop, localStorage, LEGACY_TOKEN_KEY);

  // 不启用 StrictMode：WS 单连接、xterm 实例、consumer 注册均为命令式资源，
  // StrictMode 双挂载的排错成本没有回报（decided while planning，plan 011）。
  // Astryx Theme 固定 dark：coflux 是深色优先的 IDE 工具面。
  createRoot(document.getElementById("root")!).render(
    <Theme theme={cofluxTheme} mode="dark">
      {/* LayerProvider 让 useToast 走正规 viewport 并继承 dark 主题；缺它时 toast 自挂浅色兜底 viewport，定位与配色都不对。 */}
      <LayerProvider>
        <App initialToken={initialToken} />
      </LayerProvider>
    </Theme>,
  );
}

void boot();
