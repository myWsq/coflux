#!/bin/bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"

cd "$repo_root"

host_arch="$(uname -m)"
case "$host_arch" in
  arm64|x86_64) ;;
  *)
    echo "不支持的 macOS host architecture：$host_arch" >&2
    exit 1
    ;;
esac

cargo build -p coflux-supervisor -p coflux-worker -p coflux-relay

# UDP 的 App Sandbox 权限是双向的：client-only 必须在候选已生成、relay 仍健康的
# 前提下被阻断；加入 server entitlement 后，同一套完整 interop 必须通过。
for permission_variant in sandbox-network-client sandbox-network-client-server; do
  COFLUX_WEBRTC_PERMISSION_VARIANT="$permission_variant" \
    node --import tsx apps/macos/scripts/webrtc-worker-interop.mjs
done
