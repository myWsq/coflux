# Terminal ANSI fixtures

这三份 fixture 是二进制安全的 base64 ANSI 录制，供独立 xterm.js oracle 回放；可见内容已经
替换成固定假路径、假文件名和无业务含义的文本，未保留账号、token、prompt、仓库内容或模型对话。

- `claude-cli.json`：按 Claude Code 2.1.220 的空项目交互布局脱敏，保留正常屏/alternate
  screen、持续 tool 输出、状态栏和 resize 的控制序列形态。
- `codex-cli.json`：按 Codex CLI 0.145.0 的空项目交互/patch review 布局脱敏，保留 diff
  颜色、normal↔alternate 切换、长行和 resize。
- `tui-vim.json`：按 Vim 9 的临时无敏感文件会话脱敏，保留全屏 TUI、光标寻址、宽字和样式。

录制只保留发布契约内的 Unicode 宽字/组合字、逻辑行与 wrap、cursor 位置/可见性、正常/备用
屏、application cursor/keypad、bracketed paste、16/256/RGB 色与 bold/dim/italic/underline/
inverse。文本替换后逐段回放并在 barrier 处 resize；`player.mjs` 不连接外网、不读取 fixture
目录以外的用户数据。

`snapshots/*.json` 是同一份语料经真实 Rust sessiond 生成的固定 ANSI snapshot。可用
`COFLUX_VT_EXPORT_DIR=<dir> node --import tsx --test tests/src/local-first-vt-oracle.test.mjs`
重新导出。（曾另有 macOS SwiftTerm 结构化比较门消费同一语料，已随 plan 087 撤回。）
