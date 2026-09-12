/** 更新安装是一次生命周期切换：双击合并，取消可重试，失败恢复主应用的退出拦截。 */
export function createUpdateInstaller(options: {
  beforeInstall: () => Promise<boolean>;
  install: () => void;
  onError: (error: unknown) => void;
}) {
  let active = false;
  function failed(error: unknown): void {
    if (!active) return;
    active = false;
    options.onError(error);
  }
  return {
    failed,
    async install(): Promise<void> {
      if (active) return;
      active = true;
      try {
        if (!await options.beforeInstall()) { active = false; return; }
        options.install();
      } catch (error) { failed(error); }
    },
  };
}
