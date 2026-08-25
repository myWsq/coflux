#!/bin/bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"
project="$repo_root/apps/macos/Coflux.xcodeproj"

expected_tag="151.0.0"
expected_revision="19aa8c1fc7120d50df987b7111f42d5024df3d54"
expected_checksum="64a218fad3d84a0d783321aa9a1eec58ca266ac7879123f86b0b44b703b7d8dc"
expected_webrtc_branch="branch-heads/7922"
expected_webrtc_commit="f20ebb8adbf4fa781830e4384c61f732bd28a217"
expected_archive_bytes="44616338"
artifact_url="https://github.com/stasel/WebRTC/releases/download/151.0.0/WebRTC-M151.xcframework.zip"
release_api="https://api.github.com/repos/stasel/WebRTC/releases/tags/151.0.0"
artifact_cache="${HOME:?HOME 未设置}/Library/Caches/org.swift.swiftpm/artifacts/https___github_com_stasel_WebRTC_releases_download_151_0_0_WebRTC_M151_xcframework_zip"
temporary_archive=""

cleanup() {
  if [[ -n "$temporary_archive" ]]; then rm -f "$temporary_archive"; fi
}
trap cleanup EXIT

cd "$repo_root"
xcodebuild -resolvePackageDependencies -project "$project" -scheme Coflux >/dev/null

build_dir="$(xcodebuild -project "$project" -scheme Coflux -showBuildSettings 2>/dev/null | sed -n 's/^[[:space:]]*BUILD_DIR = //p' | head -1)"
if [[ -z "$build_dir" ]]; then
  echo "无法解析 Xcode BUILD_DIR" >&2
  exit 1
fi
derived_root="$(cd "$build_dir/../.." && pwd)"
checkout="$derived_root/SourcePackages/checkouts/WebRTC"
xcframework="$derived_root/SourcePackages/artifacts/webrtc/WebRTC/WebRTC.xcframework"
framework="$xcframework/macos-x86_64_arm64/WebRTC.framework"
binary="$framework/Versions/A/WebRTC"

test -f "$checkout/Package.swift"
test -f "$xcframework/Info.plist"
test -f "$xcframework/LICENSE"
test -f "$binary"

actual_revision="$(git -C "$checkout" rev-parse HEAD)"
actual_tags="$(git -C "$checkout" tag --points-at HEAD)"
if [[ "$actual_revision" != "$expected_revision" ]] || ! printf '%s\n' "$actual_tags" | rg -Fxq "$expected_tag"; then
  echo "WebRTC source pin 漂移：tags=$actual_tags revision=$actual_revision" >&2
  exit 1
fi
if ! rg -q "checksum: \"$expected_checksum\"" "$checkout/Package.swift"; then
  echo "WebRTC SwiftPM checksum 漂移" >&2
  exit 1
fi
if ! rg -q 'Google WebRTC|WebRTC project authors' "$xcframework/LICENSE"; then
  echo "WebRTC binary 未携带上游 BSD license" >&2
  exit 1
fi

# SwiftPM 会先校验 archive 再解压；这里独立记录压缩包的真实 bytes/hash。缓存路径随当前
# SwiftPM 命名规则取得，缓存不存在时只下载到受控临时文件，不把 binary 写进仓库。
archive="$artifact_cache"
if [[ ! -f "$archive" ]]; then
  temporary_archive="$(mktemp "${TMPDIR:-/tmp}/coflux-webrtc-M151.XXXXXX")"
  curl --fail --location --silent --show-error "$artifact_url" --output "$temporary_archive"
  archive="$temporary_archive"
fi
archive_bytes="$(stat -f '%z' "$archive")"
archive_checksum="$(shasum -a 256 "$archive" | awk '{print $1}')"
if [[ "$archive_bytes" != "$expected_archive_bytes" || "$archive_checksum" != "$expected_checksum" ]]; then
  echo "WebRTC release archive 漂移：bytes=$archive_bytes sha256=$archive_checksum" >&2
  exit 1
fi

# branch/commit 是上游 release 对构建输入的声明，binary 本身无法反推出源码 revision；
# 因此读取 GitHub release metadata 并把它与本地 archive bytes/hash 一并钉死。
release_metadata="$(curl --fail --location --silent --show-error --retry 3 "$release_api")"
RELEASE_METADATA="$release_metadata" \
EXPECTED_TAG="$expected_tag" \
EXPECTED_BRANCH="$expected_webrtc_branch" \
EXPECTED_COMMIT="$expected_webrtc_commit" \
EXPECTED_CHECKSUM="$expected_checksum" \
EXPECTED_ARCHIVE_BYTES="$expected_archive_bytes" \
EXPECTED_ARTIFACT_URL="$artifact_url" \
node <<'NODE'
const release = JSON.parse(process.env.RELEASE_METADATA);
const expected = process.env;
if (release.tag_name !== expected.EXPECTED_TAG) throw new Error("WebRTC release tag metadata 漂移");
if (!release.body?.includes(expected.EXPECTED_BRANCH)) throw new Error("WebRTC upstream branch metadata 漂移");
if (!release.body?.includes(expected.EXPECTED_COMMIT)) throw new Error("WebRTC upstream commit metadata 漂移");
if (!release.body?.includes(expected.EXPECTED_CHECKSUM)) throw new Error("WebRTC checksum metadata 漂移");
const asset = release.assets?.find((entry) => entry.name === "WebRTC-M151.xcframework.zip");
if (!asset) throw new Error("WebRTC release asset 缺失");
if (asset.size !== Number(expected.EXPECTED_ARCHIVE_BYTES)) throw new Error("WebRTC release asset bytes 漂移");
if (asset.digest !== `sha256:${expected.EXPECTED_CHECKSUM}`) throw new Error("WebRTC release asset digest 漂移");
if (asset.browser_download_url !== expected.EXPECTED_ARTIFACT_URL) throw new Error("WebRTC release asset URL 漂移");
NODE

plist_json="$(plutil -convert json -o - "$xcframework/Info.plist")"
PLIST_JSON="$plist_json" node -e '
  const libraries = JSON.parse(process.env.PLIST_JSON).AvailableLibraries;
  const mac = libraries.find((item) => item.SupportedPlatform === "macos");
  if (!mac || !mac.SupportedArchitectures.includes("arm64") || !mac.SupportedArchitectures.includes("x86_64")) {
    throw new Error("XCFramework Info.plist 缺少 universal macOS slice");
  }
'

lipo_output="$(lipo -info "$binary")"
if [[ "$lipo_output" != *"arm64"* || "$lipo_output" != *"x86_64"* ]]; then
  echo "WebRTC Mach-O 不是 arm64+x86_64：$lipo_output" >&2
  exit 1
fi

binary_bytes="$(stat -f '%z' "$binary")"
framework_kib="$(du -sk "$framework" | awk '{print $1}')"
xcframework_kib="$(du -sk "$xcframework" | awk '{print $1}')"
built_app="$derived_root/Build/Products/Debug/Coflux.app"
built_framework="$built_app/Contents/Frameworks/WebRTC.framework"

# Mach-O slice 存在不等于 dyld 能加载。x86_64 XCTest 会实际链接并启动整个 test bundle；
# Apple Silicon 主机需要 Rosetta 2，Intel 主机则原生运行。
if [[ "$(uname -m)" == "arm64" ]] && ! arch -x86_64 /usr/bin/true; then
  echo "缺少 Rosetta 2，无法完成 x86_64 WebRTC runtime load 门" >&2
  exit 1
fi
xcodebuild test -quiet \
  -project "$project" \
  -scheme Coflux \
  -destination 'platform=macOS,arch=x86_64' \
  -only-testing:CofluxTests/NativeWebRTCFramingTests

test -d "$built_framework"
built_framework_kib="$(du -sk "$built_framework" | awk '{print $1}')"
built_app_kib="$(du -sk "$built_app" | awk '{print $1}')"
echo "WebRTC supply-chain OK"
echo "  tag=$expected_tag"
echo "  wrapper_revision=$expected_revision"
echo "  upstream_webrtc_branch=$expected_webrtc_branch"
echo "  upstream_webrtc_commit=$expected_webrtc_commit"
echo "  SwiftPM_checksum=$expected_checksum"
echo "  license=Google WebRTC BSD 3-Clause"
echo "  slices=arm64,x86_64"
echo "  macOS_binary_bytes=$binary_bytes"
echo "  macOS_framework_kib=$framework_kib"
echo "  release_archive_bytes=$archive_bytes"
echo "  extracted_xcframework_kib=$xcframework_kib"
echo "  x86_64_runtime_load=passed"
echo "  built_app_webrtc_increment_kib=$built_framework_kib"
echo "  built_debug_app_kib=$built_app_kib"
