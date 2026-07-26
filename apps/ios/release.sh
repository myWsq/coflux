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

echo "==> done: build $BUILD_NUMBER 已上传，ASC 处理完（约 10-30 分钟）即出现在 TestFlight"
