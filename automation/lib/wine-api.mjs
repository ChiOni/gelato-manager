// 와인 탭 서버 — /api/wine/* 와 /wine.js · /wine.css 를 처리한다.
// 젤라또와 완전히 분리: 상태·SSE·작업 큐를 따로 쓰고, server.mjs 는 요청을 넘기기만 한다.
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
      posUnknown: db.posUnknown || [],
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

  // 노출 ON/OFF. 성공해야 장부를 바꾼다 (auto=true 인 자동 비활성은 장부를 먼저 바꿔둔 상태로 들어온다)
  function queueExpose(w, on, { auto = false } = {}) {
    return pos.enqueue({
      kind: 'expose',
      label: on ? '판매 시작' : '비활성으로 옮기기',
      name: w.name,
      wineId: w.id,
      auto,
      progress: `포스에서 '${w.name}' 를 찾는 중…`,
      arg: { posName: w.posName, posPrice: w.posPrice, on },
      okMessage: () => `포스 노출 ${on ? 'ON' : 'OFF'} 확인됨`,
      then: (out) => {
        const t = store.byId(w.id);
        if (!t) return;
        t.active = on;
        t.posExpose = on;
        if (out.name) t.posOcrName = out.name;
        t.posSyncAt = Date.now();
        t.posState = 'ok';
        t.posNote = '';
        t.updatedAt = Date.now();
        store.save();
      },
      onFail: (e) => {
        const t = store.byId(w.id);
        if (!t) return;
        // 자동 비활성(다 팔림)은 장부가 사실이므로 되돌리지 않고 어긋남만 표시한다.
        // 수동 전환은 장부를 미리 바꾸지 않으므로 되돌릴 것이 없다.
        t.posState = 'failed';
        t.posNote = `포스 노출을 ${on ? '켜지' : '끄지'} 못했어요: ${String(e.message || e)}`;
        t.updatedAt = Date.now();
        store.save();
      },
    });
  }

  function queueAdd(w, expose) {
    return pos.enqueue({
      kind: 'add',
      label: '포스에 등록',
      name: w.name,
      wineId: w.id,
      progress: `포스에 '${w.name}' 를 입력하는 중…`,
      arg: {
        posName: w.posName,
        kioskName: w.name,
        kioskNameEn: w.nameEn || w.name,
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
      okMessage: (out) => `포스 ${out.count}개 읽음 · 장부 ${out.matched.length}개 대조${out.missing.length ? ` · 못 찾음 ${out.missing.length}개` : ''}${out.unknown.length ? ` · 장부에 없음 ${out.unknown.length}개` : ''}`,
      then: (out) => applySync(out),
    });
  }

  // 포스에서 읽은 결과를 장부에 반영 — 노출 상태는 포스가 사실이므로 포스 값으로 맞춘다
  function applySync(out) {
    const db = store.load();
    for (const m of out.matched) {
      const w = store.byId(m.id);
      if (!w) continue;
      w.posExpose = !!m.expose;
      w.active = !!m.expose;
      w.posOcrName = m.posOcrName;
      w.posSyncAt = Date.now();
      w.posState = 'ok';
      w.posNote = m.price !== w.posPrice
        ? `포스 가격(${(m.price || 0).toLocaleString('ko-KR')}원)이 글라스 가격과 달라요. 포스에서 기본가격을 맞춰 주세요.`
        : '';
    }
    for (const ms of out.missing) {
      const w = store.byId(ms.id);
      if (!w) continue;
      w.posState = 'missing';
      w.posSyncAt = Date.now();
      w.posNote = '포스 와인 목록에서 찾지 못했어요. 포스 상품명·가격이 장부와 같은지 확인해 주세요.';
    }
    db.posUnknown = out.unknown;
    db.posExcluded = out.excluded;
    db.posSeenAt = Date.now();
    store.save();
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

      // 포스에서 불러오기
      if (p === '/api/wine/sync') {
        if (pos.isBusy()) return send(res, 400, { error: '이미 포스 작업이 진행 중이에요.' }), true;
        return send(res, 200, { job: queueSync() }), true;
      }

      // 기능 1 — 활성/비활성 전환 (포스 성공 후 장부 반영)
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

      // 기능 2·3 — 개봉 병 ON/OFF (포스 호출 없음 → 즉시 반영)
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
        let note = on
          ? `'${w.name}' 개봉했어요. 미개봉 ${w.stock}병 남음`
          : `'${w.name}' 다 마신 것으로 기록했어요`;
        // 기능 3 — 미개봉 0 + 개봉 OFF = 다 팔림 → 자동 비활성 + 포스 노출 OFF
        if (!w.opened && w.stock === 0 && w.active) {
          w.active = false;
          w.updatedAt = Date.now();
          store.save();
          queueExpose(w, false, { auto: true });
          note = `'${w.name}' 다 팔렸어요. 비활성으로 옮기고 포스 노출을 끄는 중이에요`;
        }
        push();
        return send(res, 200, { wine: w, note }), true;
      }

      // 재고 수정 (입고 · 바틀 판매 · 파손) — 포스와 무관한 장부 수정
      if (p === '/api/wine/stock') {
        const w = need(body.id);
        const next = body.delta !== undefined
          ? w.stock + Number(body.delta)
          : Number(String(body.stock ?? '').replace(/[^\d]/g, ''));
        if (!Number.isFinite(next) || next < 0) throw new Error('재고는 0 이상으로 입력해 주세요.');
        w.stock = Math.min(999, Math.floor(next));
        w.updatedAt = Date.now();
        store.save();
        let note = `'${w.name}' 미개봉 ${w.stock}병`;
        if (w.stock === 0 && !w.opened && w.active) {
          w.active = false;
          store.save();
          queueExpose(w, false, { auto: true });
          note = `'${w.name}' 재고가 없어요. 비활성으로 옮기고 포스 노출을 끄는 중이에요`;
        }
        push();
        return send(res, 200, { wine: w, note }), true;
      }

      // 기능 4 — 새 와인 추가 (장부 먼저 저장 → 포스 등록 작업)
      if (p === '/api/wine') {
        const w = store.validate(store.normalize(body));
        const dup = store.findDup(w);
        if (dup) throw new Error(`'${dup.name}' 와(과) 겹쳐요. 이미 등록된 와인인지 확인해 주세요.`);
        w.id = store.newId();
        w.createdAt = Date.now();
        w.active = false;              // 포스 등록이 끝나면 선택한 노출값으로 맞춘다
        w.posExpose = null;
        w.posState = 'adding';
        w.posNote = '포스에 등록하는 중…';
        w.image = null;
        if (body.image) { try { w.image = store.saveImage(w.id, body.image); } catch (e) { w.posNote = String(e.message); } }
        store.wines().unshift(w);
        store.save();
        const job = queueAdd(w, body.expose !== false);
        push();
        return send(res, 200, { wine: w, job }), true;
      }

      // 포스에만 있는 상품을 장부에 등록 (포스에 이미 있으니 등록 작업은 하지 않는다)
      if (p === '/api/wine/adopt') {
        const w = store.validate(store.normalize(body));
        const dup = store.findDup(w);
        if (dup) throw new Error(`'${dup.name}' 와(과) 겹쳐요.`);
        w.id = store.newId();
        w.createdAt = Date.now();
        w.active = !!body.expose;
        w.posExpose = !!body.expose;
        w.posState = 'ok';
        w.posNote = '';
        w.posSyncAt = Date.now();
        w.image = null;
        if (body.image) { try { w.image = store.saveImage(w.id, body.image); } catch {} }
        store.wines().unshift(w);
        const db = store.load();
        db.posUnknown = (db.posUnknown || []).filter((u) => store.normName(u.name) !== store.normName(body.posName || body.name) || u.price !== w.posPrice);
        store.save();
        push();
        return send(res, 200, { wine: w }), true;
      }

      // 상세 저장
      if (p === '/api/wine/update') {
        const w = need(body.id);
        lock(w);
        const next = store.validate(store.normalize(body, w));
        const dup = store.findDup(next, w.id);
        if (dup) throw new Error(`'${dup.name}' 와(과) 겹쳐요.`);
        const priceChanged = next.posPrice !== w.posPrice;
        Object.assign(w, next);
        if (priceChanged) {
          w.posNote = `포스에서 '${w.posName}' 의 기본가격도 ${w.posPrice.toLocaleString('ko-KR')}원으로 바꿔 주세요. (앱은 포스 가격을 바꾸지 못해요)`;
        }
        if (body.image) { try { w.image = store.saveImage(w.id, body.image); } catch (e) { throw new Error(String(e.message)); } }
        if (body.image === null) store.removeImage(w);
        store.save();
        let note = `'${w.name}' 저장했어요${priceChanged ? ' · 포스 가격은 직접 바꿔 주세요' : ''}`;
        // 재고를 0 으로 고쳤는데 개봉한 병도 없으면 다 팔린 것 → 기능 3 과 같은 규칙
        if (w.stock === 0 && !w.opened && w.active) {
          w.active = false;
          store.save();
          queueExpose(w, false, { auto: true });
          note = `'${w.name}' 저장했어요. 재고가 없어 비활성으로 옮기고 포스 노출을 끄는 중이에요`;
        }
        push();
        return send(res, 200, { wine: w, note }), true;
      }

      // 장부에서만 삭제 (포스 상품은 그대로 — 포스 삭제는 자동화되어 있지 않다)
      if (p === '/api/wine/delete') {
        const w = need(body.id);
        lock(w);
        store.removeImage(w);
        const db = store.load();
        db.wines = db.wines.filter((o) => o.id !== w.id);
        store.save();
        push();
        return send(res, 200, { note: `'${w.name}' 를 장부에서 지웠어요. 포스 상품은 그대로 있어요.` }), true;
      }

      const retry = p.match(/^\/api\/wine\/jobs\/([\w]+)\/retry$/);
      if (retry) return send(res, 200, { job: pos.retry(retry[1]) }), true;

      return send(res, 404, { error: 'not found' }), true;
    } catch (e) {
      return send(res, 400, { error: String(e.message || e) }), true;
    }
  };
}
