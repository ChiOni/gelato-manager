"""와인 이름 매칭 · 제외 규칙 테스트 — 실제 포스 OCR 결과로 검증한다 (포스 불필요).

    python automation/test/wine-match.test.py

OCR 은 '가비→가리', '빰빠네오→참빠너모', '퇴플러→퇴를러', '무알콜→무일를' 처럼 틀리게 읽는다.
장부의 정식 이름 + 가격으로 올바른 행을 찾아내는지, 제외 대상을 제대로 걸러내는지 확인한다.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'tosspos'))
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

import pos_screen as P                      # noqa: E402
from wine_bridge import excluded            # noqa: E402

# 2026-10-04 실제 포스 화면을 읽은 결과 (OCR 오타 포함) — tosspos/.debug/all-new.json
ROWS = [
    {'name': '테스트', 'price': 100000, 'priceText': '10다000', 'expose': True},
    {'name': '가리-화이트', 'price': 12000, 'priceText': '12.000', 'expose': True},
    {'name': '샤또 라로즈 - 레드', 'price': 9000, 'priceText': '9,000', 'expose': True},
    {'name': '르리트롱 - 내추럴 화이트 (오렌지)', 'price': 12000, 'priceText': '12.000', 'expose': True},
    {'name': '이그리노 - 내추럴 레드', 'price': 9000, 'priceText': '9,000', 'expose': True},
    {'name': '칼뢰벤 -화이트', 'price': 12000, 'priceText': '12.000', 'expose': False},
    {'name': '참빠너모 - 내추럴 화이트 (오렌지)', 'price': 11000, 'priceText': '11000', 'expose': False},
    {'name': '퇴를러-레드', 'price': 14000, 'priceText': '14.000', 'expose': True},
    {'name': '그란 셀로 GST - 레드', 'price': 10000, 'priceText': '1다000', 'expose': True},
    {'name': '글라스 와인', 'price': None, 'priceText': '직접입력', 'expose': False},
    {'name': '무일를와인 -화이트 (샤도네이, 프랑스)', 'price': 8000, 'priceText': '8.000', 'expose': True},
    {'name': '무일를와인 - 레드 (까르베네 쇼81± 프랑스)', 'price': 8000, 'priceText': '8.000', 'expose': True},
    {'name': '스타보로우 - 화이트', 'price': 10000, 'priceText': '1다000', 'expose': True},
    {'name': '줄리엣 -화이트', 'price': 12000, 'priceText': '12.000', 'expose': True},
    {'name': '다양하게 하틀 추천해주세요', 'price': 0, 'priceText': '0', 'expose': True},
    {'name': '바-틀 와인', 'price': None, 'priceText': '', 'expose': False},
]

# 장부에 적는 정식 이름 (사람이 보는 이름) → 화면에서 찾아야 하는 행
LEDGER = [
    ('테스트', 100000, '테스트'),
    ('가비-화이트', 12000, '가리-화이트'),
    ('샤또 라로즈-레드', 9000, '샤또 라로즈 - 레드'),
    ('르리트롱-내추럴 화이트(오렌지)', 12000, '르리트롱 - 내추럴 화이트 (오렌지)'),
    ('이그리노-내추럴 레드', 9000, '이그리노 - 내추럴 레드'),
    ('칼뢰벤-화이트', 12000, '칼뢰벤 -화이트'),
    ('빰빠네오-내추럴 화이트(오렌지)', 11000, '참빠너모 - 내추럴 화이트 (오렌지)'),
    ('퇴플러-레드', 14000, '퇴를러-레드'),
    ('그란 셀로 GST-레드', 10000, '그란 셀로 GST - 레드'),
    ('무알콜 와인-화이트(샤도네이, 프랑스)', 8000, '무일를와인 -화이트 (샤도네이, 프랑스)'),
    ('무알콜 와인-레드(까르베네 쇼비뇽, 프랑스)', 8000, '무일를와인 - 레드 (까르베네 쇼81± 프랑스)'),
    ('스타보로우-화이트', 10000, '스타보로우 - 화이트'),
    ('줄리엣-화이트', 12000, '줄리엣 -화이트'),
]

EXPECT_EXCLUDED = {'글라스 와인', '바-틀 와인', '다양하게 하틀 추천해주세요'}

passed = failed = 0


def ok(cond, name, extra=''):
    global passed, failed
    if cond:
        passed += 1
        print(f'  OK  {name}')
    else:
        failed += 1
        print(f'  XX  {name}' + (f' — {extra}' if extra else ''))


print('\n제외 규칙 (추천 메뉴 · 직접입력 가격)')
got = {r['name'] for r in ROWS if excluded(r)}
ok(got == EXPECT_EXCLUDED, '제외 대상 3개만 걸러짐', f'걸러진 것: {sorted(got)}')
for r in ROWS:
    if r['name'] in EXPECT_EXCLUDED:
        ok(bool(excluded(r)), f"제외: {r['name']} ({excluded(r)})")

print('\n이름 유사도 + 가격 매칭 (OCR 오타 있는 실제 화면)')
pool = [r for r in ROWS if not excluded(r)]
for official, price, want in LEDGER:
    row, scored = P.match_row(pool, official, price)
    hit = row['name'] if row else None
    ok(hit == want, f"'{official}' → '{want}'",
       f"찾은 것: {hit!r} / 후보 {[(round(s, 2), r['name']) for s, r in scored[:3]]}")

print('\n잘못된 가격 · 없는 와인은 매칭되지 않아야 함')
row, _ = P.match_row(pool, '가비-화이트', 9000)
ok(row is None, '가격이 다르면 매칭 안 함 (가비를 9,000원으로 찾기)', f'찾음: {row}')
row, _ = P.match_row(pool, '없는와인-레드', 7000)
ok(row is None, '장부에만 있는 와인은 못 찾음 (포스에 없음)', f'찾음: {row}')

print('\n장부 전체를 한 번에 대조 (sync 와 같은 방식)')
left = list(pool)
matched = []
for official, price, want in LEDGER:
    row, _ = P.match_row(left, official, price)
    if row:
        left.remove(row)
        matched.append((official, row['name']))
ok(len(matched) == len(LEDGER), f'{len(LEDGER)}개 모두 매칭', f'매칭 {len(matched)}개')
ok(len(left) == 0, '남은(장부에 없는) 포스 상품 0개', f'남음: {[r["name"] for r in left]}')

print('\n' + '-' * 44)
print(f'통과 {passed} · 실패 {failed}')
sys.exit(1 if failed else 0)
