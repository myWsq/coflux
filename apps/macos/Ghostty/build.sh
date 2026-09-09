#!/bin/sh
# 用固定上游和宿主 Zig 构建带远程 I/O 的 Metal 核心，不使用开发者证书。
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
cache_dir=${COFLUX_GHOSTTY_CACHE:-"$repo_root/.coflux-dev/ghostty"}
zig_bin=${COFLUX_ZIG_BIN:-zig}
revision=da9e21602f918d47a46399c458937eff7c7a74ac
if [ "$("$zig_bin" version)" != "0.16.0" ]; then
  echo '需要 Zig 0.16.0；可用 COFLUX_ZIG_BIN 指定已验证工具链。' >&2
  exit 1
fi
mkdir -p "$cache_dir"
patch_snapshot=$(mktemp "$cache_dir/patch-XXXXXX.py")
trap 'rm -f "$patch_snapshot"' EXIT HUP INT TERM
cp "$script_dir/apply-remote-io.py" "$patch_snapshot"
patch_hash=$(shasum -a 256 "$patch_snapshot" | cut -d ' ' -f 1)
source_dir="$cache_dir/source-$revision-$patch_hash"
if [ ! -d "$source_dir/.git" ]; then
  git init "$source_dir"
  git -C "$source_dir" remote add origin https://github.com/ghostty-org/ghostty.git
  git -C "$source_dir" fetch --depth 1 origin "$revision"
  git -C "$source_dir" checkout --detach FETCH_HEAD
fi
if [ ! -f "$source_dir/src/termio/External.zig" ]; then
  python3 "$patch_snapshot" "$source_dir"
fi
cd "$source_dir"
"$zig_bin" build -Doptimize=ReleaseFast -Dapp-runtime=none -Demit-xcframework=true -Dxcframework-target=native -Demit-macos-app=false -Demit-docs=false
# 固定工程入口；源码缓存由上游版本和补丁内容共同寻址。
python3 - "$source_dir/macos/GhosttyKit.xcframework" "$cache_dir/GhosttyKit.xcframework" <<'PY_COPY'
import shutil, sys
shutil.copytree(sys.argv[1], sys.argv[2], dirs_exist_ok=True)
PY_COPY
printf '%s\n' "$cache_dir/GhosttyKit.xcframework"
