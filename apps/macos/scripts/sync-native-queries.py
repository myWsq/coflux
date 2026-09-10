"""同步锁定版本的原生 Tree-sitter 查询与许可；无需 JavaScript 运行环境。"""
from pathlib import Path
from urllib.request import urlopen

root = Path(__file__).resolve().parents[1] / 'Sources' / 'Resources'
root.mkdir(parents=True, exist_ok=True)
sources = {
    'php-highlights.scm': ('tree-sitter/tree-sitter-php', 'v0.23.11', 'queries/highlights.scm'),
    'tree-sitter-php-LICENSE.txt': ('tree-sitter/tree-sitter-php', 'v0.23.11', 'LICENSE'),
    'xml-highlights.scm': ('tree-sitter-grammars/tree-sitter-xml', 'v0.7.0', 'queries/xml/highlights.scm'),
    'tree-sitter-xml-LICENSE.txt': ('tree-sitter-grammars/tree-sitter-xml', 'v0.7.0', 'LICENSE'),
    'javascript-highlights.scm': ('tree-sitter/tree-sitter-javascript', 'v0.23.1', 'queries/highlights.scm'),
    'jsx-highlights.scm': ('tree-sitter/tree-sitter-javascript', 'v0.23.1', 'queries/highlights-jsx.scm'),
    'typescript-highlights.scm': ('tree-sitter/tree-sitter-typescript', 'v0.23.2', 'queries/highlights.scm'),
    'tree-sitter-javascript-LICENSE.txt': ('tree-sitter/tree-sitter-javascript', 'v0.23.1', 'LICENSE'),
    'tree-sitter-typescript-LICENSE.txt': ('tree-sitter/tree-sitter-typescript', 'v0.23.2', 'LICENSE'),
    'SwiftTreeSitter-LICENSE.txt': ('tree-sitter/swift-tree-sitter', '0.9.0', 'LICENSE'),
    'tree-sitter-LICENSE.txt': ('tree-sitter/tree-sitter', 'v0.23.2', 'LICENSE'),
}
for language, version in [('rust', 'v0.23.2'), ('python', 'v0.23.6'), ('go', 'v0.23.4'), ('json', 'v0.24.8'), ('bash', 'v0.23.3'), ('c', 'v0.23.4')]:
    sources[f'{language}-highlights.scm'] = (f'tree-sitter/tree-sitter-{language}', version, 'queries/highlights.scm')
    sources[f'tree-sitter-{language}-LICENSE.txt'] = (f'tree-sitter/tree-sitter-{language}', version, 'LICENSE')
for target, (repo, version, path) in sources.items():
    with urlopen(f'https://raw.githubusercontent.com/{repo}/{version}/{path}', timeout=30) as response:
        content = response.read()
    (root / target).write_bytes(content)
