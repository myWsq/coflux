#!/bin/bash
# iOS TestFlight 发版（无人值守）：归档 → 直传 App Store Connect。
# 签名走本机 Xcode 已登录账号会话（-allowProvisioningUpdates 自动建分发
# 证书/profile，2026-07-26 实测可无头完成）。
# 注意：ASC API 密钥（App Manager 角色）无云签名权限（实测报
# "Cloud signing permission error"），故签名不走 API 密钥；密钥留在
# ~/.appstoreconnect/private_keys/AuthKey_AXCQ537AP9.p8 供将来 ASC 元数据自动化。
# 构建号 = git 提交计数（单调递增；不改 pbxproj——工作区常驻本地签名改动不能碰）。
set -euo pipefail
cd "$(dirname "$0")"

BUILD_NUMBER=$(git rev-list --count HEAD)

# 原生传输框架不入库，归档前必须现构建，否则 xcodebuild 会在链接期才报缺文件。
echo "==> build native transport framework"
node ../../scripts/build-ios-transport.mjs

# SwiftTerm 带 Metal 着色器；Xcode 27 起 Metal Toolchain 是单独下载的组件，缺了归档只在
# 编译期报 "missing Metal Toolchain"（2026-10-09 实测）。首次缺失时自动补装（约 840MB）。
if ! xcrun metal -v >/dev/null 2>&1; then
  echo "==> download Metal Toolchain"
  xcodebuild -downloadComponent MetalToolchain
fi

WORK_DIR=$(mktemp -d)
ARCHIVE_PATH="$WORK_DIR/Coflux.xcarchive"
LOG="$WORK_DIR/xcodebuild.log"

echo "==> archive (build $BUILD_NUMBER)"
if ! xcodebuild archive \
  -project Coflux.xcodeproj -scheme Coflux \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE_PATH" \
  -allowProvisioningUpdates \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" >"$LOG" 2>&1; then
  tail -30 "$LOG" >&2
  echo "归档失败（完整日志: $LOG）" >&2
  exit 1
fi

echo "==> upload to App Store Connect"
if ! xcodebuild -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportOptionsPlist ExportOptions.plist \
  -allowProvisioningUpdates >"$LOG" 2>&1; then
  tail -30 "$LOG" >&2
  echo "上传失败（完整日志: $LOG）" >&2
  exit 1
fi

echo "==> 上传完成：build $BUILD_NUMBER"

# TestFlight distribution runs against the App Store Connect API and needs an issuer id the
# upload path does not; a failure here leaves the uploaded build intact and is rerunnable.
if ! node ./testflight-distribute.mjs --build "$BUILD_NUMBER"; then
  echo "" >&2
  echo "build $BUILD_NUMBER 已上传成功，只是 TestFlight 分发这一步失败。" >&2
  echo "修好上面的原因后单独重跑：node apps/ios/testflight-distribute.mjs --build $BUILD_NUMBER" >&2
  exit 1
fi
# dSYM 不随包上传（见 ExportOptions.plist 的 uploadSymbols 说明）：归档目录保留在这里，
# 需要符号化崩溃日志时从它手动上传。
echo "    dSYM: $ARCHIVE_PATH/dSYMs（归档保留在 $WORK_DIR）"
