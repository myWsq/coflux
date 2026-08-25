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

xcodebuild test \
  -project apps/macos/Coflux.xcodeproj \
  -scheme Coflux \
  -destination "platform=macOS,arch=$host_arch" \
  -only-testing:CofluxTests/NativeWebRTCFramingTests

"$script_dir/verify-webrtc-slices.sh"

node --import tsx apps/macos/scripts/webrtc-worker-interop.mjs
