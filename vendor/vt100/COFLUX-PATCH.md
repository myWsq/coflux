# vt100 single-row terminal fix

Based on vt100 0.16.2 from crates.io, retaining the upstream LICENSE. The only production-source change is to `col_wrap` in `src/grid.rs`: after a single-row screen wraps automatically, the preceding row may already have moved into history. Avoid unsigned subtraction on its row index and preserve the historical row's wrap flag.

The reproduction and regression test is `single_row_terminal_wrap_does_not_panic` in `crates/supervisor/src/sessiond.rs`. When upgrading upstream, verify that this edge case has been fixed before removing the local patch.
