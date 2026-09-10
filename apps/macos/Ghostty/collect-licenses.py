"""从本次固定源码及已解析的 Zig 依赖收集原文，包含构建期依赖。"""
import argparse, hashlib, json, re
from pathlib import Path
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('source', type=Path)
p.add_argument('--zig', type=Path, required=True)
a = p.parse_args()
out = Path(__file__).resolve().parent
roots = {a.source.resolve(), a.zig.resolve()}
for dependencies in (a.source / '.zig-cache').glob('o/*/dependencies.zig'):
    roots.update(Path(path).resolve() for path in re.findall(r'pub const build_root = "([^"]+)"', dependencies.read_text()) if Path(path).is_dir())
sections = ['Ghostty 及其构建依赖许可原文。已解析依赖并不全部进入 macOS 二进制。\n']
entries = []
seen = set()
for root in sorted(roots):
    # 本地 pkg 包装器的依赖已单独枚举；源码只收主许可与随库编译的字体许可。
    if root == a.source.resolve():
        files = [root / 'LICENSE', root / 'vendor/nerd-fonts/LICENSE']
    elif root == a.zig.resolve():
        files = [root / 'LICENSE']
    else:
        files = sorted(f for f in root.rglob('*') if f.is_file() and (f.name.upper().startswith(('LICENSE', 'LICENCE', 'COPYING')) or f.name.upper() == 'FTL.TXT') and '.git' not in f.parts)
    for file in files:
        data = file.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        label = ('ghostty' if root == a.source.resolve() else root.name) + '/' + str(file.relative_to(root))
        entries.append({'source': label, 'sha256': digest})
        if digest in seen: continue
        seen.add(digest)
        sections.append('\n' + '=' * 72 + '\n' + label + '\n\n' + data.decode('utf-8', errors='replace'))
text = '\n'.join(sections) + '\n'
(out / 'THIRD-PARTY-LICENSES.txt').write_text(text)
(out / 'licenses.json').write_text(json.dumps({'upstreamRevision': json.loads((out / 'upstream.json').read_text())['revision'], 'files': entries, 'noticeSHA256': hashlib.sha256(text.encode()).hexdigest()}, ensure_ascii=False, indent=2) + '\n')
print(f'{len(roots)} 个源码根，{len(entries)} 份许可原文，{len(seen)} 份唯一内容，{len(text.encode())} 字节')
