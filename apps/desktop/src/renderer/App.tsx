import { useEffect } from "react";

import { dismissBootOverlay } from "@/boot-overlay";
import { MainPage } from "@/pages/MainPage";

/** 桌面只承载工作台一条页面流；新机器授权 / OAuth 同意 / 端口预览门禁三张卫星页在系统浏览器里完成。 */
export function App({ initialToken }: { initialToken: string }) {
  // 遮罩兜底出口（plan 078）：中心不可达时不能把人永久锁在 logo 页——8 秒无条件撤，
  // 之后由既有的断线横幅/登录表单接管。
  useEffect(() => {
    const timer = window.setTimeout(dismissBootOverlay, 8000);
    return () => window.clearTimeout(timer);
  }, []);

  return <MainPage initialToken={initialToken} />;
}
