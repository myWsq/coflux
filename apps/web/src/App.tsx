import { AuthorizePage } from "@/pages/AuthorizePage";
import { MainPage } from "@/pages/MainPage";
import { ProxyAuthPage } from "@/pages/ProxyAuthPage";

/** 无路由 SPA 先按 pathname 选择组件树，三条页面流因此不会共享连接或副作用。 */
export function App() {
  const authorizeMatch = /^\/authorize\/([^/]+)\/?$/.exec(location.pathname);
  if (authorizeMatch) return <AuthorizePage token={decodeURIComponent(authorizeMatch[1])} />;
  if (location.pathname === "/proxy-auth") return <ProxyAuthPage />;
  return <MainPage />;
}
