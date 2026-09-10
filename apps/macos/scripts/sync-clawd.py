"""将当前 Web 插画展开为静态矢量帧；动画由 Swift 播放，App 不运行 SVG/JS 动画。"""
from pathlib import Path
import copy
import json
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[3]
ET.register_namespace('', 'http://www.w3.org/2000/svg')
def groups(parent):
    return [node for node in parent if node.tag.endswith('}g')]
def only(parent, nodes, selected):
    for index, node in enumerate(nodes):
        if index != selected: parent.remove(node)
        else: node.attrib.pop('style', None)
def save(root, name):
    for node in root.iter():
        for key in ['class', 'id', 'data-svg-origin', 'style']: node.attrib.pop(key, None)
        if node.get('fill', '').upper() == '#DD775B': node.set('fill', '#D97757')
    _, _, w, h = map(float, root.get('viewBox').split())
    root.set('viewBox', f'-100 -100 {w+200:g} {h+200:g}')
    root.set('width', f'{w+200:g}'); root.set('height', f'{h+200:g}')
    folder = ROOT / f'apps/macos/Sources/Assets.xcassets/{name}.imageset'
    folder.mkdir(exist_ok=True)
    ET.ElementTree(root).write(folder / f'{name}.svg', encoding='unicode')
    (folder / 'Contents.json').write_text(json.dumps({'images': [{'filename': f'{name}.svg', 'idiom': 'universal'}], 'info': {'author': 'xcode', 'version': 1}, 'properties': {'preserves-vector-representation': True, 'template-rendering-intent': 'original'}}, indent=2))

gym = ET.parse(ROOT / 'apps/web/src/assets/clawd/gym.svg').getroot()
for frame in range(36):
    root = copy.deepcopy(gym); only(root, groups(root), frame); save(root, f'clawd-gym-{frame}')
flag = ET.parse(ROOT / 'apps/web/src/assets/clawd/flag.svg').getroot()
for frame in range(12):
    root = copy.deepcopy(flag); body = groups(root)[0]; hand = body[8]
    body.set('transform', f'translate({[0,0,-5,-5,0,4,4,4,0,0,-5,-5][frame]},0)')
    hand.set('transform', f'translate({[0,-6,-12,-14,-8,-2,0,0,-4,-10,-16,-18][frame]},0)')
    body[5].set('transform', f'translate(0,{[0,0,4,4,0,0,0,0,0,0,4,4][frame]})')
    only(hand, groups(hand), frame); save(root, f'clawd-flag-{frame}')
confetti = ET.parse(ROOT / 'apps/web/src/assets/clawd/confetti.svg').getroot()
for frame in range(14):
    root = copy.deepcopy(confetti); children = groups(root)
    only(root, children[:8], frame % 8)
    for burst, offset, x, y, scale in [(children[8],1,90,-22,''), (children[9],6,40,-72,' scale(-1,1)')]:
        if frame < offset: root.remove(burst); continue
        n = (frame-offset) % 8
        burst.set('transform', f'translate({x},{y+[-65,-72,-76,-70,-58,-42,-22,0][n]}){scale}')
        only(burst, groups(burst), n)
    save(root, f'clawd-confetti-{frame}')
print('已生成 62 个原生矢量帧')
