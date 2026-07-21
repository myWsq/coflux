import { createRoot } from "react-dom/client";
import { Theme } from "@astryxdesign/core/theme";
import { LayerProvider } from "@astryxdesign/core/Layer";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";

import { App } from "./App";
import "./index.css";

// 不启用 StrictMode：WS 单连接、xterm 实例、consumer 注册均为命令式资源，
// StrictMode 双挂载的排错成本没有回报（decided while planning，plan 011）。
// Astryx Theme 固定 dark：coflux 是深色优先的 IDE 工具面。
createRoot(document.getElementById("root")!).render(
  <Theme theme={neutralTheme} mode="dark">
    {/* LayerProvider 让 useToast 走正规 viewport 并继承 dark 主题；缺它时 toast 自挂浅色兜底 viewport，定位与配色都不对。 */}
    <LayerProvider>
      <App />
    </LayerProvider>
  </Theme>,
);
