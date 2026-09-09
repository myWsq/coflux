"""按当前 Package.resolved 与已检出源码生成随 App 分发的原始许可文本。"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[3]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source-packages', type=Path, required=True)
parser.add_argument('--check', action='store_true')
args = parser.parse_args()
resolved = root / 'apps/macos/Coflux.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved'
pins = json.loads(resolved.read_text())['pins']
checkouts = {p.name.lower(): p for p in (args.source_packages / 'checkouts').iterdir() if p.is_dir()}
sections = ['coflux — 第三方许可\n\n以下保留当前依赖解析清单的原始许可文本，包含构建工具依赖，不表示它们均在运行时加载。\n']
for pin in sorted(pins, key=lambda p: p['identity']):
    checkout = checkouts[pin['identity']]
    revision = subprocess.check_output(['git', '-C', str(checkout), 'rev-parse', 'HEAD'], text=True).strip()
    if revision != pin['state']['revision']:
        raise SystemExit(f"依赖版本不匹配：{pin['identity']}")
    licenses = sorted(p for p in checkout.rglob('*') if p.is_file() and p.name.lower() in {'license', 'license.md', 'license.txt', 'copying', 'notice', 'notice.txt'} and '.git' not in p.parts)
    if not licenses:
        raise SystemExit(f"缺少许可文件：{pin['identity']}")
    sections.append(f"\n{'=' * 72}\n{pin['identity']} {pin['state'].get('version', revision)}\n{pin['location']}\nRevision: {revision}\n")
    for license in licenses:
        sections.append(f'\n来源：{license.relative_to(checkout)}\n\n{license.read_text()}\n')
native_root = root / 'apps/macos/NativeGrammars'
native_dependencies = json.loads((native_root / 'manifest.json').read_text())['dependencies']
for dependency in native_dependencies:
    for entry in dependency['files']:
        if hashlib.sha256((native_root / entry['file']).read_bytes()).hexdigest() != entry['sha256']:
            raise SystemExit(f"原生语法源码校验失败：{entry['file']}")
    sections.append(f"\n{'=' * 72}\n{dependency['name']} 本地原生封装\n{dependency['repository']}\nRevision: {dependency['revision']}\n\n{(native_root / dependency['license']).read_text()}\n")
    for extra in dependency.get('additionalLicenses', []):
        sections.append(f'\n附加许可来源：{extra}\n\n{(native_root / extra).read_text()}\n')
ghostty_root = root / 'apps/macos/Ghostty'
ghostty = json.loads((ghostty_root / 'upstream.json').read_text())
ghostty_licenses = json.loads((ghostty_root / 'licenses.json').read_text())
ghostty_text = (ghostty_root / 'THIRD-PARTY-LICENSES.txt').read_bytes()
if ghostty_licenses['upstreamRevision'] != ghostty['revision'] or hashlib.sha256(ghostty_text).hexdigest() != ghostty_licenses['noticeSHA256']:
    raise SystemExit('Ghostty 许可版本或原文校验失败')
sections.append(f"\n{'=' * 72}\nGhostty 原生终端核心\n{ghostty['repository']}\nRevision: {ghostty['revision']}\n\n{ghostty_text.decode()}\n")
artifact = args.source_packages / 'artifacts/webrtc/WebRTC/WebRTC.xcframework/LICENSE'
sections.append(f'\n{"=" * 72}\nWebRTC 二进制框架附带许可\n\n{artifact.read_text()}\n')
embedded_root = root / 'apps/macos/licenses/webrtc'
embedded = json.loads((embedded_root / 'manifest.json').read_text())
webrtc_pin = next(pin for pin in pins if pin['identity'] == 'webrtc')
if webrtc_pin['state'].get('version') != embedded['version']:
    raise SystemExit('WebRTC 版本变化，需要重新核实内置第三方许可')
sections.append(f"\n{'=' * 72}\nWebRTC 内置第三方库许可\n上游提交：{embedded['upstreamRevision']}\n{embedded['scope']}\n")
for entry in embedded['files']:
    data = (embedded_root / entry['file']).read_bytes()
    if hashlib.sha256(data).hexdigest() != entry['sha256']:
        raise SystemExit(f"许可文件校验失败：{entry['file']}")
    sections.append(f"\n来源：{entry['url']}\n\n{data.decode('utf-8')}\n")
sections.append(f'\n{"=" * 72}\nLucide 图标\nhttps://github.com/lucide-icons/lucide\n\n{(root / "apps/macos/LUCIDE-LICENSE").read_text()}\n')
output = root / 'apps/macos/Sources/ThirdPartyNotices.txt'
content = '\n'.join(sections)
if args.check:
    if not output.exists() or output.read_bytes() != content.encode():
        raise SystemExit('第三方许可说明需要重新生成')
else:
    output.write_text(content)
print(f'{len(pins)} 项锁定依赖 + {len(native_dependencies)} 项本地原生语法 + Ghostty 原生核心及构建依赖 + WebRTC 二进制及 {len(embedded['files'])} 项内置许可 + Lucide；{len(content.encode())} 字节')
