import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./index.css";

// 不启用 StrictMode：WS 单连接、xterm 实例、consumer 注册均为命令式资源，
// StrictMode 双挂载的排错成本没有回报（decided while planning，plan 011）。
createRoot(document.getElementById("root")!).render(<App />);
