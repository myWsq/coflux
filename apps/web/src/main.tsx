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
        borderRadius: "var(--radius-element)",
        border: "1px solid var(--color-overlay-pressed)",
        boxShadow: "var(--shadow-high)",
        padding: "8px 10px",
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
