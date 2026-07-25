import { createRoot } from "react-dom/client";
import { Theme, defineTheme } from "@astryxdesign/core/theme";
import { LayerProvider } from "@astryxdesign/core/Layer";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";

import { App } from "./App";
import "./index.css";

// tooltip 全局样式：默认那版在深色面上贴得太紧、层次不足。照 Cursor 的做法——略微抬起的
// 卡片（popover 底色 + 高阴影 + 一道极淡的亮边把它从深色背景里剥出来），内容左对齐、留白
// 够站得下"标题 + 图标条目"两层。值全部走 token，不写死颜色。
const cofluxTheme = defineTheme({
  name: "coflux",
  extends: neutralTheme,
  components: {
    tooltip: {
      base: {
        backgroundColor: "var(--color-background-popover)",
        // 前景必须跟着背景一起改：默认 tooltip 在 dark 下是反色（浅底深字），只换底色
        // 会留下深底深字看不清——尤其那些没有自带文字类的 tooltip。
        color: "var(--color-text-primary)",
        // astryx 的 --font-size-base 是 14px，比本项目正文（--coflux-text-base 13px）还大
        // 一号，tooltip 作为附注不该比正文更响；退到 12px。
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

// 不启用 StrictMode：WS 单连接、xterm 实例、consumer 注册均为命令式资源，
// StrictMode 双挂载的排错成本没有回报（decided while planning，plan 011）。
// Astryx Theme 固定 dark：coflux 是深色优先的 IDE 工具面。
createRoot(document.getElementById("root")!).render(
  <Theme theme={cofluxTheme} mode="dark">
    {/* LayerProvider 让 useToast 走正规 viewport 并继承 dark 主题；缺它时 toast 自挂浅色兜底 viewport，定位与配色都不对。 */}
    <LayerProvider>
      <App />
    </LayerProvider>
  </Theme>,
);
