#!/bin/sh
# Release 使用显式版本准入标识；开发配置继续使用内存凭据与 dev 标识。
set -eu
[ "${CONFIGURATION:-}" = "Release" ] || exit 0
build_id=${COFLUX_BUILD_ID:-}
case "$build_id" in
  ''|dev|unreleased|*[!A-Za-z0-9._-]*)
    echo 'error: Release 必须设置 COFLUX_BUILD_ID（字母、数字、点、下划线或连字符；不能为 dev/unreleased）。' >&2
    exit 1
    ;;
esac
if [ "${#build_id}" -gt 128 ]; then
  echo 'error: COFLUX_BUILD_ID 长度不能超过 128 个 ASCII 字符。' >&2
  exit 1
fi
