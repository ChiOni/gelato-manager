// 와인 탭 서버 — /api/wine/* 와 /wine.js · /wine.css 를 처리한다.
// 목록의 주인은 포스다. [포스에서 불러오기] 를 누르면 포스 와인이 그대로 판매중/비활성 두 칸이 된다.
// 젤라또와는 상태·SSE·작업 큐를 따로 쓴다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './wine-store.mjs';
import { createPos } from './wine-pos.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(here, '..', 'web');

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

async function readBody(req, limit = 3e6) { // 사진(600px JPEG)이 들어오므로 젤라또보다 넉넉하게
  let s = '';
  for await (const c of req) {
    s += c;
    if (s.length > limit) throw new Error('보내는 자료가 너무 커요.');
  }
  return s ? JSON.parse(s) : {};
}

export function wineRoute({ busy = () => false, log = () => {} } = {}) {
  const clients = new Set();
  let pushTimer = null;

  const pos = createPos({ busy, log, onChange: () => push() });

  function snapshot() {
    const db = store.load();
    return {
      wines: db.wines,
      posSeenAt: db.posSeenAt,
      posExcluded: db.posExcluded || [],
      kinds: store.KINDS,
      pending: pos.pendingWineIds(),
      ...pos.snapshot(),
    };
  }

  function push() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      const data = `event: wine\ndata: ${JSON.stringify(snapshot())}\n\n`;
      clients.forEach((res) => res.write(data));
    }, 100);
  }

  // ---------- 포스 작업 ----------

  // 노출 ON/OFF. 성공해야 목록을 옮긴다 (auto=true 인 자동 비활성은 이미 옮겨둔 상태로 들어온다)
  function queueExpose(w, on, { auto = false } = {}) {
    return pos.enqueue({
      kind: 'expose',
      label: on ? '판매 시작' : '비활성으로 옮기기',
      name: store.label(w),
      wineId: w.id,
      auto,
      progress: `포스에서 '${store.label(w)}' 를 찾는 중…`,
      arg: { posName: w.posName, posPrice: w.posPrice, on },
      okMessage: () => `포스 노출 ${on ? 'ON' : 'OFF'} 확인됨`,
      then: () => {
        const t = store.byId(w.id);
        if (!t) return;
        t.active = on;
        t.posExpose = on;
        t.posSyncAt = Date.now();
        t.posState = 'ok';
        t.posNote = '';
        t.updatedAt = Date.now();
        store.save();
      },
      onFail: (e) => {
        const t = store.byId(w.id);
        if (!t) return;
        // 자동 비활성(다 팔림)은 사실이므로 되돌리지 않고 어긋남만 표시한다.
        // 수동 전환은 미리 옮기지 않으므로 되돌릴 것이 없다.
        t.posState = 'failed';
        t.posNote = `포스 노출을 ${on ? '켜지' : '끄지'} 못했어요: ${String(e.message || e)}`;
        t.updatedAt = Date.now();
        store.save();
      },
    });
  }

  function queueAdd(w, nameEn, expose) {
    return pos.enqueue({
      kind: 'add',
      label: '포스에 등록',
      name: w.posName,
      wineId: w.id,
      progress: `포스에 '${w.posName}' 를 입력하는 중…`,
      arg: {
        posName: w.posName,
        kioskName: w.posName,
        kioskNameEn: nameEn || w.posName,
        desc: w.desc,
        price: w.posPrice,
        expose: !!expose,
      },
      okMessage: (out) => `포스 등록 완료${out.listed ? ' · 목록에서 확인됨' : ''} (노출 ${out.expose ? 'ON' : 'OFF'})`,
      then: (out) => {
        const t = store.byId(w.id);
        if (!t) return;
        t.posState = 'ok';
        t.posNote = out.listed ? '' : '포스 목록에서 아직 확인하지 못했어요. [포스에서 불러오기]로 확인해 주세요.';
        t.posExpose = !!out.expose;
        t.active = !!out.expose;
        t.posSyncAt = Date.now();
        t.updatedAt = Date.now();
        store.save();
      },
      onFail: (e) => {
        const t = store.byId(w.id);
        if (!t) return;
        t.posState = 'failed';
        t.posNote = `포스에 등록하지 못했어요: ${String(e.message || e)}`;
        t.active = false;
        t.updatedAt = Date.now();
        store.save();
      },
    });
  }

  function queueSync() {
    const db = store.load();
    return pos.enqueue({
      kind: 'sync',
      label: '포스에서 불러오기',
      name: '',
      progress: '포스 와인 목록을 읽는 중… (20~40초)',
      arg: { wines: db.wines.map((w) => ({ id: w.id, posName: w.posName, posPrice: w.posPrice })) },
      okMessage: (out) => {
        const added = out.unknown.length, gone = out.missing.length;
        return `와인 ${out.matched.length + added}개${added ? ` · 새로 ${added}개` : ''}${gone ? ` · 포스에서 사라진 ${gone}개` : ''}`;
      },
      then: (out) => applySync(out),
    });
  }

  // 포스에서 읽은 결과가 곧 목록이다 — 맞춰보고, 새로 생긴 건 바로 넣고, 없어진 건 뺀다.
  function applySync(out) {
    const db = store.load();
    const keep = [];
    const seen = new Set();

    for (const m of out.matched) {
      const w = store.byId(m.id);
      if (!w) continue;
      w.posOcrName = m.posOcrName;
      if (m.price) w.posPrice = m.price;   // 포스에서 가격을 바꿨으면 따라간다
      w.posExpose = !!m.expose;
      w.active = !!m.expose;               // 판매중/비활성은 포스 노출이 정한다
      w.posSyncAt = Date.now();
      w.posState = 'ok';
      w.posNote = '';
      keep.push(w);
      seen.add(w.id);
    }

    // 포스에 있는데 우리가 모르던 와인 → 등록 절차 없이 바로 목록에 넣는다
    for (const u of out.unknown) {
      const w = store.restoreOrphan(store.create({ posName: u.name, posPrice: u.price, expose: u.expose }));
      keep.push(w);
      seen.add(w.id);
    }

    // 포스에서 사라진 와인 → 목록에서 빼고 적어둔 값만 보관.
    // 단 지금 포스에 등록하는 중인 것은 아직 안 보이는 게 정상이라 그대로 둔다.
    for (const w of db.wines) {
      if (seen.has(w.id)) continue;
      if (w.posState === 'adding') { keep.push(w); continue; }
      store.toOrphan(w);
    }

    db.wines = keep.sort((a, b) => store.label(a).localeCompare(store.label(b), 'ko'));
    db.posSeenAt = Date.now();
    db.posExcluded = out.excluded;
    store.save();
  }

  // 미개봉 0 + 개봉 안 함 = 다 팔림 → 비활성으로 옮기고 포스 노출을 끈다
  function soldOutCheck(w) {
    if (w.stock !== 0 || w.opened || !w.active) return null;
    w.active = false;
    w.updatedAt = Date.now();
    store.save();
    queueExpose(w, false, { auto: true });
    return `'${store.label(w)}' 다 팔렸어요. 비활성으로 옮기고 포스 노출을 끄는 중이에요`;
  }

  // ---------- 라우팅 ----------

  return async function handle(req, res, url) {
    const p = url.pathname;
    if (!p.startsWith('/api/wine') && p !== '/wine.js' && p !== '/wine.css') return false;

    try {
      if (req.method === 'GET') {
        if (p === '/wine.js' || p === '/wine.css') {
          const type = p.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'text/css; charset=utf-8';
          return send(res, 200, fs.readFileSync(path.join(WEB, p.slice(1)), 'utf8'), type), true;
        }
        if (p === '/api/wine/state') return send(res, 200, snapshot()), true;
        if (p === '/api/wine/events') {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
          res.write(`event: wine\ndata: ${JSON.stringify(snapshot())}\n\n`);
          clients.add(res);
          const ping = setInterval(() => res.write(': ping\n\n'), 25000);
          req.on('close', () => { clearInterval(ping); clients.delete(res); });
          return true;
        }
        const img = p.match(/^\/api\/wine\/image\/(.+)$/);
        if (img) {
          const file = store.imagePath(decodeURIComponent(img[1]));
          if (!file) return send(res, 404, { error: '사진이 없습니다.' }), true;
          const ext = path.extname(file).slice(1).toLowerCase();
          res.writeHead(200, { 'content-type': `image/${ext === 'jpg' ? 'jpeg' : ext}`, 'cache-control': 'max-age=60' });
          res.end(fs.readFileSync(file));
          return true;
        }
        return send(res, 404, { error: 'not found' }), true;
      }

      if (req.method !== 'POST') return send(res, 404, { error: 'not found' }), true;
      // 다른 웹사이트가 몰래 호출하지 못하도록 (젤라또와 같은 규칙)
      if (req.headers['x-menu-app'] !== '1') return send(res, 403, { error: 'forbidden' }), true;

      const body = await readBody(req);
      const need = (id) => {
        const w = store.byId(id);
        if (!w) throw new Error('와인을 찾을 수 없습니다.');
        return w;
      };
      const lock = (w) => {
        if (pos.pendingWineIds().includes(w.id)) throw new Error('이 와인은 포스 작업이 진행 중이에요. 끝난 뒤에 다시 해주세요.');
      };

      // 포스에서 불러오기 — 이게 목록을 만드는 유일한 경로
      if (p === '/api/wine/sync') {
        if (pos.isBusy()) return send(res, 400, { error: '이미 포스 작업이 진행 중이에요.' }), true;
        return send(res, 200, { job: queueSync() }), true;
      }

      // 판매중 / 비활성 전환 (포스 노출 토글)
      if (p === '/api/wine/expose') {
        const w = need(body.id);
        lock(w);
        const on = !!body.on;
        if (on && w.stock === 0 && !w.opened) throw new Error('미개봉 재고가 없어요. 재고를 먼저 입력해 주세요.');
        if (w.active === on && w.posExpose === on) throw new Error(on ? '이미 판매중이에요.' : '이미 비활성이에요.');
        const job = queueExpose(w, on);
        push();
        return send(res, 200, { job }), true;
      }

      // 개봉 병 ON/OFF — 포스를 건드리지 않으므로 즉시 반영
      if (p === '/api/wine/open') {
        const w = need(body.id);
        const on = !!body.on;
        if (on) {
          if (w.opened) throw new Error('이미 개봉한 병이 있어요.');
          if (w.stock < 1) throw new Error('미개봉이 없어요. 재고를 먼저 입력해 주세요.');
          w.stock -= 1;
          w.opened = true;
        } else {
          if (!w.opened) throw new Error('개봉한 병이 없어요.');
          w.opened = false;
        }
        w.updatedAt = Date.now();
        store.save();
        const note = soldOutCheck(w) || (on
          ? `'${store.label(w)}' 개봉했어요. 미개봉 ${w.stock}병 남음`
          : `'${store.label(w)}' 다 마신 것으로 기록했어요`);
        push();
        return send(res, 200, { wine: w, note }), true;
      }

      // 미개봉 재고 수정 (입고 · 바틀 판매 · 파손) — 목록에서 바로 누르는 ＋/−
      if (p === '/api/wine/stock') {
        const w = need(body.id);
        const next = body.delta !== undefined
          ? w.stock + Number(body.delta)
          : Number(String(body.stock ?? '').replace(/[^\d]/g, ''));
        if (!Number.isFinite(next) || next < 0) throw new Error('재고는 0 이상으로 입력해 주세요.');
        w.stock = Math.min(999, Math.floor(next));
        w.updatedAt = Date.now();
        store.save();
        const note = soldOutCheck(w) || `'${store.label(w)}' 미개봉 ${w.stock}병`;
        push();
        return send(res, 200, { wine: w, note }), true;
      }

      // 새 와인 — 포스에 상품을 등록한다 (목록에는 등록이 끝나야 판매중으로 올라간다)
      if (p === '/api/wine') {
        const posName = String(body.posName || '').trim().slice(0, 60);
        const posPrice = Number(String(body.glassPrice ?? '').replace(/[^\d]/g, '')) || 0;
        if (!posName) throw new Error('와인 이름을 입력해 주세요.');
        if (!posPrice) throw new Error('글라스 가격을 입력해 주세요.');
        if (!String(body.nameEn || '').trim()) throw new Error('영문 이름을 입력해 주세요. (포스 키오스크용)');
        const dup = store.wines().find((o) => store.normName(o.posName) === store.normName(posName));
        if (dup) throw new Error(`'${store.label(dup)}' 와(과) 이름이 겹쳐요.`);

        const w = store.create({ posName, posPrice, expose: false });
        store.applyEdits(w, body);
        w.stock = Math.max(0, Number(String(body.stock ?? '').replace(/[^\d]/g, '')) || 0);
        w.posState = 'adding';
        w.posNote = '포스에 등록하는 중…';
        if (body.image) { try { w.image = store.saveImage(w.id, body.image); } catch (e) { w.posNote = String(e.message); } }
        store.wines().unshift(w);
        store.save();
        const job = queueAdd(w, body.nameEn, body.expose !== false);
        push();
        return send(res, 200, { wine: w, job }), true;
      }

      // 상세 수정 — 포스가 주는 값(이름·글라스 가격)은 못 바꾸고, 적어두는 값만 바꾼다
      if (p === '/api/wine/update') {
        const w = need(body.id);
        store.applyEdits(w, body);
        if (body.image) w.image = store.saveImage(w.id, body.image);
        if (body.image === null) store.removeImage(w);
        store.save();
        push();
        return send(res, 200, { wine: w, note: `'${store.label(w)}' 저장했어요` }), true;
      }

      // 포스 등록에 실패해 목록에만 남은 항목을 치우는 비상구 (평소에는 화면에 안 보인다)
      if (p === '/api/wine/forget') {
        const w = need(body.id);
        lock(w);
        if (w.posState !== 'failed') throw new Error('포스에 있는 와인은 포스에서 지워주세요. [포스에서 불러오기] 하면 목록에서도 사라져요.');
        store.removeImage(w);
        const db = store.load();
        db.wines = db.wines.filter((o) => o.id !== w.id);
        store.save();
        push();
        return send(res, 200, { note: `'${store.label(w)}' 를 목록에서 지웠어요.` }), true;
      }

      const retry = p.match(/^\/api\/wine\/jobs\/([\w]+)\/retry$/);
      if (retry) return send(res, 200, { job: pos.retry(retry[1]) }), true;

      return send(res, 404, { error: 'not found' }), true;
    } catch (e) {
      return send(res, 400, { error: String(e.message || e) }), true;
    }
  };
}
