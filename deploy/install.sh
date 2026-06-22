#!/usr/bin/env sh
# coflux daemon 安装器：把 Rust daemon（supervisor + worker）装成系统服务，
# 由 systemd(Linux user service) / launchd(macOS LaunchAgent) 拉起、崩溃自启。
# 系统只需看护 supervisor —— worker 由 supervisor 自己起/管/重启。
#
# 用法：
#   deploy/install.sh --server ws://HOST:8787/daemon --enroll-key KEY [--name NAME] [--prefix DIR]
#   deploy/install.sh --uninstall
# 选项：
#   --skip-build   不 cargo build，用已有 target/release 产物
#   --no-start     只装文件，不 enable/start（用于检查生成结果）
set -eu

SERVER="ws://localhost:8787/daemon"
ENROLL_KEY=""
DEVICE_NAME="$(hostname 2>/dev/null || echo coflux-daemon)"
PREFIX="$HOME/.local"
COFLUX_HOME="${COFLUX_HOME:-$HOME/.coflux}"
DO_BUILD=1
DO_START=1
UNINSTALL=0

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="$2"; shift 2 ;;
    --enroll-key) ENROLL_KEY="$2"; shift 2 ;;
    --name) DEVICE_NAME="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --skip-build) DO_BUILD=0; shift ;;
    --no-start) DO_START=0; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage; exit 1 ;;
  esac
done

OS="$(uname -s)"
SYSTEMD_UNIT="$HOME/.config/systemd/user/coflux-daemon.service"
LAUNCHD_PLIST="$HOME/Library/LaunchAgents/com.coflux.daemon.plist"
WRAPPER="$COFLUX_HOME/run-daemon.sh"
ENV_FILE="$COFLUX_HOME/daemon.env"

if [ "$UNINSTALL" -eq 1 ]; then
  case "$OS" in
    Linux)
      systemctl --user disable --now coflux-daemon.service 2>/dev/null || true
      rm -f "$SYSTEMD_UNIT"
      systemctl --user daemon-reload 2>/dev/null || true
      ;;
    Darwin)
      launchctl unload "$LAUNCHD_PLIST" 2>/dev/null || true
      rm -f "$LAUNCHD_PLIST"
      ;;
  esac
  rm -f "$WRAPPER" "$ENV_FILE"
  echo "已卸载服务（保留二进制与凭证 $COFLUX_HOME/credentials.json）。"
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ "$DO_BUILD" -eq 1 ]; then
  echo "构建 release 二进制…"
  ( cd "$ROOT" && cargo build --release -p coflux-supervisor -p coflux-worker )
fi
SUP_SRC="$ROOT/target/release/coflux-supervisor"
WRK_SRC="$ROOT/target/release/coflux-worker"
[ -x "$SUP_SRC" ] || { echo "缺少 $SUP_SRC（先构建？）" >&2; exit 1; }
[ -x "$WRK_SRC" ] || { echo "缺少 $WRK_SRC" >&2; exit 1; }

# 安装二进制
BIN_DIR="$PREFIX/bin"
mkdir -p "$BIN_DIR"
install -m 0755 "$SUP_SRC" "$BIN_DIR/coflux-supervisor"
install -m 0755 "$WRK_SRC" "$BIN_DIR/coflux-worker"
SUP_BIN="$BIN_DIR/coflux-supervisor"
WRK_BIN="$BIN_DIR/coflux-worker"

# 配置目录 + env 文件（600）
mkdir -p "$COFLUX_HOME"
chmod 700 "$COFLUX_HOME"
[ -n "$ENROLL_KEY" ] || echo "警告：未提供 --enroll-key（仅当 $COFLUX_HOME/credentials.json 已存在、可直接认证时才行）" >&2
umask 077
cat > "$ENV_FILE" <<EOF
COFLUX_SERVER=$SERVER
COFLUX_ENROLL_KEY=$ENROLL_KEY
COFLUX_DEVICE_NAME=$DEVICE_NAME
COFLUX_HOME=$COFLUX_HOME
COFLUX_WORKER_CMD=$WRK_BIN
COFLUX_WORKER_ARGS=[]
EOF
chmod 600 "$ENV_FILE"

# wrapper：source env 后 exec supervisor（systemd/launchd 共用，密钥只存 env 文件）
cat > "$WRAPPER" <<EOF
#!/bin/sh
set -a
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
set +a
exec "$SUP_BIN"
EOF
chmod 700 "$WRAPPER"

case "$OS" in
  Linux)
    mkdir -p "$(dirname "$SYSTEMD_UNIT")"
    cat > "$SYSTEMD_UNIT" <<EOF
[Unit]
Description=coflux daemon (supervisor)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$WRAPPER
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF
    echo "已写入 systemd 用户单元: $SYSTEMD_UNIT"
    if [ "$DO_START" -eq 1 ]; then
      systemctl --user daemon-reload
      systemctl --user enable --now coflux-daemon.service
      echo "已 enable + start。开机自启（无需登录）需: loginctl enable-linger $USER"
    fi
    ;;
  Darwin)
    mkdir -p "$(dirname "$LAUNCHD_PLIST")"
    cat > "$LAUNCHD_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.coflux.daemon</string>
  <key>ProgramArguments</key>
  <array><string>$WRAPPER</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$COFLUX_HOME/daemon.log</string>
  <key>StandardErrorPath</key><string>$COFLUX_HOME/daemon.log</string>
</dict>
</plist>
EOF
    echo "已写入 launchd LaunchAgent: $LAUNCHD_PLIST"
    if [ "$DO_START" -eq 1 ]; then
      launchctl unload "$LAUNCHD_PLIST" 2>/dev/null || true
      launchctl load "$LAUNCHD_PLIST"
      echo "已 load（登录时自启 + 崩溃保活）。"
    fi
    ;;
  *)
    echo "不支持的系统: $OS —— 已生成 env/wrapper，但未安装系统服务。" >&2
    ;;
esac

echo "完成。二进制: ${SUP_BIN}, ${WRK_BIN}; 配置: ${ENV_FILE}"
