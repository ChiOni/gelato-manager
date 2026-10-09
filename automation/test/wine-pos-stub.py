"""테스트용 가짜 포스 — 실제 포스를 켜지 않고 서버 로직을 확인한다.

WINE_BRIDGE 로 wine_bridge.py 대신 이 파일을 지정한다.
WINE_STUB_STATE 가 가리키는 JSON 파일이 '포스에 등록된 상품 목록' 역할을 한다.
expose/add 가 그 파일을 실제로 고치므로, 이어서 sync 하면 바뀐 결과가 보인다.
WINE_STUB_FAIL=1 이면 모든 명령이 실패한다.
"""
import json
import os
import re
import sys

STATE = os.environ.get('WINE_STUB_STATE')
norm = lambda s: re.sub(r'[\s\-–·,()（）]', '', str(s or ''))


def catalog():
    try:
        with open(STATE, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return []


def write(rows):
    with open(STATE, 'w', encoding='utf-8') as f:
        json.dump(rows, f, ensure_ascii=False)


def find(rows, name):
    hit = [r for r in rows if norm(r['name']) == norm(name)]
    return hit[0] if hit else None


cmd = sys.argv[1]
arg = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}

if os.environ.get('WINE_STUB_FAIL'):
    print(json.dumps({'ok': False, 'error': '포스가 상품 > 와인 목록 화면이 아닙니다. 클릭하지 않고 중단합니다.'}, ensure_ascii=False))
    sys.exit(1)

rows = catalog()
# 가격이 '직접입력'(None)이거나 0원인 상품은 와인 목록에서 제외된다 (실제 bridge 와 같은 규칙)
sellable = [r for r in rows if r.get('price')]
excluded = [{'name': r['name'], 'priceText': '직접입력' if r.get('price') is None else '0',
             'why': '가격이 직접입력' if r.get('price') is None else '가격이 0원 (추천 메뉴)'}
            for r in rows if not r.get('price')]

if cmd == 'sync':
    left = list(sellable)
    matched = []
    for w in arg.get('wines') or []:
        hit = find(left, w.get('posName'))
        if hit and hit.get('price') == w.get('posPrice'):
            left.remove(hit)
            matched.append({'id': w['id'], 'posOcrName': hit['name'], 'price': hit['price'],
                            'priceText': f"{hit['price']:,}", 'expose': hit['expose'], 'soldOutMark': False})
    missing = [{'id': w['id'], 'posName': w.get('posName'), 'candidates': []}
               for w in (arg.get('wines') or []) if w['id'] not in {m['id'] for m in matched}]
    print(json.dumps({
        'ok': True, 'count': len(rows), 'matched': matched, 'missing': missing,
        'unknown': [{'name': r['name'], 'price': r['price'], 'priceText': f"{r['price']:,}",
                     'expose': r['expose']} for r in left],
        'excluded': excluded,
    }, ensure_ascii=False))

elif cmd == 'expose':
    hit = find(rows, arg['posName'])
    if not hit:
        print(json.dumps({'ok': False, 'error': f"'{arg['posName']}' 와인을 목록에서 확실하게 찾지 못해 중단합니다."}, ensure_ascii=False))
        sys.exit(1)
    changed = hit['expose'] != bool(arg['on'])
    hit['expose'] = bool(arg['on'])
    write(rows)
    print(json.dumps({'ok': True, 'changed': changed, 'name': hit['name'], 'expose': hit['expose']}, ensure_ascii=False))

elif cmd == 'add':
    rows.append({'name': arg['posName'], 'price': int(arg['price']), 'expose': bool(arg.get('expose', True))})
    write(rows)
    print(json.dumps({'ok': True, 'submitted': True, 'listed': True, 'expose': bool(arg.get('expose', True))}, ensure_ascii=False))

else:
    print(json.dumps({'ok': False, 'error': f'알 수 없는 명령: {cmd}'}, ensure_ascii=False))
    sys.exit(1)
