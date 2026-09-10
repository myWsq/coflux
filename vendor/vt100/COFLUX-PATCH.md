# vt100 单行终端修复

基于 crates.io vt100 0.16.2，保留上游 LICENSE。唯一产品源码修改为 src/grid.rs 的 col_wrap：单行屏幕自动换行后，上一行可能已经滚入历史，不能对其行号无符号减法；保留历史行的 wrap 标记。

复现及回归在 crates/supervisor/src/sessiond.rs 的 single_row_terminal_wrap_does_not_panic。后续升级上游时，应核对该边界已修复后再移除本地补丁。
