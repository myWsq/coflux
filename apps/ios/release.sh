#!/bin/bash
# iOS TestFlight release (unattended): archive -> upload to App Store Connect -> distribute.
# The single iOS release procedure, run by hand on a Mac and by .github/workflows/ios-release.yml.
#
# Signing, two modes, both with -allowProvisioningUpdates (Xcode creates the distribution
# certificate/profile itself; no certificate is stored anywhere):
# - App Store Connect API key, when ASC_KEY_ID, ASC_ISSUER_ID and the key file are all present
#   (ASC_KEY_PATH, default ~/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8). The key
#   must have the Admin role: an App Manager key has no cloud-signing permission (observed:
#   "Cloud signing permission error"). This is how CI signs.
# - Otherwise the Xcode account session logged in on this Mac (headless, observed 2026-07-26).
#   The local App Manager key (~/.appstoreconnect/private_keys/AuthKey_AXCQ537AP9.p8) then
#   serves only testflight-distribute.mjs.
# testflight-distribute.mjs reads the key only from ~/.appstoreconnect/private_keys/, so a custom
# ASC_KEY_PATH signs but does not distribute.
#
# Build number = git commit count (monotonic; the pbxproj is never touched: the working tree
# carries local signing edits that must stay out of it).
#
# --distribute-only: skip the transport build, archive and upload, and only distribute the build
# whose number is the current commit count (a rerun after a distribution failure never re-uploads).
set -euo pipefail
cd "$(dirname "$0")"

DISTRIBUTE_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --distribute-only) DISTRIBUTE_ONLY=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

BUILD_NUMBER=$(git rev-list --count HEAD)

distribute() {
  # TestFlight distribution runs against the App Store Connect API and needs an issuer id the
  # upload path does not; a failure here leaves the uploaded build intact and is rerunnable.
  if ! node ./testflight-distribute.mjs --build "$BUILD_NUMBER"; then
    echo "" >&2
    echo "build $BUILD_NUMBER is uploaded; only the TestFlight distribution step failed." >&2
    echo "Fix the cause above, then rerun just that step: apps/ios/release.sh --distribute-only" >&2
    echo "(or node apps/ios/testflight-distribute.mjs --build $BUILD_NUMBER)" >&2
    exit 1
  fi
}

if [ "$DISTRIBUTE_ONLY" = 1 ]; then
  echo "==> distribute only (build $BUILD_NUMBER)"
  distribute
  exit 0
fi

# Signing arguments shared by archive and export. The key id and issuer id are never printed.
AUTH_ARGS=()
ASC_KEY_FILE="${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID:-}.p8}"
if [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ] && [ -f "$ASC_KEY_FILE" ]; then
  echo "==> signing with the App Store Connect API key"
  AUTH_ARGS=(
    -authenticationKeyPath "$ASC_KEY_FILE"
    -authenticationKeyID "$ASC_KEY_ID"
    -authenticationKeyIssuerID "$ASC_ISSUER_ID"
  )
else
  echo "==> signing with the Xcode account session"
fi

# The native transport framework is not committed; it must be built before archiving, or
# xcodebuild only reports the missing file at link time.
echo "==> build native transport framework"
node ../../scripts/build-ios-transport.mjs

# SwiftTerm ships Metal shaders; since Xcode 27 the Metal Toolchain is a separate download, and
# without it the archive fails only at compile time with "missing Metal Toolchain" (observed
# 2026-10-09). Install it on first absence (about 840 MB).
if ! xcrun metal -v >/dev/null 2>&1; then
  echo "==> download Metal Toolchain"
  xcodebuild -downloadComponent MetalToolchain
fi

WORK_DIR=$(mktemp -d)
ARCHIVE_PATH="$WORK_DIR/Coflux.xcarchive"
LOG="$WORK_DIR/xcodebuild.log"

echo "==> archive (build $BUILD_NUMBER)"
# SwiftTerm 1.99+ carries the build plugin SwiftTermBuildInfoPlugin (version/terminfo info); a
# command-line build must skip plugin trust confirmation, or the archive fails at Validate plug-in.
# The ${AUTH_ARGS[@]+...} form keeps an empty array legal under set -u in macOS's bash 3.2.
if ! xcodebuild archive \
  -project Coflux.xcodeproj -scheme Coflux \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE_PATH" \
  -allowProvisioningUpdates \
  ${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"} \
  -skipPackagePluginValidation \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" >"$LOG" 2>&1; then
  tail -30 "$LOG" >&2
  echo "archive failed (full log: ${LOG})" >&2
  exit 1
fi

echo "==> upload to App Store Connect"
if ! xcodebuild -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportOptionsPlist ExportOptions.plist \
  -allowProvisioningUpdates \
  ${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"} >"$LOG" 2>&1; then
  tail -30 "$LOG" >&2
  echo "upload failed (full log: ${LOG})" >&2
  exit 1
fi

echo "==> uploaded: build $BUILD_NUMBER"

distribute
# dSYMs are not uploaded with the build (see the uploadSymbols note in ExportOptions.plist): the
# archive stays here; upload its symbols by hand when a crash log needs symbolication.
echo "    dSYM: ${ARCHIVE_PATH}/dSYMs (archive kept in ${WORK_DIR})"
