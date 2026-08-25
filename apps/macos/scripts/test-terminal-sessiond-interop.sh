#!/bin/bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"
snapshot_root="$(mktemp -d "${TMPDIR:-/tmp}/coflux-terminal-snapshots.XXXXXX")"

cleanup() {
  rm -rf "$snapshot_root"
}
trap cleanup EXIT

cd "$repo_root"

COFLUX_VT_EXPORT_DIR="$snapshot_root" \
  node --import tsx --test tests/src/local-first-vt-oracle.test.mjs

diff -ru tests/fixtures/terminal/snapshots "$snapshot_root"

COFLUX_VT_SNAPSHOT_DIR="$snapshot_root" \
  xcodebuild test \
    -project apps/macos/Coflux.xcodeproj \
    -scheme Coflux \
    -destination 'platform=macOS' \
    -only-testing:CofluxTests/TerminalFixtureCompatibilityTests
