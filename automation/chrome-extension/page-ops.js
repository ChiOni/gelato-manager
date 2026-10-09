// ---------- 페이지 안에서 실행되는 동작 (DOM 조작) ----------
// 이 함수는 탭 안에 주입되므로 외부 변수를 참조하면 안 된다.
async function pageOp(action, p) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // within 이 여러 개면 마지막(가장 위에 뜬 모달) 사용
  const root = () => {
    if (!p.within) return document.body;
    const el = [...document.querySelectorAll(p.within)].filter(visible).pop();
    if (!el) throw new Error(`'${p.within}' 영역이 화면에 없음`);
    return el;
  };
  const clickables = () => [...root().querySelectorAll('button, a, [role=button], [role=tab], [role=switch], [role=checkbox], [role=menuitem], [role=option], label, input, select, textarea, li, [onclick], [tabindex]')].filter(visible);

  function findByText(text, exact) {
    const want = norm(text);
    const cands = clickables().filter((el) => { const t = norm(el.innerText || el.value || el.getAttribute('aria-label') || ''); return exact ? t === want : t.includes(want); });
    // 가장 안쪽(작은) 요소 우선
    cands.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
    if (cands[p.nth || 0]) return cands[p.nth || 0];
    // 버튼 역할이 없는 div(탭·세그먼트 등): 자기 텍스트가 일치하는 가장 안쪽 요소
    const any = [...root().querySelectorAll('*')].filter(visible).filter((el) => { const t = norm(el.innerText || ''); return exact ? t === want : t.includes(want); });
    any.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
    return any[p.nth || 0];
  }
  // rowSelector 행들 중 textSelector 텍스트가 text 와 같은 행
  function findRow() {
    const want = norm(p.text);
    return [...document.querySelectorAll(p.rowSelector)].find((row) => {
      const t = p.textSelector ? row.querySelector(p.textSelector) : row;
      return t && norm(t.innerText) === want;
    });
  }
  function realClick(el) {
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
    el.dispatchEvent(new PointerEvent('pointerdown', o)); el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new PointerEvent('pointerup', o)); el.dispatchEvent(new MouseEvent('mouseup', o));
    el.click();
  }

  try {
    if (action === 'dump') {
      const els = clickables();
      els.forEach((el, i) => el.setAttribute('data-mx', String(i)));
      return {
        url: location.href,
        title: document.title,
        text: norm(root().innerText || '').slice(0, p.maxText || 6000),
        controls: els.map((el, i) => `${i}\t${el.tagName.toLowerCase()}${el.type ? '[' + el.type + ']' : ''}${el.getAttribute('role') ? '{' + el.getAttribute('role') + '}' : ''}${el.checked !== undefined && (el.type === 'checkbox' || el.type === 'radio') ? (el.checked ? ' ☑' : ' ☐') : ''}${el.getAttribute('aria-checked') ? ' aria-checked=' + el.getAttribute('aria-checked') : ''}\t${norm(el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').slice(0, 60)}`).filter((l) => l.split('\t')[2] || /input|select|switch|checkbox/.test(l)),
      };
    }
    if (action === 'list') {
      // 목록 읽기: [{text, sub, cls, parentCls, ctx}]
      return [...document.querySelectorAll(p.selector)].map((el) => {
        let ctx = null;
        if (p.ctxSel) { for (let a = el.parentElement; a; a = a.parentElement) { const c = a.querySelector(p.ctxSel); if (c) { ctx = norm(c.innerText); break; } } }
        const sub = p.sub ? el.querySelector(p.sub) : null;
        return { text: norm(el.innerText), sub: sub ? norm(sub.innerText) : null, cls: String(el.className), parentCls: el.parentElement ? String(el.parentElement.className) : '', ctx, visible: visible(el) };
      });
    }
    if (action === 'groupedButtons') {
      // DOM 순서대로 "그룹 제목"(다음 형제가 headRe 로 시작) 아래의 버튼 중 textRe 에 맞는 것을 모은다. data-mx-opt 로 표시.
      const headRe = new RegExp(p.headRe), textRe = new RegExp(p.textRe);
      const out = [];
      let group = null, i = 0;
      for (const el of document.body.querySelectorAll('*')) {
        const next = el.nextElementSibling;
        if (next && headRe.test(norm(next.textContent))) { const t = norm(el.textContent); group = p.titles.includes(t) ? t : null; }
        if (el.tagName === 'BUTTON' && group) {
          const text = norm(el.innerText);
          if (textRe.test(text)) { el.setAttribute('data-mx-opt', String(i)); out.push({ i: i++, group, text }); }
        }
      }
      return out;
    }
    if (action === 'clickAfter') {
      // anchorText 와 텍스트가 같은 요소 다음에 처음 나오는, targetText 버튼을 클릭
      const all = [...root().querySelectorAll('*')];
      const anchor = all.find((el) => [...el.childNodes].some((n) => n.nodeType === 3 && norm(n.textContent) === norm(p.anchorText)) || (el.children.length === 0 && norm(el.textContent) === norm(p.anchorText)));
      if (!anchor) return { __error: `'${p.anchorText}' 기준 요소를 찾지 못함` };
      const btn = all.slice(all.indexOf(anchor)).find((el) => el.tagName === 'BUTTON' && visible(el) && norm(el.innerText) === norm(p.targetText));
      if (!btn) return { __error: `'${p.anchorText}' 다음의 [${p.targetText}] 버튼을 찾지 못함` };
      realClick(btn);
      await sleep(p.wait || 800);
      return { clicked: p.targetText };
    }
    if (action === 'clickRow') {
      const row = findRow();
      if (!row) return { __error: `'${p.text}' 행을 찾지 못함` };
      const el = p.target ? row.querySelector(p.target) : row;
      if (!el) return { __error: `'${p.text}' 행 안에서 ${p.target} 을 찾지 못함` };
      realClick(el);
      await sleep(p.wait || 800);
      return { clicked: p.text };
    }
    if (action === 'waitGone') {
      const end = Date.now() + (p.timeout || 15000);
      while (Date.now() < end) {
        const el = document.querySelector(p.selector);
        if (!el || !visible(el)) return { gone: true };
        await sleep(300);
      }
      return { __error: `${p.selector} 가 사라지지 않음` };
    }
    if (action === 'html') {
      const el = p.selector ? document.querySelector(p.selector) : document.documentElement;
      return { html: el ? el.outerHTML : null };
    }
    if (action === 'click') {
      const el = p.mx != null ? document.querySelector(`[data-mx="${p.mx}"]`) : p.selector ? document.querySelector(p.selector) : findByText(p.text, p.exact !== false);
      if (!el) return { __error: `클릭할 요소를 찾지 못함: ${JSON.stringify(p)}` };
      realClick(el);
      await sleep(p.wait || 600);
      return { clicked: norm(el.innerText || el.value || '').slice(0, 60) };
    }
    if (action === 'fill') {
      const el = p.mx != null ? document.querySelector(`[data-mx="${p.mx}"]`) : [...root().querySelectorAll(p.selector)].filter(visible)[p.nth || 0];
      if (!el) return { __error: `입력칸을 찾지 못함: ${JSON.stringify(p)}` };
      el.focus();
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, p.value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
      await sleep(300);
      return { value: el.value };
    }
    if (action === 'waitText') {
      const end = Date.now() + (p.timeout || 20000);
      while (Date.now() < end) {
        if (norm(root().innerText).includes(norm(p.text))) return { found: true };
        await sleep(300);
      }
      return { __error: `'${p.text}' 텍스트가 ${(p.timeout || 20000) / 1000}초 안에 나타나지 않음` };
    }
    return { __error: '알 수 없는 action: ' + action };
  } catch (e) {
    return { __error: String(e && e.message || e) };
  }
}
