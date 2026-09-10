#!/usr/bin/env python3
"""在有屏幕捕获权限的开发宿主运行，配合显式启用的原生颜色验收测试。"""
import json
from pathlib import Path
import subprocess
import time

request = Path("/tmp/coflux-native-color-validation/capture-request.json")
initial = request.read_bytes() if request.exists() else None
seen = set()
deadline = time.monotonic() + 240
while time.monotonic() < deadline and len(seen) < 2:
    if request.exists():
        raw = request.read_bytes()
        if raw != initial:
            item = json.loads(raw)
            target = Path(item["path"])
            if target.parent != request.parent or target.name not in {
                "terminal-ansi-colors.png", "terminal-claude-colors.png"
            }:
                raise ValueError("拒绝捕获到验收目录以外")
            if target.name not in seen:
                temporary = target.with_name(target.stem + "-capture.png")
                subprocess.run([
                    "/usr/sbin/screencapture", "-x", "-o", "-l",
                    str(int(item["windowID"])), str(temporary)
                ], check=True)
                temporary.replace(target)
                seen.add(target.name)
                print("已捕获", target, flush=True)
    time.sleep(0.3)
if len(seen) != 2:
    raise TimeoutError("未收到两张终端验收截图请求")
