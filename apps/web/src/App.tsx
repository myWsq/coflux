import { AuthorizePage } from "@/pages/AuthorizePage";
import { MainPage } from "@/pages/MainPage";
import { ProxyAuthPage } from "@/pages/ProxyAuthPage";
import { useEffect } from "react";

import { dismissBootOverlay } from "@/boot-overlay";

/** 无路由 SPA 先按 pathname 选择组件树，三条页面流因此不会共享连接或副作用。 */
export function App() {
  // 遮罩兜底出口（plan 078）：中心不可达时不能把人永久锁在 logo 页——8 秒无条件撤，
  // 之后由既有的断线横幅/登录表单接管。挂在 App 层是为了覆盖非工作台页面流。
  useEffect(() => {
    const timer = window.setTimeout(dismissBootOverlay, 8000);
    return () => window.clearTimeout(timer);
  }, []);

  const authorizeMatch = /^\/authorize\/([^/]+)\/?$/.exec(location.pathname);
  if (authorizeMatch) return <AuthorizePage token={decodeURIComponent(authorizeMatch[1])} />;
  if (location.pathname === "/proxy-auth") return <ProxyAuthPage />;
  return <MainPage />;
}
