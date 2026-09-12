# Terminal ANSI fixtures

These three fixtures are binary-safe base64 ANSI recordings for the independent xterm.js oracle. Visible contents have been replaced with fixed fictional paths, filenames, and text without business meaning. No accounts, tokens, prompts, repository contents, or model conversations are retained.

- `claude-cli.json`: sanitized from Claude Code 2.1.220's empty-project interaction layout, retaining control-sequence patterns for normal/alternate screens, ongoing tool output, status bars, and resizing.
- `codex-cli.json`: sanitized from Codex CLI 0.145.0's empty-project interaction/patch-review layout, retaining diff colors, normal/alternate switching, long lines, and resizing.
- `tui-vim.json`: sanitized from a Vim 9 session with temporary, nonsensitive files, retaining full-screen TUI behavior, cursor addressing, wide characters, and styling.

Recordings retain only the release-contract features: wide/combining Unicode, logical lines and wrapping, cursor position/visibility, normal/alternate screens, application cursor/keypad, bracketed paste, 16/256/RGB colors, and bold/dim/italic/underline/inverse. After text replacement, segments are replayed with resizing at barriers. `player.mjs` neither connects externally nor reads user data outside the fixture directory.

`snapshots/*.json` contains fixed ANSI snapshots generated from the same corpus by real Rust sessiond. Re-export with `COFLUX_VT_EXPORT_DIR=<dir> node --import tsx --test tests/src/local-first-vt-oracle.test.mjs`. A former macOS SwiftTerm structural-comparison gate consumed the same corpus; it was withdrawn with plan 087.
