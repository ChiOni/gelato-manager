"""테스트용 가짜 포스 — 실제 포스를 켜지 않고 서버 로직을 확인하려고 쓴다.
WINE_BRIDGE 환경변수로 wine_bridge.py 대신 이 파일을 지정한다.
WINE_STUB_FAIL=1 이면 실패 응답을 낸다.
"""
import json
import os
import sys

cmd = sys.argv[1]
arg = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}

if os.environ.get('WINE_STUB_FAIL'):
    print(json.dumps({'ok': False, 'error': '포스가 상품 > 와인 목록 화면이 아닙니다. 클릭하지 않고 중단합니다.'}, ensure_ascii=False))
    sys.exit(1)

if cmd == 'sync':
    wines = arg.get('wines') or []
    print(json.dumps({
        'ok': True,
        'count': len(wines) + 3,
        'matched': [{'id': w['id'], 'posOcrName': w['posName'], 'price': w['posPrice'],
                     'priceText': f"{w['posPrice']:,}", 'expose': True, 'soldOutMark': False} for w in wines],
        'missing': [],
        'unknown': [{'name': '가비-화이트', 'price': 12000, 'priceText': '12.000', 'expose': True},
                    {'name': '빰빠네오 - 내추럴 화이트 (오렌지)', 'price': 11000, 'priceText': '11000', 'expose': False}],
        'excluded': [{'name': '글라스 와인', 'priceText': '직접입력', 'why': '가격이 직접입력'},
                     {'name': '다양하게 바틀 추천해주세요', 'priceText': '0', 'why': '가격이 0원 (추천 메뉴)'}],
    }, ensure_ascii=False))
elif cmd == 'expose':
    print(json.dumps({'ok': True, 'changed': True, 'name': arg['posName'], 'expose': bool(arg['on'])}, ensure_ascii=False))
elif cmd == 'add':
    print(json.dumps({'ok': True, 'submitted': True, 'listed': True, 'expose': arg.get('expose', True)}, ensure_ascii=False))
else:
    print(json.dumps({'ok': False, 'error': f'알 수 없는 명령: {cmd}'}, ensure_ascii=False))
    sys.exit(1)
