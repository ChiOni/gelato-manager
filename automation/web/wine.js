// 와인 탭 — 목록의 주인은 포스다. 불러오면 포스 와인이 그대로 판매중/비활성 두 칸이 된다.
// index.html 스크립트가 전역에 $·esc·S 등을 선언하므로 전체를 함수로 감싸 이름이 겹치지 않게 한다.
(() => {
  'use strict';

  const ROOT = document.getElementById('tab-wine');
  if (!ROOT) return;

  const $ = (s) => ROOT.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const won = (n) => Number(n || 0).toLocaleString('ko-KR');
  const norm = (s) => String(s || '').replace(/[\s\-–·,()（）]/g, '');
  const hhmm = (t) => (t ? new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '');
  const label = (w) => w.name || w.posName;

  let W = null;
  let ui = { q: '', modal: null, dockSeen: null };

  // ---------- 서버 통신 ----------

  async function api(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-menu-app': '1' },
      body: JSON.stringify(body || {}),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || '요청에 실패했어요');
    return j;
  }

  let toastTimer = null;
  function toast(msg) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3600);
  }

  function connect() {
    const es = new EventSource('/api/wine/events');
    es.addEventListener('wine', (e) => {
      const prev = W;
      W = JSON.parse(e.data);
      notify(prev, W);
      render();
    });
  }

  // 포스 작업은 20~60초 걸려서 알바생이 화면을 떠나 있을 수 있다
  function notify(prev, next) {
    if (!prev) return;
    for (const j of next.jobs) {
      const p = prev.jobs.find((x) => x.id === j.id);
      if (!p || p.state === j.state) continue;
      if (j.state === 'done') toast(`✅ ${j.name ? `'${j.name}' ` : ''}${j.label} 완료`);
      if (j.state === 'failed') toast(`⚠️ ${j.name ? `'${j.name}' ` : ''}${j.label} 실패 — 아래 설명을 확인하세요`);
    }
  }

  // ---------- 틀 ----------

  ROOT.innerHTML = `
    <section>
      <h2>와인 관리</h2>
      <div class="wbar">
        <span class="wseen" id="wseen"></span>
        <span class="right">
          <button class="btn sm" id="wsyncBtn">포스에서 불러오기</button>
          <button class="btn sm primary" id="waddBtn">+ 새 와인</button>
        </span>
      </div>
      <div class="cols">
        <div class="panel">
          <div class="phead"><h3>판매중</h3><span class="count" id="wliveCount">0</span>
            <span class="phint right">포스 노출 ON</span></div>
          <div id="wlive"><div class="empty">불러오는 중…</div></div>
        </div>
        <div class="panel">
          <div class="phead"><h3>비활성</h3><span class="count off" id="woffCount">0</span>
            <span class="phint right">포스 노출 OFF</span></div>
          <div class="searchrow"><input class="search" id="wsearch" placeholder="와인 이름으로 찾기"></div>
          <div id="woff"><div class="empty">불러오는 중…</div></div>
        </div>
      </div>
      <div id="wextra"></div>
    </section>
    <div id="wdockwrap"></div>
    <div id="wmodalwrap"></div>`;

  // ---------- 목록 ----------

  const isPending = (w) => (W?.pending || []).includes(w.id);

  function warnOf(w) {
    if (w.posState === 'adding') return ['포스 등록 중', '포스에 상품을 등록하는 중이에요'];
    if (w.posState === 'failed') return ['⚠ 포스 실패', w.posNote || ''];
    if (w.posExpose != null && w.posExpose !== w.active) return ['⚠ 포스와 다름', `화면은 ${w.active ? '판매중' : '비활성'}, 포스 노출은 ${w.posExpose ? 'ON' : 'OFF'} 이에요`];
    return null;
  }

  function thumb(w) {
    const inner = w.image
      ? `<img src="/api/wine/image/${encodeURIComponent(w.image)}" alt="">`
      : esc(label(w).slice(0, 1));
    return `<span class="wthumb" data-wact="open" data-id="${w.id}">${inner}</span>`;
  }

  function row(w) {
    const pending = isPending(w);
    const warn = warnOf(w);
    const job = (W.jobs || []).find((j) => j.wineId === w.id && (j.state === 'running' || j.state === 'queued'));
    const n = label(w);

    const stock = `<span class="wstep" title="미개봉 병 수 (입고·바틀 판매·파손 때 고치세요)">
        <button data-wact="stock" data-id="${w.id}" data-d="-1" ${w.stock <= 0 || pending ? 'disabled' : ''}>−</button>
        <span class="n ${w.stock === 0 ? 'zero' : ''}">${w.stock}</span>
        <button data-wact="stock" data-id="${w.id}" data-d="1" ${pending ? 'disabled' : ''}>+</button>
      </span>`;
    const openTgl = `<button class="sw ${w.opened ? 'on' : ''}" data-wact="open-toggle" data-id="${w.id}" data-on="${w.opened ? 1 : 0}"
        title="${w.opened ? '다 마셨으면 눌러서 끄세요' : '새 병을 열면 눌러주세요 (미개봉 −1)'}"
        ${pending || (w.stock === 0 && !w.opened) ? 'disabled' : ''}>개봉 중</button>`;

    const act = pending
      ? `<span class="busytag"><span class="spinner"></span>${esc(job ? (job.state === 'queued' ? '대기 중' : job.label) : '처리 중')}</span>`
      : `<span class="wlbl">미개봉</span>${stock}${openTgl}` + (w.active
        ? `<button class="btn sm" data-wact="expose" data-id="${w.id}" data-on="0">비활성</button>`
        : `<button class="btn sm brand" data-wact="expose" data-id="${w.id}" data-on="1"
             title="${w.stock === 0 && !w.opened ? '미개봉 재고를 먼저 입력해 주세요' : '포스 노출을 켜고 판매중으로 옮겨요'}"
             ${w.stock === 0 && !w.opened ? 'disabled' : ''}>판매 시작</button>`);

    return `<div class="witem ${pending ? 'busy' : ''}">
      ${thumb(w)}
      <div class="wmain" data-wact="open" data-id="${w.id}" title="눌러서 사진·설명·바틀 가격 적기">
        <div class="wname">${esc(n)}${w.kind && w.kind !== '기타' ? `<span class="wkind">${esc(w.kind)}</span>` : ''}${warn ? `<span class="wwarn" title="${esc(warn[1])}">${esc(warn[0])}</span>` : ''}</div>
        ${w.desc ? `<div class="wdesc">${esc(w.desc)}</div>` : ''}
        <div class="wmeta">글라스 <b>${won(w.posPrice)}</b>${w.bottlePrice ? `<span class="sep">·</span>바틀 <b>${won(w.bottlePrice)}</b>` : ''}</div>
      </div>
      <div class="wact">${act}</div>
      ${warn && warn[1] && w.posState === 'failed' ? `<div class="wnote">${esc(warn[1])}</div>` : ''}
    </div>`;
  }

  function renderLists() {
    const all = W.wines || [];
    const live = all.filter((w) => w.active);
    const off = all.filter((w) => !w.active);
    $('#wliveCount').textContent = live.length;
    $('#woffCount').textContent = off.length;

    const none = W.posSeenAt
      ? '판매중인 와인이 없어요'
      : '아직 포스를 읽지 않았어요 — [포스에서 불러오기]를 눌러주세요';
    $('#wlive').innerHTML = live.length ? live.map(row).join('') : `<div class="empty">${none}</div>`;

    const q = norm(ui.q);
    const hits = off.filter((w) => !q || norm(label(w)).includes(q) || norm(w.posName).includes(q));
    $('#woff').innerHTML = hits.length
      ? hits.map(row).join('')
      : `<div class="empty">${q ? '찾는 와인이 없어요' : '비활성 와인이 없어요'}</div>`;
  }

  function renderBar() {
    $('#wseen').textContent = W.posSeenAt
      ? `포스 확인 ${hhmm(W.posSeenAt)} · 와인 ${(W.wines || []).length}종`
      : '아직 포스를 읽지 않았어요';
    const busy = !!W.running || W.queued > 0;
    const syncing = W.running && (W.jobs || []).find((j) => j.id === W.running)?.kind === 'sync';
    $('#wsyncBtn').disabled = busy;
    $('#wsyncBtn').textContent = syncing ? '불러오는 중…' : '포스에서 불러오기';
  }

  function renderExtra() {
    const ex = W.posExcluded || [];
    $('#wextra').innerHTML = ex.length
      ? `<div class="wextra"><div class="wxhint">제외한 포스 상품 ${ex.length}개 — ${ex.map((e) => `${esc(e.name)}(${esc(e.why)})`).join(', ')}</div></div>`
      : '';
  }

  // ---------- 작업 현황 ----------

  function renderDock() {
    const jobs = W.jobs || [];
    const cur = jobs.find((j) => j.state === 'running') || jobs.find((j) => j.state === 'queued') || jobs[0];
    if (!cur || ui.dockSeen === cur.id) { $('#wdockwrap').innerHTML = ''; return; }
    const waiting = jobs.filter((j) => j.state === 'queued').length;
    const spin = cur.state === 'running' ? '<span class="spinner"></span>' : '';
    const text = { queued: '대기 중', running: cur.message || '진행 중', done: cur.message || '완료', failed: cur.message }[cur.state] || '';
    $('#wdockwrap').innerHTML = `<div class="wdock"><div class="wdockin ${cur.state}">
      ${spin}<b>${esc(cur.name ? `${cur.name} ${cur.label}` : cur.label)}</b>
      <span class="sum">${esc(text)}${waiting ? ` · 대기 ${waiting}건` : ''}</span>
      <span class="right">
        ${cur.state === 'failed' ? `<button class="btn sm" data-wact="retry" data-id="${cur.id}">다시 시도</button>` : ''}
        ${cur.state === 'done' || cur.state === 'failed' ? `<button class="btn sm" data-wact="dock-close" data-id="${cur.id}">닫기</button>` : ''}
      </span>
    </div></div>`;
  }

  // ---------- 모달 ----------

  const KIND_OPTS = (sel) => (W.kinds || []).map((k) => `<option value="${esc(k)}" ${k === sel ? 'selected' : ''}>${esc(k)}</option>`).join('');

  const openModal = (mode, data) => { ui.modal = { mode, ...data }; render(); };
  const closeModal = () => { ui.modal = null; render(); };

  function renderModal() {
    const m = ui.modal;
    if (!m) { $('#wmodalwrap').innerHTML = ''; return; }
    const w = m.mode === 'edit' ? (W.wines || []).find((x) => x.id === m.id) : null;
    if (m.mode === 'edit' && !w) { ui.modal = null; $('#wmodalwrap').innerHTML = ''; return; }
    const f = m.form;
    const add = m.mode === 'add';
    const prev = m.img === null ? '' : (m.img || (w?.image ? `/api/wine/image/${encodeURIComponent(w.image)}` : ''));

    $('#wmodalwrap').innerHTML = `<div class="wmodal" data-wact="backdrop"><div class="wsheet">
      <div class="wshead"><h3>${add ? '새 와인 추가' : esc(label(w))}</h3>
        <span class="right"><button class="btn ghost sm" data-wact="close">닫기</button></span></div>
      <div class="wsbody">
        ${add ? `
          <div class="wfield"><label for="wfName">와인 이름 <span class="sub">포스에 이 이름으로 등록돼요</span></label>
            <input id="wfName" maxlength="60" value="${esc(f.posName)}" placeholder="예) 가비-화이트"></div>
          <div class="wrow2">
            <div class="wfield"><label for="wfNameEn">영문 이름 <span class="sub">키오스크용</span></label>
              <input id="wfNameEn" maxlength="40" value="${esc(f.nameEn)}" placeholder="예) Gavi"></div>
            <div class="wfield"><label for="wfGlass">글라스 가격</label>
              <div class="wunit"><input id="wfGlass" inputmode="numeric" value="${esc(f.glassPrice)}"><span>원</span></div></div>
          </div>`
        : `<div class="wposinfo">
            <div><span class="k">포스 상품명</span><b>${esc(w.posName)}</b></div>
            <div><span class="k">글라스 가격</span><b>${won(w.posPrice)}원</b> <span class="sub">포스 기본가격</span></div>
            <div><span class="k">포스 노출</span>${w.posExpose == null ? '아직 모름' : (w.posExpose ? 'ON (판매중)' : 'OFF (비활성)')}
              · 확인 ${w.posSyncAt ? hhmm(w.posSyncAt) : '없음'}</div>
            ${w.posNote ? `<div class="warn">${esc(w.posNote)}</div>` : ''}
          </div>
          <div class="wfield"><label for="wfName">보이는 이름 <span class="sub">비워두면 포스 이름을 그대로 써요</span></label>
            <input id="wfName" maxlength="40" value="${esc(f.name)}" placeholder="${esc(w.posName)}"></div>`}

        <div class="wrow2">
          <div class="wfield"><label for="wfKind">종류</label><select id="wfKind">${KIND_OPTS(f.kind)}</select></div>
          <div class="wfield"><label for="wfBottle">바틀 가격</label>
            <div class="wunit"><input id="wfBottle" inputmode="numeric" value="${esc(f.bottlePrice)}"><span>원</span></div></div>
        </div>
        <div class="wfield"><label for="wfDesc">설명</label>
          <input id="wfDesc" maxlength="80" value="${esc(f.desc)}" placeholder="예) 산뜻한 청사과 향"></div>
        <div class="wfield">
          <label>사진 <span class="sub">없어도 돼요 · 포스에는 안 올라가요</span></label>
          <div class="wpick">
            <span class="prev">${prev ? `<img src="${esc(prev)}" alt="">` : '없음'}</span>
            <input type="file" id="wimg" accept="image/*" style="flex:1;min-width:0">
            ${prev ? '<button class="btn ghost sm" data-wact="img-clear">지우기</button>' : ''}
          </div>
        </div>
        ${add ? `<div class="wrow2">
            <div class="wfield"><label for="wfStock">미개봉 재고</label>
              <div class="wunit"><input id="wfStock" inputmode="numeric" value="${esc(f.stock)}"><span>병</span></div></div>
            <div class="wfield"><label>&nbsp;</label>
              <label class="check"><input type="checkbox" id="wfExpose" ${f.expose ? 'checked' : ''}> 바로 판매중으로</label></div>
          </div>
          <div class="hint">포스에 상품을 새로 등록해요. 1분쯤 걸리고 그동안 포스 창이 앞으로 올라옵니다.</div>` : ''}
      </div>
      <div class="wsfoot">
        ${!add && w.posState === 'failed' ? `<button class="btn danger sm" data-wact="forget" data-id="${w.id}">목록에서 지우기</button>` : ''}
        <span class="right">
          <button class="btn ghost" data-wact="close">취소</button>
          <button class="btn brand" data-wact="save">${add ? '추가하기' : '저장'}</button>
        </span>
      </div>
    </div></div>`;
  }

  // 입력칸 값을 모달 상태에 모아둔다 (다시 그려도 입력 내용이 날아가지 않게)
  function collect() {
    const m = ui.modal;
    if (!m) return;
    const v = (id) => ($('#' + id) ? $('#' + id).value : undefined);
    const f = m.form;
    if (v('wfName') !== undefined) { if (m.mode === 'add') f.posName = v('wfName'); else f.name = v('wfName'); }
    if (v('wfNameEn') !== undefined) f.nameEn = v('wfNameEn');
    if (v('wfGlass') !== undefined) f.glassPrice = v('wfGlass');
    if (v('wfKind') !== undefined) f.kind = v('wfKind');
    if (v('wfBottle') !== undefined) f.bottlePrice = v('wfBottle');
    if (v('wfDesc') !== undefined) f.desc = v('wfDesc');
    if (v('wfStock') !== undefined) f.stock = v('wfStock');
    if ($('#wfExpose')) f.expose = $('#wfExpose').checked;
  }

  // ---------- 사진 ----------

  function pickImage(file) {
    return new Promise((resolve, reject) => {
      if (!/^image\//.test(file.type)) return reject(new Error('사진 파일을 골라주세요'));
      const fr = new FileReader();
      fr.onerror = () => reject(new Error('사진을 읽지 못했어요'));
      fr.onload = () => {
        const im = new Image();
        im.onerror = () => reject(new Error('사진을 읽지 못했어요'));
        im.onload = () => {
          // 긴 변 600px JPEG 로 줄여 보낸다 (원본은 수 MB 라 부담)
          const s = Math.min(1, 600 / Math.max(im.width, im.height));
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(im.width * s));
          c.height = Math.max(1, Math.round(im.height * s));
          c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/jpeg', 0.82));
        };
        im.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }

  // ---------- 저장 ----------

  async function save() {
    const m = ui.modal;
    collect();
    const f = m.form;
    const num = (v) => Number(String(v ?? '').replace(/[^\d]/g, '')) || 0;
    const body = { kind: f.kind, desc: f.desc, bottlePrice: num(f.bottlePrice) };
    if (m.img !== undefined) body.image = m.img;

    try {
      if (m.mode === 'add') {
        if (!f.posName.trim()) return toast('와인 이름을 입력해 주세요');
        if (!f.nameEn.trim()) return toast('영문 이름을 입력해 주세요 (포스 키오스크용 필수)');
        if (!num(f.glassPrice)) return toast('글라스 가격을 입력해 주세요');
        await api('/api/wine', { ...body, posName: f.posName, nameEn: f.nameEn, glassPrice: num(f.glassPrice), stock: num(f.stock), expose: f.expose });
        toast(`'${f.posName}' 를 포스에 등록하는 중이에요 (1분쯤)`);
      } else {
        const r = await api('/api/wine/update', { ...body, id: m.id, name: f.name });
        toast(r.note || '저장했어요');
      }
      closeModal();
    } catch (e) {
      toast('⚠️ ' + e.message);
    }
  }

  // ---------- 이벤트 ----------

  ROOT.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-wact]');
    if (!b || b.disabled) return;
    const act = b.dataset.wact;
    const id = b.dataset.id;
    const w = id ? (W.wines || []).find((x) => x.id === id) : null;

    if (act === 'backdrop' && e.target !== b) return;
    if (act === 'backdrop' || act === 'close') return closeModal();

    if (act === 'open') {
      if (!w) return;
      return openModal('edit', {
        id: w.id,
        form: { name: w.name || '', kind: w.kind, desc: w.desc, bottlePrice: String(w.bottlePrice || '') },
      });
    }

    if (act === 'open-toggle' || act === 'stock' || act === 'expose') {
      const call = act === 'open-toggle' ? ['/api/wine/open', { id, on: b.dataset.on !== '1' }]
        : act === 'stock' ? ['/api/wine/stock', { id, delta: Number(b.dataset.d) }]
        : ['/api/wine/expose', { id, on: b.dataset.on === '1' }];
      try {
        const r = await api(call[0], call[1]);
        toast(r.note || (call[1].on
          ? `'${label(w)}' 판매를 시작할게요 (포스 반영 30초쯤)`
          : `'${label(w)}' 를 비활성으로 옮기는 중이에요 (포스 반영 30초쯤)`));
      } catch (er) { toast('⚠️ ' + er.message); }
      return;
    }

    if (act === 'img-clear') { ui.modal.img = null; return render(); }
    if (act === 'save') return save();

    if (act === 'forget') {
      if (!confirm(`'${label(w)}' 를 목록에서 지울까요?\n\n포스 등록에 실패한 항목이라 포스에는 없습니다.`)) return;
      try { const r = await api('/api/wine/forget', { id }); toast(r.note); closeModal(); }
      catch (er) { toast('⚠️ ' + er.message); }
      return;
    }

    if (act === 'retry') {
      try { await api(`/api/wine/jobs/${id}/retry`); toast('다시 시도합니다'); } catch (er) { toast('⚠️ ' + er.message); }
      return;
    }
    if (act === 'dock-close') { ui.dockSeen = id; return render(); }
  });

  ROOT.addEventListener('change', async (e) => {
    if (e.target.id !== 'wimg') return;
    const file = e.target.files?.[0];
    if (!file || !ui.modal) return;
    try { ui.modal.img = await pickImage(file); render(); }
    catch (er) { toast('⚠️ ' + er.message); }
  });

  ROOT.addEventListener('input', (e) => {
    if (e.target.id === 'wsearch') { ui.q = e.target.value; return renderLists(); }
    if (e.target.id?.startsWith('wf')) collect();
  });

  $('#wsyncBtn').addEventListener('click', async () => {
    try {
      await api('/api/wine/sync');
      toast('포스에서 와인 목록을 읽는 중이에요 (20~40초) — 포스 창이 잠깐 앞으로 올라와요');
    } catch (e) { toast('⚠️ ' + e.message); }
  });

  $('#waddBtn').addEventListener('click', () => openModal('add', {
    form: { posName: '', nameEn: '', glassPrice: '', kind: '화이트', desc: '', bottlePrice: '', stock: '1', expose: true },
  }));

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ui.modal) closeModal(); });

  // ---------- 그리기 ----------

  function render() {
    if (!W) return;
    const focus = document.activeElement;
    const keep = focus?.id?.startsWith('wf') || focus?.id === 'wsearch'
      ? { id: focus.id, s: focus.selectionStart } : null;
    renderBar();
    renderLists();
    renderExtra();
    renderDock();
    renderModal();
    if (keep) {
      const el = document.getElementById(keep.id);
      if (el) { el.focus(); try { el.setSelectionRange(keep.s, keep.s); } catch {} }
    }
    const s = document.getElementById('wsearch');
    if (s && s.value !== ui.q) s.value = ui.q;
  }

  connect();
})();
