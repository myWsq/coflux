"""核对原生 App 打包资源和 Mach-O 直接链接；不推断系统间接依赖或动态加载行为。"""
import argparse
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('bundle', type=Path)
parser.add_argument('--output', type=Path)
args = parser.parse_args()
root = args.bundle.resolve(strict=True)
if root.suffix != '.app':
    raise SystemExit('需要提供 .app 目录')
magic_values = {bytes.fromhex(value) for value in ['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']}
seen = set()
mach = []
scripts = []
links = []
for path in sorted(root.rglob('*')):
    if not path.is_file():
        continue
    if path.suffix.lower() in {'.js', '.mjs', '.cjs', '.html', '.htm', '.wasm'}:
        scripts.append(str(path.relative_to(root)))
    resolved = path.resolve()
    if resolved in seen:
        continue
    seen.add(resolved)
    with path.open('rb') as file:
        magic = file.read(4)
    if magic not in magic_values:
        continue
    name = str(resolved.relative_to(root))
    mach.append(name)
    output = subprocess.check_output(['otool', '-L', str(resolved)], text=True)
    for line in output.splitlines()[1:]:
        if 'WebKit' in line or 'JavaScriptCore' in line:
            links.append({'file': name, 'dependency': line.strip()})
notices = root / 'Contents/Resources/ThirdPartyNotices.txt'
source_notices = Path(__file__).resolve().parents[1] / 'Sources/ThirdPartyNotices.txt'
notices_match = notices.is_file() and notices.read_bytes() == source_notices.read_bytes()
signature = subprocess.run(['codesign', '--verify', '--deep', '--strict', str(root)], capture_output=True, text=True)
report = {'bundle': str(root), 'uniqueMachOCount': len(mach), 'machOFiles': mach,
          'scriptResources': scripts, 'directWebRuntimeLinks': links,
          'noticesMatch': notices_match, 'signatureValid': signature.returncode == 0,
          'signatureDiagnostic': signature.stderr.strip(),
          'scope': '资源、直接链接、许可文本一致性、签名完整性；不证明正式签名身份、公证或系统间接依赖。'}
content = json.dumps(report, ensure_ascii=False, indent=2)
if args.output:
    args.output.write_text(content + '\n')
print(content)
if not mach or scripts or links or not notices_match or signature.returncode != 0:
    raise SystemExit(1)
