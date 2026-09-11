# coflux shell 集成（plan 115）：supervisor 用 `--init-file` 起 bash，这个文件顶替的正是
# **交互式非登录** bash 本来会读的那条链（supervisor 起的就是非登录交互 shell：
# CommandBuilder::new(shell)，argv[0] 不带前导 `-`，见 crates/supervisor/src/sessions.rs）。
# 所以这里先把那条链原样、按原顺序跑一遍，再做我们自己的事——不要顺手加 /etc/profile、
# ~/.bash_profile，那是登录 shell 的链，今天不会被读到，加了就是改语义。
# /etc/bash.bashrc 只在把它编进 SYS_BASHRC 的发行版上存在（Debian/Ubuntu/Arch），存在即代表
# 今天的 bash 本来也会读它；macOS 的 bash 没有这个文件，判断自然落空。
if [ -r /etc/bash.bashrc ]; then
  . /etc/bash.bashrc
fi
if [ -r "$HOME/.bashrc" ]; then
  . "$HOME/.bashrc"
fi
. @COFLUX_SHELL_INTEGRATION_DIR@/claude.sh
