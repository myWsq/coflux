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

development_team="${COFLUX_MACOS_DEVELOPMENT_TEAM:-8Y2J55823C}"
signing_identity="${COFLUX_MACOS_SIGNING_IDENTITY:-Apple Development}"

cargo build -p coflux-supervisor -p coflux-worker -p coflux-relay

xcodebuild test \
  -quiet \
  -project apps/macos/Coflux.xcodeproj \
  -scheme Coflux \
  -destination "platform=macOS,arch=$host_arch" \
  -only-testing:CofluxTests/NativeIdentityTests \
  "DEVELOPMENT_TEAM=$development_team" \
  "CODE_SIGN_IDENTITY=$signing_identity" \
  ENABLE_HARDENED_RUNTIME=YES

node --import tsx apps/macos/scripts/loopback-auth-interop.mjs
