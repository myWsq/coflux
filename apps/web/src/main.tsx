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
        // 分开写而非 border 简写：简写在样式合并里容易被整体覆盖，拆开才保得住这 1px。
        // 颜色取 overlay-hover（5% 白）而非 pressed（10%）：这道边只是把卡片从深色背景里
        // 剥出来，不该被看成一个框——Retina 上 1px CSS 落成 2 物理像素，10% 已经显重。
        borderWidth: "1px",
        borderStyle: "solid",
        borderColor: "var(--color-overlay-hover)",
        boxShadow: "var(--shadow-high)",
        padding: "6px 8px",
        textAlign: "start",
        maxWidth: "300px",
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
