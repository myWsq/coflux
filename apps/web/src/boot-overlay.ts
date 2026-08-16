// 冷启动遮罩（plan 078）：index.html 里的裸 DOM 元素（#root 之外，createRoot 挂载不会清掉它），
// 由 React 在判据满足后经这里淡出移除。撤除判据（任一满足）：
//   - snapshotRevision > 0（首快照到达，workbench.tsx）；
//   - authState 进入 need-login / auth-failed（否则登录表单被遮罩挡住，workbench.tsx）；
//   - React 挂载 8 秒无条件撤（否则中心不可达时永久锁在 logo 页，App.tsx）。
// 重复调用安全：元素移除后 getElementById 返回 null。
export function dismissBootOverlay() {
  const overlay = document.getElementById("coflux-boot-overlay");
  if (!overlay) return;
  overlay.style.opacity = "0";
  overlay.style.pointerEvents = "none";
  window.setTimeout(() => overlay.remove(), 250);
}
