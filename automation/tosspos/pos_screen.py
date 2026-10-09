"""토스 POS 화면 읽기 — 창 캡처(가려져도 됨) + Windows OCR + 토글 상태 판별.

    python pos_screen.py capture <out.png>
    python pos_screen.py wines            # 현재 화면의 와인 목록(JSON): 이름, 가격, 노출/품절표시 ON/OFF, 행 y좌표
    python pos_screen.py scroll <+n|-n>   # 상품 목록을 n칸 스크롤(마우스 커서는 움직이지 않음)
"""
import ctypes
import json
import os
import re
import subprocess
import sys
import tempfile
import time

import win32api
import win32con
import win32gui
import win32ui
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
TITLE = '토스 포스'


def find_window():
    hwnd = win32gui.FindWindow(None, TITLE)
    if not hwnd:
        raise RuntimeError('토스 포스 창을 찾을 수 없습니다. 포스가 켜져 있는지 확인하세요.')
    return hwnd


class Foreground:
    """작업하는 동안 포스 창을 맨 앞으로 — 크롬 기반 앱은 가려져 있으면 화면을 다시 그리지 않아
    스크롤/클릭이 반영되지 않고 캡처도 예전 화면이 나온다. 끝나면 원래 보던 창으로 돌려놓는다."""

    def __enter__(self):
        self.hwnd = find_window()
        self.prev = win32gui.GetForegroundWindow()
        if self.prev != self.hwnd:
            if win32gui.IsIconic(self.hwnd):
                win32gui.ShowWindow(self.hwnd, win32con.SW_RESTORE)
            # 다른 프로그램이 앞에 있으면 Windows 가 포커스 전환을 막으므로 Alt 키 입력으로 허용받는다
            win32api.keybd_event(win32con.VK_MENU, 0, 0, 0)
            win32api.keybd_event(win32con.VK_MENU, 0, win32con.KEYEVENTF_KEYUP, 0)
            win32gui.SetForegroundWindow(self.hwnd)
            time.sleep(0.8)  # 다시 그려질 시간
        return self

    def __exit__(self, *exc):
        if self.prev and self.prev != self.hwnd and win32gui.IsWindow(self.prev):
            try:
                win32api.keybd_event(win32con.VK_MENU, 0, 0, 0)
                win32api.keybd_event(win32con.VK_MENU, 0, win32con.KEYEVENTF_KEYUP, 0)
                win32gui.SetForegroundWindow(self.prev)
            except Exception:
                pass
        return False


def capture(path=None):
    hwnd = find_window()
    l, t, r, b = win32gui.GetWindowRect(hwnd)
    w, h = r - l, b - t
    dc = win32gui.GetWindowDC(hwnd)
    mdc = win32ui.CreateDCFromHandle(dc)
    sdc = mdc.CreateCompatibleDC()
    bmp = win32ui.CreateBitmap()
    bmp.CreateCompatibleBitmap(mdc, w, h)
    sdc.SelectObject(bmp)
    ctypes.windll.user32.PrintWindow(hwnd, sdc.GetSafeHdc(), 2)  # PW_RENDERFULLCONTENT
    info = bmp.GetInfo()
    im = Image.frombuffer('RGB', (info['bmWidth'], info['bmHeight']), bmp.GetBitmapBits(True), 'raw', 'BGRX', 0, 1)
    win32gui.DeleteObject(bmp.GetHandle())
    sdc.DeleteDC()
    mdc.DeleteDC()
    win32gui.ReleaseDC(hwnd, dc)
    if path:
        im.save(path)
    return im, (l, t)


def ocr(im):
    fd, tmp = tempfile.mkstemp(suffix='.png')
    os.close(fd)
    try:
        im.save(tmp)
        out = subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', os.path.join(HERE, 'ocr.ps1'), tmp],
                             capture_output=True, check=True)
        return json.loads(out.stdout.decode('utf-8-sig') or '[]')
    finally:
        os.remove(tmp)


def toggle_on(im, x, y):
    """토글 중심 주변을 가로로 훑어 파란색(ON) 픽셀 수로 판별"""
    blue = 0
    for dx in range(-22, 23):
        r, g, b = im.getpixel((x + dx, y))
        if b > 200 and r < 120:
            blue += 1
    return blue > 8


PRICE = re.compile(r'^([\d.,다]{1,7}|직접입력)$')  # 가격 줄: 숫자(OCR 이 '1다000' 처럼 읽기도 함) 또는 '직접입력'


def wines(im=None):
    im = im or capture()[0]
    lines = ocr(im)
    # 상품 목록 머리줄 — 상단 안내 배너가 뜨면 아래로 밀리므로 y 를 넉넉히 본다
    head = next((l for l in lines if '노출' in l['text'] and l['x'] > 1650 and l['y'] < 500), None)
    sold = next((l for l in lines if l['text'].startswith('품') and l['x'] > 1500 and head and abs(l['y'] - head['y']) < 15), None)
    if not head:
        raise RuntimeError('상품 목록 화면이 아닙니다 (고객용 채널 노출 열이 보이지 않음).')
    x_expose = head['x'] + head['w'] // 2
    x_sold = sold['x'] + sold['w'] // 2 if sold else None
    col = [l for l in lines if 400 <= l['x'] <= 450 and l['y'] > head['y'] + 20]
    names = [l for l in col if not PRICE.match(l['text'].replace(' ', ''))]
    rows = []
    for n in names:
        price_line = next((l for l in col if 15 <= l['y'] - n['y'] <= 40 and l is not n), None)
        price = price_line['text'] if price_line else ''
        digits = re.sub(r'\D', '', price.replace('다', '0'))
        cy = n['y'] + 20
        rows.append({
            'name': n['text'],
            'price': int(digits) if digits else None,  # '직접입력' 은 None
            'priceText': price,
            'expose': toggle_on(im, x_expose, cy),
            'soldOutMark': toggle_on(im, x_sold, cy) if x_sold else None,
            'y': cy,
        })
    return rows


def scroll(steps):
    """목록 영역에 마우스 휠 메시지를 보낸다 (실제 커서 이동 없음)"""
    hwnd = find_window()
    l, t, r, b = win32gui.GetWindowRect(hwnd)
    x, y = l + 900, t + 600
    target = win32gui.WindowFromPoint((x, y))
    if win32gui.GetAncestor(target, win32con.GA_ROOT) != hwnd:
        target = hwnd
    for _ in range(abs(steps)):
        delta = -120 if steps > 0 else 120
        win32api.PostMessage(target, win32con.WM_MOUSEWHEEL, win32api.MAKELONG(0, delta & 0xFFFF), win32api.MAKELONG(x, y))
        time.sleep(0.05)
    time.sleep(0.8)


def scroll_top(max_tries=8):
    """첫 줄이 더 이상 바뀌지 않을 때까지 위로 스크롤 (부드러운 스크롤이라 한 번에 안 올라갈 수 있음)"""
    prev = None
    for _ in range(max_tries):
        scroll(-10)
        time.sleep(0.6)
        rows = wines()
        first = rows[0]['name'] if rows else None
        if first == prev:
            return
        prev = first


def all_wines(max_pages=10):
    """목록 맨 위로 스크롤한 뒤 아래로 내려가며 화면마다 읽어 합친다 (이름 기준 중복 제거)"""
    scroll_top()
    out, idle = [], 0
    for _ in range(max_pages):
        rows = wines()
        # 같은 상품이 화면마다 조금 다르게 읽힐 수 있어(바틀와인/바-틀 와인) 이름 유사도로 중복 제거
        from difflib import SequenceMatcher
        def dup(r):
            return any(SequenceMatcher(None, _norm(r['name']), _norm(o['name'])).ratio() > 0.8 and r['price'] == o['price'] for o in out)
        new = [r for r in rows if not dup(r)]
        out.extend(new)
        idle = 0 if new else idle + 1
        if idle >= 2:  # 두 화면 연속 새 항목 없음 = 목록 끝
            break
        scroll(6)
        time.sleep(0.5)
    return out


TABS = ('전체', '젤라또', '메뉴', '와인', '무알콜', '위스키')  # 포스 상품 화면 상단 카테고리 탭


def selected_tab(im, lines):
    """상단 카테고리 탭 중 선택된(어두운 배경) 탭 이름.

    선택된 탭은 흰 글자라 OCR 이 못 읽을 때가 많지만, 가끔 오타로 읽히기도 한다('젤라또'→'질라또').
    그래서 믿을 수 있는 신호인 '선택 배경색 구간'을 먼저 쓰고, 글자는 유사도로 맞춘다.
    """
    from difflib import SequenceMatcher
    near = lambda t: max(TABS, key=lambda c: SequenceMatcher(None, c, t).ratio())
    def as_tab(t):
        c = near(t)
        return c if SequenceMatcher(None, c, t).ratio() >= 0.6 else None

    anchor = next((l for l in lines if as_tab(l['text'].strip()) and 120 < l['y'] < 320 and l['x'] < 800), None)
    if not anchor:
        return None
    y = anchor['y'] + anchor['h'] // 2
    # 선택된 탭 배경색(78,89,104)과 가까운 픽셀이 가로로 길게 이어진 구간 = 선택된 탭
    dark = lambda p: abs(p[0] - 78) < 14 and abs(p[1] - 89) < 14 and abs(p[2] - 104) < 14
    runs, start = [], None
    for x in range(300, 1100):
        if dark(im.getpixel((x, y - 12))):  # 글자 줄보다 살짝 위 = 배경만 있는 높이
            start = x if start is None else start
        elif start is not None:
            runs.append((start, x)); start = None
    runs = [r for r in runs if r[1] - r[0] > 40]
    if len(runs) != 1:
        return None
    lo, hi = runs[0]
    row = [l for l in lines if abs((l['y'] + l['h'] // 2) - y) < 12]

    # 1) 선택 배경 위에서 글자가 읽혔으면 그게 선택된 탭 (오타는 유사도로 바로잡는다)
    for l in row:
        if lo <= l['x'] + l['w'] // 2 <= hi:
            t = as_tab(l['text'].strip())
            if t:
                return t

    # 2) 안 읽혔으면 소거법 — 알려진 탭 중 화면에서 읽히지 않은 것이 정확히 하나면 그게 선택된 탭
    seen = {as_tab(l['text'].strip()) for l in row}
    missing = [t for t in TABS if t not in seen]
    return missing[0] if len(missing) == 1 else None


# ---------- 화면 이동 (상품 · 할인 > 와인) ----------
# 포스가 주문 현황 등 다른 페이지에 있어도 와인 목록까지 알아서 찾아간다.
# 여기서 하는 클릭은 '화면 이동'뿐 — 상품 데이터는 건드리지 않는다.

def _product_page(lines):
    """상품 목록 화면인가 — 오른쪽 끝 '고객용 채널 노출' 머리줄로 판별 (wines() 와 같은 기준)"""
    return any('노출' in l['text'] and l['x'] > 1650 and l['y'] < 500 for l in lines)


def _menu_button(lines):
    """좌상단 ≡ 위치. 배너 때문에 아래가 밀려도 맨 위 막대는 그대로라 '테이블' 글자를 기준으로 잡는다."""
    nav = next((l for l in lines if l['text'].strip() == '테이블' and l['y'] < 60), None)
    return (nav['x'] - 46, nav['y'] + nav['h'] // 2) if nav else (36, 29)


def _menu_item(lines):
    """열린 메뉴에서 '상품 · 할인' 줄. 섹션 머리글 '상품'(글자만)과 헷갈리지 않게 길이로 거른다.
    OCR 이 '성품•할인' 처럼 읽기도 해서 유사도로 찾는다."""
    from difflib import SequenceMatcher
    want = '상품할인'
    best = None
    for l in lines:
        if l['x'] < 600 or not (150 < l['y'] < 450):
            continue
        t = re.sub(r'[\s·•ㆍ∙.]', '', l['text'])
        if len(t) < 3:
            continue
        r = SequenceMatcher(None, want, t).ratio()
        if r >= 0.7 and (best is None or r > best[0]):
            best = (r, l)
    return best[1] if best else None


def _tab_point(lines, name):
    """카테고리 탭을 누를 좌표. '와인' 처럼 짧은 이름은 선택 여부와 상관없이 OCR 이 자주 못 읽어서,
    안 읽히면 TABS 순서상 앞뒤로 읽힌 탭 사이의 가운데를 누른다."""
    from difflib import SequenceMatcher
    def as_tab(t):
        c = max(TABS, key=lambda x: SequenceMatcher(None, x, t).ratio())
        return c if SequenceMatcher(None, c, t).ratio() >= 0.6 else None

    row = [l for l in lines if 120 < l['y'] < 320 and l['x'] < 1100 and as_tab(l['text'].strip())]
    if not row:
        return None
    cy = min(row, key=lambda l: l['y'])
    cy = cy['y'] + cy['h'] // 2
    found = {}
    for l in sorted(row, key=lambda l: l['x']):
        t = as_tab(l['text'].strip())
        found.setdefault(t, l)

    if name in found:
        l = found[name]
        return (l['x'] + l['w'] // 2, cy)
    i = TABS.index(name)
    prev = next((found[TABS[k]] for k in range(i - 1, -1, -1) if TABS[k] in found), None)
    nxt = next((found[TABS[k]] for k in range(i + 1, len(TABS)) if TABS[k] in found), None)
    if prev and nxt:  # 읽힌 이웃 탭 사이의 빈 자리 = 못 읽은 탭
        return ((prev['x'] + prev['w'] + nxt['x']) // 2, cy)
    return None


def ensure_wine_list(log=print, tries=6):
    """포스를 '상품 · 할인 > 와인' 목록 화면으로 맞춘다. 이미 그 화면이면 아무것도 하지 않는다.
    경로: (다른 페이지) → 좌상단 ≡ → '상품 · 할인' → 카테고리 탭 '와인'"""
    moved = False
    with Foreground():
        for _ in range(tries):
            im, (wl, wt) = capture()
            lines = ocr(im)
            at = lambda l: click_screen(wl + l['x'] + l['w'] // 2, wt + l['y'] + l['h'] // 2)

            if _product_page(lines):
                tab = selected_tab(im, lines)
                if tab == '와인':
                    return {'moved': moved, 'page': '상품 · 할인 > 와인'}
                pt = _tab_point(lines, '와인')
                if not pt:
                    raise RuntimeError(f"상품 화면에서 '와인' 카테고리 탭 위치를 찾지 못했습니다 (지금 탭: {tab!r}).")
                log(f"카테고리 {tab!r} → '와인' 으로 이동")
                click_screen(wl + pt[0], wt + pt[1])
                moved = True
                time.sleep(1.2)
                continue

            item = _menu_item(lines)
            if item:  # 메뉴가 열려 있다
                log("메뉴에서 '상품 · 할인' 선택")
                at(item)
                moved = True
                time.sleep(2.0)
                continue

            x, y = _menu_button(lines)
            log('상품 화면이 아니라서 좌상단 메뉴를 엽니다')
            click_screen(wl + x, wt + y)
            moved = True
            time.sleep(1.2)
    raise RuntimeError('포스를 상품 > 와인 목록 화면으로 옮기지 못했습니다. 포스 화면을 직접 확인해 주세요.')


def _norm(s):
    return re.sub(r'[\s\-–·,()（）]', '', str(s or ''))


def match_row(rows, name, price=None):
    """OCR 오타가 있어도 정식 이름과 가장 비슷한 행을 고른다. 가격이 주어지면 가격도 맞아야 함.
    1등과 2등 점수 차이가 작으면(헷갈리면) 고르지 않는다."""
    from difflib import SequenceMatcher
    target = _norm(name)
    scored = []
    for r in rows:
        if price is not None and r['price'] != price:
            continue
        cand = _norm(r['name'])
        # 화면 이름 뒤에 설명이 붙는 경우가 있어 앞부분 비교 점수도 함께 본다
        score = max(SequenceMatcher(None, target, cand).ratio(), SequenceMatcher(None, target, cand[:len(target)]).ratio())
        scored.append((score, r))
    scored.sort(key=lambda x: -x[0])
    if not scored or scored[0][0] < 0.6:
        return None, scored
    if len(scored) > 1 and scored[0][0] - scored[1][0] < 0.1:
        return None, scored
    return scored[0][1], scored


def click_screen(x, y):
    """실제 마우스 클릭 후 커서를 원래 자리로 되돌린다"""
    old = win32api.GetCursorPos()
    win32api.SetCursorPos((x, y))
    time.sleep(0.15)
    win32api.mouse_event(win32con.MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
    time.sleep(0.05)
    win32api.mouse_event(win32con.MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
    time.sleep(0.1)
    win32api.SetCursorPos(old)


def find_text(lines, text, region=None):
    """OCR 줄 중 text 를 포함하는 것 (region=(x0,y0,x1,y1) 안에서만). 정확히 하나여야 반환."""
    want = text.replace(' ', '')
    hits = [l for l in lines if want in l['text'].replace(' ', '')
            and (not region or (region[0] <= l['x'] <= region[2] and region[1] <= l['y'] <= region[3]))]
    return hits[0] if len(hits) == 1 else None


def open_add_form(log=print):
    """와인 목록 화면에서 [+ 상품 추가] 를 눌러 입력 화면을 연다 (입력·저장은 하지 않음)"""
    with Foreground():
        im, (wl, wt) = capture()
        lines = ocr(im)
        if selected_tab(im, lines) != '와인':
            raise RuntimeError('포스가 상품 > 와인 목록 화면이 아닙니다. 중단합니다.')
        btn = find_text(lines, '상품 추가', region=(1600, 60, 1920, 140))  # 오른쪽 위 파란 버튼만
        if not btn:
            raise RuntimeError('[+ 상품 추가] 버튼을 찾지 못했습니다. 중단합니다.')
        click_screen(wl + btn['x'] + btn['w'] // 2, wt + btn['y'] + btn['h'] // 2)
        time.sleep(1.5)
        im2, _ = capture(os.path.join(HERE, '.debug', 'add-form.png'))
        log('입력 화면 캡처: .debug/add-form.png')
        return ocr(im2)


def _key_combo(*vks):
    for vk in vks:
        win32api.keybd_event(vk, 0, 0, 0)
    for vk in reversed(vks):
        win32api.keybd_event(vk, 0, win32con.KEYEVENTF_KEYUP, 0)
    time.sleep(0.1)


_clip_owner = None


def _clip_hwnd():
    """클립보드 소유자용 숨은 창 — 소유자 없이(NULL) 열면 Windows 가 쓰기를 간헐적으로 거부한다"""
    global _clip_owner
    if not _clip_owner:
        _clip_owner = win32gui.CreateWindowEx(0, 'STATIC', 'pos-clipboard', 0, 0, 0, 0, 0, 0, 0, 0, None)
    return _clip_owner


def _clipboard(write=None, retries=40):
    """클립보드 읽기(write=None) / 쓰기. 다른 프로그램이 잡고 있으면 잠깐 기다렸다 재시도."""
    import win32clipboard as cb
    for i in range(retries):
        try:
            cb.OpenClipboard(_clip_hwnd())
        except Exception:
            time.sleep(0.1)
            continue
        try:
            if write is None:
                return cb.GetClipboardData(win32con.CF_UNICODETEXT) if cb.IsClipboardFormatAvailable(win32con.CF_UNICODETEXT) else None
            cb.EmptyClipboard()
            cb.SetClipboardData(win32con.CF_UNICODETEXT, str(write))
            return True
        except Exception:
            time.sleep(0.1)
        finally:
            try:
                cb.CloseClipboard()
            except Exception:
                pass
    raise RuntimeError('클립보드를 사용할 수 없습니다 (다른 프로그램이 사용 중).')


class ClipboardGuard:
    """작업 전 클립보드 내용을 저장했다가 작업이 모두 끝난 뒤 한 번에 복원.
    (붙여넣기 직후 바로 복원하면 포스가 늦게 읽어 예전 내용이 붙는 문제가 있었음)"""

    def __enter__(self):
        self.old = _clipboard()
        return self

    def __exit__(self, *exc):
        time.sleep(0.5)
        if self.old is not None:
            try:
                _clipboard(self.old)
            except RuntimeError:
                pass
        return False


def _send_unicode(text):
    """글자를 유니코드 키 입력으로 직접 보낸다 (한/영 입력기 상태와 무관, 클립보드 미사용)"""
    from ctypes import wintypes

    class KEYBDINPUT(ctypes.Structure):
        _fields_ = [('wVk', wintypes.WORD), ('wScan', wintypes.WORD), ('dwFlags', wintypes.DWORD),
                    ('time', wintypes.DWORD), ('dwExtraInfo', ctypes.POINTER(ctypes.c_ulong))]

    class INPUT(ctypes.Structure):
        class _U(ctypes.Union):
            _fields_ = [('ki', KEYBDINPUT), ('pad', ctypes.c_byte * 32)]
        _anonymous_ = ('u',)
        _fields_ = [('type', wintypes.DWORD), ('u', _U)]

    KEYEVENTF_UNICODE, KEYEVENTF_KEYUP = 0x0004, 0x0002
    for ch in str(text):
        for flags in (KEYEVENTF_UNICODE, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP):
            inp = INPUT(type=1, ki=KEYBDINPUT(wVk=0, wScan=ord(ch), dwFlags=flags, time=0, dwExtraInfo=None))
            ctypes.windll.user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))
        time.sleep(0.02)


def type_text(text):
    """현재 입력칸 내용을 모두 지우고 text 를 입력한다"""
    _key_combo(win32con.VK_CONTROL, ord('A'))
    win32api.keybd_event(win32con.VK_DELETE, 0, 0, 0)
    win32api.keybd_event(win32con.VK_DELETE, 0, win32con.KEYEVENTF_KEYUP, 0)
    time.sleep(0.1)
    _send_unicode(text)
    time.sleep(0.3)


MODAL = (590, 170, 1330, 910)  # 상품 추가 창 영역 (1920x1080 전체화면 포스 기준)


def _in_modal(l):
    return MODAL[0] <= l['x'] <= MODAL[2] and MODAL[1] <= l['y'] <= MODAL[3]


def _modal_lines():
    im, (wl, wt) = capture()
    lines = [l for l in ocr(im) if _in_modal(l)]
    return im, (wl, wt), lines


def _label(lines, text):
    want = text.replace(' ', '')
    hits = [l for l in lines if l['text'].replace(' ', '').replace('•', '').replace('.', '').startswith(want)]
    return min(hits, key=lambda l: l['y']) if hits else None


def add_product(p, log=print, submit=True):
    """[+ 상품 추가] 창에 입력하고 등록한다.
    p = {name, kioskName, kioskNameEn, desc, category, price}
    값이 화면에 제대로 들어갔는지 확인한 뒤에만 [등록] 을 누른다. 확인 실패 시 등록하지 않고 창을 그대로 둔다."""
    with Foreground():
        im, (wl, wt), lines = _modal_lines()
        if not (_label(lines, '상품 추가') and _label(lines, '닫기')):
            open_add_form(log)  # 와인 목록 화면에서만 열린다 (아니면 중단)
            im, (wl, wt), lines = _modal_lines()
            if not _label(lines, '상품 추가'):
                raise RuntimeError('상품 추가 창이 열리지 않았습니다. 중단합니다.')
        at = lambda x, y: click_screen(wl + x, wt + y)

        # 1) 맨 위: 상품이름 · 키오스크용 이름 · 한글설명
        scroll(-15)
        time.sleep(0.7)
        im, (wl, wt), lines = _modal_lines()
        name_lbl = next((l for l in lines if l['text'].replace(' ', '').startswith('상품이름') and 440 < l['y'] < 520), None)
        kiosk_lbl = _label(lines, '키오스크')
        if not (name_lbl and kiosk_lbl):
            raise RuntimeError('상품이름/키오스크/한글설명 칸 위치를 찾지 못했습니다. 입력하지 않고 중단합니다.')
        at(878, name_lbl['y'] + 52); type_text(p['name'])
        at(760, kiosk_lbl['y'] + 50); type_text(p['kioskName'])
        at(1000, kiosk_lbl['y'] + 50); type_text(p['kioskNameEn'])
        at(960, kiosk_lbl['y'] + 125); type_text(p['desc'])  # 한글설명 칸 = 키오스크 라벨 기준 위치 (값이 있으면 안내문구가 없어서)
        log('입력: 상품이름 · 키오스크용 이름 · 한글설명')

        # 2) 카테고리 · 기본가격
        scroll(3)
        time.sleep(0.7)
        im, (wl, wt), lines = _modal_lines()
        cat_lbl = _label(lines, '카테고리')
        if not cat_lbl:
            raise RuntimeError('카테고리 선택 칸을 찾지 못했습니다. 중단합니다.')
        chip = next((l for l in lines if l['text'].strip() == p['category'] and 0 < l['y'] - cat_lbl['y'] < 60), None)
        if not chip:
            raise RuntimeError(f"'{p['category']}' 카테고리를 찾지 못했습니다. 중단합니다.")
        if not chip_selected(im, chip):  # 이미 선택된 칩을 또 누르면 선택 해제될 수 있음
            at(chip['x'] + chip['w'] // 2, chip['y'] + chip['h'] // 2)
            time.sleep(0.4)
            im, _ = capture()
            if not chip_selected(im, chip):
                raise RuntimeError(f"'{p['category']}' 카테고리가 선택되지 않았습니다. 등록하지 않고 중단합니다.")
        price_lbl = _label(lines, '기본가격')
        if not price_lbl:
            raise RuntimeError('기본가격 칸을 찾지 못했습니다. 중단합니다.')
        at(900, price_lbl['y'] + 44); type_text(str(p['price']))
        log(f"입력: 카테고리 {p['category']} · 기본가격 {p['price']}")
        at(price_lbl['x'] + 20, price_lbl['y'] + 8)  # 라벨을 눌러 입력칸 포커스 해제 → 깜빡이는 커서가 OCR 을 방해하지 않게
        time.sleep(0.5)

        # 3) 입력 확인 (위 → 중간 순서로 캡처해서 값이 들어갔는지)
        im_mid, _, mid = _modal_lines()
        capture(os.path.join(HERE, '.debug', 'add-filled-mid.png'))
        scroll(-15)
        time.sleep(0.7)
        im_top, _, top = _modal_lines()
        capture(os.path.join(HERE, '.debug', 'add-filled-top.png'))
        joined_top = ' '.join(l['text'] for l in top).replace(' ', '')
        price_txt = ''.join(re.sub(r'\D', '', l['text']) for l in mid if price_lbl and 20 < l['y'] - price_lbl['y'] < 70 and l['x'] < 1200)
        problems = []
        for key in ('name', 'kioskName', 'kioskNameEn', 'desc'):
            if str(p[key]).replace(' ', '') not in joined_top:
                problems.append(f'{key}={p[key]!r} 확인 안 됨')
        if price_txt != str(p['price']):
            # 가격 칸만 잘라 2배로 키워 한 번 더 읽기
            box = (630, price_lbl['y'] + 20, 1240, price_lbl['y'] + 70)
            big = im_mid.crop(box).resize(((box[2] - box[0]) * 2, (box[3] - box[1]) * 2))
            price_txt = ''.join(re.sub(r'\D', '', l['text']) for l in ocr(big))
            problems.append(f"가격 {p['price']} 확인 안 됨 (화면: {price_txt!r})")
        if problems:
            raise RuntimeError('입력값 확인 실패 → 등록하지 않고 창을 그대로 둡니다: ' + ', '.join(problems))
        log('확인: 입력값이 화면에 모두 들어감')
        if not submit:
            return {'submitted': False}

        # 4) 등록
        im, (wl, wt), lines = _modal_lines()
        # [등록] 은 파란 버튼의 흰 글자라 OCR 이 못 읽는다 → OCR 로 읽히는 [닫기] 오른쪽, 버튼 색으로 확인
        close = next((l for l in lines if l['text'].strip() == '닫기' and l['y'] > 800), None)
        if not close:
            raise RuntimeError('[닫기] 버튼을 찾지 못해 [등록] 위치를 정할 수 없습니다. 등록하지 않았습니다.')
        bx, by = close['x'] + close['w'] // 2 + 140, close['y'] + close['h'] // 2
        r, g, b = im.getpixel((bx, by - 14))  # 글자 위쪽 = 버튼 배경
        if not (b > 200 and r < 100):  # 진한 파랑(활성)이 아니면 — 연파랑이면 필수값 누락으로 비활성
            raise RuntimeError(f'[등록] 버튼이 활성 상태가 아닙니다 (색 {(r, g, b)}). 등록하지 않았습니다.')
        at(bx, by)
        time.sleep(2.0)

        # 5) 등록 확인: 창이 닫히고 와인 목록에 새 상품이 있는지
        im, _ = capture(os.path.join(HERE, '.debug', 'add-after.png'))
        lines = ocr(im)
        if _label([l for l in lines if _in_modal(l)], '상품 추가') and _label([l for l in lines if _in_modal(l)], '닫기'):
            raise RuntimeError('[등록] 을 눌렀지만 창이 닫히지 않았습니다. 포스 화면을 확인하세요 (오류 메시지가 있을 수 있음).')
        found = None
        for _ in range(4):
            found, _ = match_row(all_wines_in_view(), p['name'], p['price'])
            if found:
                break
            scroll(6)
            time.sleep(0.6)
        log(f"등록 완료{' · 와인 목록에서 확인됨' if found else ' (목록에서 아직 확인 못 함)'}")
        return {'submitted': True, 'listed': bool(found)}


def chip_selected(im, chip):
    """카테고리 칩 배경이 연파랑(선택)인지 — 글자 왼쪽 여백의 배경색으로 판별"""
    r, g, b = im.getpixel((chip['x'] - 6, chip['y'] + chip['h'] // 2))
    return b > 245 and b - r > 12


def all_wines_in_view():
    try:
        return wines()
    except RuntimeError:
        return []


def set_expose(name, on, price=None, log=print):
    """와인 상품의 '고객용 채널 노출' 토글을 on/off 로 맞춘다. 안전 확인을 모두 통과해야 클릭한다."""
    with Foreground():
        scroll_top()
        row = None
        for _ in range(6):
            im, (wl, wt) = capture()
            lines = ocr(im)
            texts = [l['text'].strip() for l in lines]
            # 안전 확인 1: 상품 목록 화면 + 선택된 탭이 '와인'
            tab = selected_tab(im, lines)
            if not any('노출' in t for t in texts) or tab != '와인':
                raise RuntimeError(f"포스가 상품 > 와인 목록 화면이 아닙니다 (선택된 탭: {tab!r}). 클릭하지 않고 중단합니다.")
            row, scored = match_row(wines(im), name, price)
            if row:
                break
            scroll(6)
            time.sleep(0.6)
        if not row:
            raise RuntimeError(f"'{name}' 와인을 목록에서 확실하게 찾지 못해 중단합니다. 후보: {[(round(s, 2), r['name']) for s, r in scored[:3]]}")
        log(f"찾음: '{row['name']}' ({row['priceText']}) 현재 노출 {'ON' if row['expose'] else 'off'}")
        if row['expose'] == on:
            return {'changed': False, 'name': row['name'], 'expose': on}

        head = next(l for l in lines if '노출' in l['text'] and l['x'] > 1650 and l['y'] < 500)
        x = head['x'] + head['w'] // 2
        y = row['y']
        # 안전 확인 2: 클릭 위치가 '고객용 채널 노출' 열 · 상품 목록 영역 안인지
        if not (head['y'] + 30 < y < im.size[1] - 40) or not (1700 < x < 1900):
            raise RuntimeError(f'클릭 위치가 허용 영역 밖입니다 ({x},{y}). 중단합니다.')
        click_screen(wl + x, wt + y)

        # 확인: 토글 애니메이션·저장 반영까지 시간이 걸려 몇 번 다시 읽는다 (다시 클릭하지는 않음)
        row2 = None
        for _ in range(4):
            time.sleep(1.2)
            row2, _ = match_row(wines(), name, price)
            if row2 and row2['expose'] == on:
                break
        if not row2 or row2['expose'] != on:
            raise RuntimeError(f"클릭했지만 노출 {'ON' if on else 'off'} 로 바뀐 것이 확인되지 않습니다. 포스 화면을 확인하세요.")
        log(f"완료: '{row2['name']}' 노출 {'ON' if on else 'off'} 확인")
        return {'changed': True, 'name': row2['name'], 'expose': on}


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'wines'
    if cmd == 'capture':
        # 포스를 잠깐 앞으로 띄워 최신 화면을 캡처 (뒤에 가려져 있으면 예전 화면이 찍힘)
        with Foreground():
            capture(sys.argv[2])
        print('ok')
    elif cmd == 'wines':
        print(json.dumps(wines(), ensure_ascii=False))
    elif cmd == 'all':
        with Foreground():
            rows = all_wines()
            scroll_top()
        print(json.dumps(rows, ensure_ascii=False))
    elif cmd == 'add':
        # python pos_screen.py add '<json>' [--no-submit]
        spec = json.loads(sys.argv[2])
        try:
            print(json.dumps(add_product(spec, submit='--no-submit' not in sys.argv), ensure_ascii=False))
        except RuntimeError as e:
            print(f'중단: {e}')
            sys.exit(1)
    elif cmd == 'peek':
        # python pos_screen.py peek <스크롤 칸수(+아래/-위)> <저장 파일> — 스크롤 후 캡처 + OCR (클릭 없음)
        with Foreground():
            if int(sys.argv[2]):
                scroll(int(sys.argv[2]))
                time.sleep(0.6)
            im, _ = capture(sys.argv[3])
            lines = ocr(im)
        print(json.dumps([(l['x'], l['y'], l['text']) for l in lines], ensure_ascii=False))
    elif cmd == 'open-add':
        lines = open_add_form()
        print(json.dumps([(l['x'], l['y'], l['text']) for l in lines], ensure_ascii=False))
    elif cmd == 'nav':
        # python pos_screen.py nav — 포스를 상품 > 와인 화면으로 옮긴다 (이동 클릭만)
        try:
            print(json.dumps(ensure_wine_list(), ensure_ascii=False))
        except RuntimeError as e:
            print(f'중단: {e}')
            sys.exit(1)
    elif cmd == 'expose':
        # python pos_screen.py expose "<와인 이름>" on|off [가격]
        name, onoff = sys.argv[2], sys.argv[3]
        price = int(sys.argv[4]) if len(sys.argv) > 4 else None
        try:
            print(json.dumps(set_expose(name, onoff == 'on', price), ensure_ascii=False))
        except RuntimeError as e:
            print(f'중단: {e}')
            sys.exit(1)
    elif cmd == 'scroll':
        scroll(int(sys.argv[2]))
        print('ok')
