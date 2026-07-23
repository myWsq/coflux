import { useEffect } from "react";

/** iOS Safari 键盘弹出时 100dvh 不跟着收缩（dvh 只响应地址栏收放，不响应软键盘）；
 * 用 visualViewport.height 实时钳制根容器高度（写进 --app-vh CSS 变量），键盘弹出时
 * 终端与快捷键条随之上移，输入行不被遮挡。Android Chrome 靠 viewport meta 的
 * interactive-widget=resizes-content 已经处理，这里的监听对它是无害兜底
 * （该场景下 visualViewport.height 不会随软键盘变化，--app-vh 与 100dvh 恒等）。
 * 只需在应用根组件挂载一次。 */
export function useViewportHeight() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const apply = () => {
      document.documentElement.style.setProperty("--app-vh", `${viewport.height}px`);
    };
    apply();
    viewport.addEventListener("resize", apply);
    viewport.addEventListener("scroll", apply);
    return () => {
      viewport.removeEventListener("resize", apply);
      viewport.removeEventListener("scroll", apply);
      document.documentElement.style.removeProperty("--app-vh");
    };
  }, []);
}
