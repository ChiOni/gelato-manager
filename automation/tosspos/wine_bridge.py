"""와인 장부 ↔ 토스 포스 다리 — JSON 으로 주고받는 CLI.

pos_screen.py 는 수정하지 않고 import 해서 쓴다 (검증된 동작 보존).

    python wine_bridge.py sync   '{"wines":[{"id":"w1","posName":"가비 - 화이트","posPrice":12000}]}'
    python wine_bridge.py expose '{"posName":"가비 - 화이트","posPrice":12000,"on":false}'
    python wine_bridge.py add    '{"posName":"가비 - 화이트","kioskName":"가비","kioskNameEn":"Gavi",
                                   "desc":"산뜻한 청사과 향","price":12000,"expose":true}'

표준출력에는 JSON 한 줄만 쓴다 (진행 로그는 표준오류로 — 섞이면 서버가 결과를 못 읽는다).
실패하면 {"ok": false, "error": "..."} 를 출력하고 종료코드 1.
"""
import json
import os
import sys
from difflib import SequenceMatcher

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pos_screen as P

for s in (sys.stdout, sys.stderr):
    try:
        s.reconfigure(encoding='utf-8')
    except Exception:
        pass


def elog(*a):
    """진행 로그는 표준오류로 — 표준출력은 JSON 결과 전용"""
    print(*a, file=sys.stderr, flush=True)


# 와인 장부에서 제외할 포스 상품 (요구사항: 추천 메뉴 · 가격이 '직접입력' 인 상품)
EXCLUDE_NAMES = ('다양하게 바틀 추천해주세요', '글라스 와인', '바틀 와인')


def excluded(row):
    """장부 대상이 아니면 이유 문자열, 대상이면 None"""
    if row['price'] is None:
        return '가격이 직접입력'
    if row['price'] == 0:
        return '가격이 0원 (추천 메뉴)'
    name = P._norm(row['name'])
    for ex in EXCLUDE_NAMES:
        # 가격으로 이미 걸러지지만, OCR 이 가격을 잘못 읽은 경우를 위한 2차 안전망
        if SequenceMatcher(None, P._norm(ex), name).ratio() >= 0.75:
            return f"제외 상품('{ex}')"
    return None


def cmd_sync(arg):
    """포스 와인 탭 전체를 읽어 장부와 대조한다 (클릭 없음 — 읽기만)"""
    ledger = arg.get('wines') or []
    with P.Foreground():
        rows = P.all_wines()
        P.scroll_top()  # 다음 작업이 맨 위에서 시작하도록 되돌려 둔다

    pool, dropped = [], []
    for r in rows:
        why = excluded(r)
        if why:
            dropped.append({**r, 'why': why})
        else:
            pool.append(r)

    left = list(pool)
    matched, missing = [], []
    for w in ledger:
        # 장부의 정식 이름 + 가격으로 매칭 (OCR 오타 대응은 match_row 가 처리)
        row, scored = P.match_row(left, w.get('posName') or '', w.get('posPrice'))
        if row:
            left.remove(row)  # 한 포스 상품이 두 와인에 매칭되지 않게
            matched.append({
                'id': w.get('id'),
                'posOcrName': row['name'],
                'price': row['price'],
                'priceText': row['priceText'],
                'expose': row['expose'],
                'soldOutMark': row['soldOutMark'],
            })
        else:
            missing.append({
                'id': w.get('id'),
                'posName': w.get('posName'),
                'candidates': [[round(s, 2), r['name'], r['price']] for s, r in scored[:3]],
            })

    return {
        'ok': True,
        'count': len(rows),
        'matched': matched,
        'missing': missing,
        'unknown': [{'name': r['name'], 'price': r['price'], 'priceText': r['priceText'],
                     'expose': r['expose']} for r in left],
        'excluded': [{'name': r['name'], 'priceText': r['priceText'], 'why': r['why']} for r in dropped],
    }


def cmd_expose(arg):
    """고객용 채널 노출 토글을 on/off 로 맞춘다 (set_expose 가 안전 확인 후에만 클릭)"""
    r = P.set_expose(arg['posName'], bool(arg['on']), arg.get('posPrice'), log=elog)
    return {'ok': True, 'changed': r.get('changed'), 'name': r.get('name'), 'expose': r.get('expose')}


def cmd_add(arg):
    """포스에 상품을 등록한다. 노출 OFF 로 원하면 등록 후 이어서 토글을 끈다."""
    spec = {
        'name': arg['posName'],
        'kioskName': arg.get('kioskName') or arg['posName'],
        'kioskNameEn': arg.get('kioskNameEn') or '',
        'desc': arg.get('desc') or '',
        'category': arg.get('category') or '와인',
        'price': int(arg['price']),
    }
    r = P.add_product(spec, log=elog, submit=True)
    out = {'ok': True, 'submitted': bool(r.get('submitted')), 'listed': bool(r.get('listed')), 'expose': True}
    # 포스 상품 추가는 '고객용 채널 노출' 이 기본 ON 으로 등록된다 → OFF 를 원하면 이어서 끈다
    if out['submitted'] and not arg.get('expose', True):
        elog('노출 OFF 로 설정하는 중…')
        e = P.set_expose(spec['name'], False, spec['price'], log=elog)
        out['expose'] = bool(e.get('expose'))
    return out


COMMANDS = {'sync': cmd_sync, 'expose': cmd_expose, 'add': cmd_add}

if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    fn = COMMANDS.get(cmd)
    if not fn:
        print(json.dumps({'ok': False, 'error': f'알 수 없는 명령: {cmd!r}'}, ensure_ascii=False))
        sys.exit(1)
    try:
        arg = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
        print(json.dumps(fn(arg), ensure_ascii=False))
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e) or e.__class__.__name__}, ensure_ascii=False))
        sys.exit(1)
