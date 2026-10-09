// 와인 탭 서버 테스트 — 실제 포스 없이 돌린다 (가짜 포스 = test/wine-pos-stub.py).
//   node automation/test/wine.test.mjs
// 서버를 다른 포트(8799)로 띄우고 임시 장부 폴더를 쓰므로 실제 운영에 영향이 없다.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-test-'));

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
};
const section = (t) => console.log(`\n${t}`);

const get = async (p) => {
  const r = await fetch(BASE + p);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json };
};
const post = async (p, body, headers = { 'x-menu-app': '1' }) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body || {}) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const state = async () => (await get('/api/wine/state')).json;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 포스 작업(큐)이 모두 끝날 때까지 기다린다
async function settle(timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const s = await state();
    if (!s.running && !s.queued) return s;
    await sleep(120);
  }
  throw new Error('작업이 끝나지 않음');
}
const wineByName = (s, name) => s.wines.find((w) => w.name === name);

const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  env: {
    ...process.env,
    MENU_PORT: String(PORT),
    WINE_DATA_DIR: DATA,
    WINE_BRIDGE: path.join(here, 'wine-pos-stub.py'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog = [];
server.stdout.on('data', (d) => serverLog.push(String(d)));
server.stderr.on('data', (d) => serverLog.push(String(d)));

async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try { if ((await get('/api/health')).status === 200) return; } catch {}
    await sleep(100);
  }
  throw new Error(`서버가 켜지지 않음:\n${serverLog.join('')}`);
}

try {
  await waitUp();

  section('젤라또 회귀 — 기존 기능이 그대로인지');
  {
    const page = await get('/');
    ok(page.status === 200, '/ 페이지 응답');
    ok(page.text.includes('준비물') && page.text.includes('메뉴 관리'), '젤라또 섹션(준비물·메뉴 관리) 남아 있음');
    ok(page.text.includes('data-tab="gelato"') && page.text.includes('data-tab="wine"'), '상단 탭 2개 추가됨');
    ok(!page.text.includes('<h1>스쿱앤십 메뉴 관리</h1>'), '기존 헤더 영역 제거됨');
    ok(page.text.includes('id="tab-gelato"') && page.text.includes('id="tab-wine"'), '탭 컨테이너 존재');
    const st = await get('/api/state');
    ok(st.status === 200 && !!st.json.status.figma, '/api/state 젤라또 상태 정상');
    ok(st.json.jobs !== undefined && st.json.menu !== undefined, '젤라또 스냅샷 형태 유지');
    const bad = await post('/api/jobs', { cmd: 'nope', name: 'x' });
    ok(bad.status === 400, '젤라또 잘못된 작업은 400');
    const noHdr = await post('/api/jobs', { cmd: 'tidy' }, {});
    ok(noHdr.status === 403, '젤라또 POST x-menu-app 검사 유지');
  }

  section('정적 파일 · 접근 제어');
  {
    ok((await get('/wine.js')).status === 200, '/wine.js 제공');
    ok((await get('/wine.css')).status === 200, '/wine.css 제공');
    const noHdr = await post('/api/wine/sync', {}, {});
    ok(noHdr.status === 403, '와인 POST 도 x-menu-app 필수');
    ok((await get('/api/wine/image/../../server.mjs')).status === 404, '사진 경로 탈출 차단');
  }

  section('포스에서 불러오기');
  {
    let s = await state();
    ok(s.wines.length === 0 && s.posSeenAt === null, '처음엔 장부가 비어 있음');
    ok((await post('/api/wine/sync')).status === 200, '불러오기 접수');
    s = await settle();
    ok(s.posSeenAt > 0, '포스 확인 시각 기록');
    ok(s.posUnknown.length === 2, '포스에만 있는 상품 2개', JSON.stringify(s.posUnknown));
    ok(s.posExcluded.length === 2, '제외 상품 2개 (직접입력·추천)');
    ok(s.jobs[0].state === 'done', '불러오기 작업 완료', s.jobs[0].message);
  }

  section('포스에만 있는 상품 → 장부에 넣기');
  {
    const r = await post('/api/wine/adopt', {
      name: '가비', posName: '가비-화이트', kind: '화이트', desc: '산뜻한 청사과 향',
      glassPrice: 12000, bottlePrice: 58000, stock: 2, expose: true,
    });
    ok(r.status === 200, '장부에 넣기 성공', r.json?.error);
    const s = await state();
    const w = wineByName(s, '가비');
    ok(!!w && w.active === true && w.posExpose === true, '판매중으로 들어감');
    ok(w.posPrice === 12000 && w.glassPrice === 12000, '포스 가격 = 글라스 가격');
    ok(s.posUnknown.length === 1, '넣은 상품은 "포스에만 있는 상품"에서 빠짐');
    const dup = await post('/api/wine/adopt', { name: '가비', posName: '가비-화이트', glassPrice: 12000, bottlePrice: 58000 });
    ok(dup.status === 400, '같은 와인 중복 등록 차단', dup.json?.error);
  }

  section('기능 2 — 개봉 병 ON (미개봉 -1)');
  {
    const id = wineByName(await state(), '가비').id;
    const r = await post('/api/wine/open', { id, on: true });
    ok(r.status === 200, '개봉 ON');
    let w = wineByName(await state(), '가비');
    ok(w.stock === 1 && w.opened === true, '미개봉 2 → 1, 개봉 ON', `stock=${w.stock}`);
    ok((await post('/api/wine/open', { id, on: true })).status === 400, '이미 개봉 중이면 거부');
    // 재고를 0 으로 만든 뒤 개봉 ON 시도
    await post('/api/wine/open', { id, on: false });               // 다 마심 (재고 1 남아 비활성 안 됨)
    await post('/api/wine/stock', { id, stock: 0 });
    await settle();
    const no = await post('/api/wine/open', { id, on: true });
    ok(no.status === 400 && /미개봉이 없어요/.test(no.json.error), '미개봉 0 이면 개봉 ON 불가', no.json?.error);
  }

  section('기능 3 — 미개봉 0 + 개봉 OFF → 자동 비활성 + 포스 노출 OFF');
  {
    // 재고 1 · 개봉 ON 상태로 만든다
    const id = wineByName(await state(), '가비').id;
    await post('/api/wine/stock', { id, stock: 1 });
    await settle();
    await post('/api/wine/expose', { id, on: true });
    await settle();
    await post('/api/wine/open', { id, on: true });
    let w = wineByName(await state(), '가비');
    ok(w.stock === 0 && w.opened === true && w.active === true, '마지막 병 개봉 — 아직 판매중', `stock=${w.stock} active=${w.active}`);
    const r = await post('/api/wine/open', { id, on: false });     // 다 마심
    ok(/다 팔렸어요/.test(r.json.note || ''), '다 팔림 안내 문구', r.json?.note);
    w = wineByName(await state(), '가비');
    ok(w.active === false, '자동으로 비활성으로 이동');
    const s = await settle();
    w = wineByName(s, '가비');
    ok(w.posExpose === false && w.posState === 'ok', '포스 노출 OFF 반영', `posExpose=${w.posExpose}`);
    ok(s.jobs[0].kind === 'expose' && s.jobs[0].auto === true, '자동 비활성 작업이 큐에 기록됨');
  }

  section('기능 1 — 활성/비활성 전환');
  {
    const id = wineByName(await state(), '가비').id;
    const no = await post('/api/wine/expose', { id, on: true });
    ok(no.status === 400 && /미개봉 재고가 없어요/.test(no.json.error), '재고 0 + 개봉 없음이면 판매 시작 차단', no.json?.error);
    await post('/api/wine/stock', { id, stock: 3 });
    const r = await post('/api/wine/expose', { id, on: true });
    ok(r.status === 200, '판매 시작 접수');
    const s = await settle();
    const w = wineByName(s, '가비');
    ok(w.active === true && w.posExpose === true, '포스 성공 후 판매중으로 이동');
    ok((await post('/api/wine/expose', { id, on: true })).status === 400, '이미 판매중이면 거부');
  }

  section('기능 4 — 새 와인 추가 (포스 등록)');
  {
    const r = await post('/api/wine', {
      name: '줄리엣', nameEn: 'Juliet', kind: '화이트', desc: '복숭아 향이 도는',
      glassPrice: 12000, bottlePrice: 60000, stock: 4, expose: true,
    });
    ok(r.status === 200, '추가 접수', r.json?.error);
    ok(r.json.wine.posState === 'adding' && r.json.wine.active === false, '등록 중에는 판매중으로 올리지 않음');
    const s = await settle();
    const w = wineByName(s, '줄리엣');
    ok(w.posState === 'ok' && w.active === true && w.posExpose === true, '포스 등록 후 판매중', `posState=${w.posState}`);
    ok(w.posName === '줄리엣' && w.posPrice === 12000, '포스 상품명·가격 기록');

    // 노출 OFF 로 추가
    const r2 = await post('/api/wine', { name: '칼뢰벤', nameEn: 'Kalkoven', kind: '화이트', glassPrice: 12000, bottlePrice: 55000, stock: 1, expose: false });
    ok(r2.status === 200, '노출 OFF 로 추가 접수');
    const s2 = await settle();
    const w2 = wineByName(s2, '칼뢰벤');
    ok(w2.active === false && w2.posExpose === false, '선택한 대로 비활성으로 들어감');

    const dup = await post('/api/wine', { name: '줄리엣', nameEn: 'J', glassPrice: 12000, bottlePrice: 60000 });
    ok(dup.status === 400, '이름 중복 차단');
    const bad = await post('/api/wine', { name: '테스트와인', nameEn: 'T', glassPrice: 12000 });
    ok(bad.status === 400 && /바틀 가격/.test(bad.json.error), '바틀 가격 없으면 거부', bad.json?.error);
    const bad2 = await post('/api/wine', { name: '', nameEn: 'T', glassPrice: 1, bottlePrice: 1 });
    ok(bad2.status === 400, '이름 없으면 거부');
  }

  section('포스 실패 처리');
  {
    const id = wineByName(await state(), '줄리엣').id;
    // 가짜 포스를 실패 모드로 바꿔 끼운다
    const stub = path.join(here, 'wine-pos-stub.py');
    const failStub = path.join(DATA, 'fail-stub.py');
    fs.writeFileSync(failStub, 'import json,sys\nprint(json.dumps({"ok":False,"error":"포스가 상품 > 와인 목록 화면이 아닙니다. 클릭하지 않고 중단합니다."},ensure_ascii=False))\nsys.exit(1)\n');
    // 실행 중인 서버의 환경변수는 바꿀 수 없으므로, 같은 경로의 스텁을 임시로 교체한다
    const orig = fs.readFileSync(stub, 'utf8');
    fs.writeFileSync(stub, fs.readFileSync(failStub, 'utf8'));
    try {
      await post('/api/wine/expose', { id, on: false });
      const s = await settle();
      const w = wineByName(s, '줄리엣');
      ok(s.jobs[0].state === 'failed', '포스 실패가 작업에 기록됨', s.jobs[0].message);
      ok(w.active === true, '수동 전환 실패 시 장부는 그대로 (판매중 유지)', `active=${w.active}`);
      ok(w.posState === 'failed' && /포스 노출을 끄지 못했어요/.test(w.posNote || ''), '실패 이유를 와인에 남김', w.posNote);
      const retry = await post(`/api/wine/jobs/${s.jobs[0].id}/retry`);
      ok(retry.status === 200, '다시 시도 접수');
      await settle();
    } finally {
      fs.writeFileSync(stub, orig);
    }
  }

  section('상세 저장 · 사진 · 삭제');
  {
    const id = wineByName(await state(), '칼뢰벤').id;
    const r = await post('/api/wine/update', { id, name: '칼뢰벤', kind: '스파클링', desc: '기포가 고운', glassPrice: 13000, bottlePrice: 56000 });
    ok(r.status === 200 && /포스 가격은 직접 바꿔/.test(r.json.note), '가격 바꾸면 포스 수동 변경 안내', r.json?.note);
    let w = wineByName(await state(), '칼뢰벤');
    ok(w.kind === '스파클링' && w.glassPrice === 13000 && w.posPrice === 13000, '저장 반영 + 포스 가격 동기화');

    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
    ok((await post('/api/wine/update', { id, name: '칼뢰벤', glassPrice: 13000, bottlePrice: 56000, image: png })).status === 200, '사진 저장');
    w = wineByName(await state(), '칼뢰벤');
    ok(!!w.image, '사진 파일명 기록');
    ok((await get(`/api/wine/image/${w.image}`)).status === 200, '사진 내려받기');
    ok((await post('/api/wine/update', { id, name: '칼뢰벤', glassPrice: 13000, bottlePrice: 56000, image: 'data:text/html,<script>' })).status === 400, '사진 아닌 파일 거부');

    // 재고를 0 으로 저장하면 자동 비활성 규칙이 함께 동작
    const id2 = wineByName(await state(), '줄리엣').id;
    await post('/api/wine/update', { id: id2, name: '줄리엣', glassPrice: 12000, bottlePrice: 60000, stock: 0 });
    const s = await settle();
    ok(wineByName(s, '줄리엣').active === false, '상세에서 재고 0 으로 고쳐도 자동 비활성');

    const del = await post('/api/wine/delete', { id });
    ok(del.status === 200 && /포스 상품은 그대로/.test(del.json.note), '장부에서만 삭제', del.json?.note);
    ok(!wineByName(await state(), '칼뢰벤'), '목록에서 사라짐');
  }

  section('장부 유지 (서버 재시작)');
  {
    const before = (await state()).wines.length;
    const file = path.join(DATA, 'wines.json');
    ok(fs.existsSync(file), 'wines.json 파일 생성됨');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    ok(saved.wines.length === before, `파일에 와인 ${before}개 저장됨`, `파일=${saved.wines.length}`);
    ok(saved.wines.every((w) => w.id && w.posName && typeof w.stock === 'number'), '필수 필드가 모두 저장됨');
  }
} catch (e) {
  fail++;
  console.log(`\n❌ 테스트 중단: ${e.message}`);
  if (serverLog.length) console.log(serverLog.join('').split('\n').slice(-12).join('\n'));
} finally {
  server.kill();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
  console.log(`\n${'─'.repeat(44)}\n통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
}
