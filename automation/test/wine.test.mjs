// 와인 탭 서버 테스트 — 실제 포스 없이 돌린다 (가짜 포스 = test/wine-pos-stub.py).
//   node automation/test/wine.test.mjs
// 서버를 다른 포트(8799)로 띄우고 임시 폴더를 쓰므로 실제 운영에 영향이 없다.
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
const POS_FILE = path.join(DATA, 'fake-pos.json');

// 가짜 포스에 등록돼 있는 상품 (실제 매장과 비슷하게 — 제외 대상도 섞는다)
const seedPos = () => fs.writeFileSync(POS_FILE, JSON.stringify([
  { name: '가비-화이트', price: 12000, expose: true },
  { name: '샤또 라로즈-레드', price: 9000, expose: true },
  { name: '빰빠네오-내추럴 화이트(오렌지)', price: 11000, expose: false },
  { name: '글라스 와인', price: null, expose: false },
  { name: '다양하게 바틀 추천해주세요', price: 0, expose: true },
]));
const posRows = () => JSON.parse(fs.readFileSync(POS_FILE, 'utf8'));
const posRow = (name) => posRows().find((r) => r.name === name);

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

async function settle(timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const s = await state();
    if (!s.running && !s.queued) return s;
    await sleep(120);
  }
  throw new Error('작업이 끝나지 않음');
}
const sync = async () => { await post('/api/wine/sync'); return settle(); };
const find = (s, name) => s.wines.find((w) => (w.name || w.posName) === name);

seedPos();
const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  env: {
    ...process.env,
    MENU_PORT: String(PORT),
    WINE_DATA_DIR: DATA,
    WINE_BRIDGE: path.join(here, 'wine-pos-stub.py'),
    WINE_STUB_STATE: POS_FILE,
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
    ok(page.text.includes('data-tab="gelato"') && page.text.includes('data-tab="wine"'), '상단 탭 2개');
    ok(page.text.includes('id="tab-gelato"') && page.text.includes('id="tab-wine"'), '탭 컨테이너 존재');
    const st = await get('/api/state');
    ok(st.status === 200 && !!st.json.status.figma, '/api/state 젤라또 상태 정상');
    ok((await post('/api/jobs', { cmd: 'nope', name: 'x' })).status === 400, '젤라또 잘못된 작업은 400');
    ok((await post('/api/jobs', { cmd: 'tidy' }, {})).status === 403, '젤라또 POST x-menu-app 검사 유지');
  }

  section('정적 파일 · 접근 제어');
  {
    ok((await get('/wine.js')).status === 200, '/wine.js 제공');
    ok((await get('/wine.css')).status === 200, '/wine.css 제공');
    ok((await post('/api/wine/sync', {}, {})).status === 403, '와인 POST 도 x-menu-app 필수');
    ok((await get('/api/wine/image/../../server.mjs')).status === 404, '사진 경로 탈출 차단');
  }

  section('포스가 곧 목록 — 등록 절차 없음');
  {
    let s = await state();
    ok(s.wines.length === 0 && s.posSeenAt === null, '처음엔 비어 있음');
    ok(s.posUnknown === undefined, '"포스에만 있는 상품" 개념이 없어짐');

    s = await sync();
    ok(s.wines.length === 3, '포스 와인 3종이 바로 목록에 들어옴', `${s.wines.length}개`);
    ok(s.wines.filter((w) => w.active).length === 2, '노출 ON 2개가 판매중');
    ok(s.wines.filter((w) => !w.active).length === 1, '노출 OFF 1개가 비활성');
    ok(s.posExcluded.length === 2, '직접입력·0원 상품은 제외', JSON.stringify(s.posExcluded.map((e) => e.name)));
    const g = find(s, '가비-화이트');
    ok(!!g && g.posPrice === 12000, '포스 이름·가격을 그대로 씀');
    ok(g.stock === 0 && g.opened === false, '재고·개봉은 0/꺼짐으로 시작');

    s = await sync();
    ok(s.wines.length === 3, '두 번 불러와도 중복이 안 생김', `${s.wines.length}개`);
  }

  section('개봉 · 재고를 목록에서 바로');
  {
    const id = find(await state(), '가비-화이트').id;
    ok((await post('/api/wine/stock', { id, delta: 1 })).status === 200, '재고 ＋');
    await post('/api/wine/stock', { id, delta: 1 });
    ok(find(await state(), '가비-화이트').stock === 2, '미개봉 2병');

    ok((await post('/api/wine/open', { id, on: true })).status === 200, '개봉 ON');
    let w = find(await state(), '가비-화이트');
    ok(w.stock === 1 && w.opened, '개봉하면 미개봉 −1', `stock=${w.stock}`);
    ok((await post('/api/wine/open', { id, on: true })).status === 400, '이미 개봉 중이면 거부');

    await post('/api/wine/open', { id, on: false });
    await post('/api/wine/stock', { id, stock: 0 });
    await settle();
    const no = await post('/api/wine/open', { id, on: true });
    ok(no.status === 400 && /미개봉이 없어요/.test(no.json.error), '미개봉 0이면 개봉 불가', no.json?.error);
  }

  section('미개봉 0 + 개봉 OFF → 자동 비활성 + 포스 노출 OFF');
  {
    const id = find(await state(), '가비-화이트').id;
    await post('/api/wine/stock', { id, stock: 1 });
    await settle();
    await post('/api/wine/expose', { id, on: true });
    await settle();
    await post('/api/wine/open', { id, on: true });
    let w = find(await state(), '가비-화이트');
    ok(w.stock === 0 && w.opened && w.active, '마지막 병 개봉 — 아직 판매중');

    const r = await post('/api/wine/open', { id, on: false });
    ok(/다 팔렸어요/.test(r.json.note || ''), '다 팔림 안내', r.json?.note);
    ok(!find(await state(), '가비-화이트').active, '바로 비활성으로 이동');
    const s = await settle();
    ok(!find(s, '가비-화이트').posExpose, '포스 노출 OFF 반영');
    ok(posRow('가비-화이트').expose === false, '진짜로 포스 쪽 토글이 꺼짐');
    ok(s.jobs[0].kind === 'expose' && s.jobs[0].auto === true, '자동 비활성 작업 기록됨');
  }

  section('판매중 / 비활성 전환');
  {
    const id = find(await state(), '가비-화이트').id;
    const no = await post('/api/wine/expose', { id, on: true });
    ok(no.status === 400 && /미개봉 재고가 없어요/.test(no.json.error), '재고 0이면 판매 시작 차단');
    await post('/api/wine/stock', { id, stock: 3 });
    await post('/api/wine/expose', { id, on: true });
    const s = await settle();
    ok(find(s, '가비-화이트').active && posRow('가비-화이트').expose === true, '포스 성공 후 판매중으로');
    ok((await post('/api/wine/expose', { id, on: true })).status === 400, '이미 판매중이면 거부');
  }

  section('새 와인 — 포스에 등록');
  {
    const r = await post('/api/wine', {
      posName: '줄리엣-화이트', nameEn: 'Juliet', glassPrice: 12000,
      kind: '화이트', desc: '복숭아 향이 도는', bottlePrice: 60000, stock: 4, expose: true,
    });
    ok(r.status === 200, '추가 접수', r.json?.error);
    ok(r.json.wine.posState === 'adding' && !r.json.wine.active, '등록 중에는 판매중으로 안 올림');
    let s = await settle();
    let w = find(s, '줄리엣-화이트');
    ok(w.posState === 'ok' && w.active, '포스 등록 후 판매중');
    ok(!!posRow('줄리엣-화이트'), '진짜로 포스에 상품이 생김');
    ok(w.stock === 4 && w.bottlePrice === 60000, '입력한 재고·바틀 가격 유지');

    ok((await post('/api/wine', { posName: '줄리엣-화이트', nameEn: 'J', glassPrice: 12000 })).status === 400, '이름 중복 차단');
    const bad = await post('/api/wine', { posName: '테스트', glassPrice: 12000 });
    ok(bad.status === 400 && /영문 이름/.test(bad.json.error), '영문 이름 없으면 거부', bad.json?.error);
    ok((await post('/api/wine', { posName: '테스트', nameEn: 'T' })).status === 400, '글라스 가격 없으면 거부');

    s = await sync();
    ok(s.wines.length === 4, '불러와도 방금 추가한 와인이 그대로', `${s.wines.length}개`);
  }

  section('포스에서 사라진 와인');
  {
    const before = find(await state(), '줄리엣-화이트');
    ok(before.stock === 4, '사라지기 전 재고 4');
    fs.writeFileSync(POS_FILE, JSON.stringify(posRows().filter((r) => r.name !== '줄리엣-화이트')));
    let s = await sync();
    ok(!find(s, '줄리엣-화이트'), '포스에서 빠지면 목록에서도 사라짐');
    ok(s.wines.length === 3, '남은 3종');

    // 다시 포스에 올리면 적어뒀던 재고·바틀 가격이 되살아난다
    const rows = posRows();
    rows.push({ name: '줄리엣-화이트', price: 12000, expose: true });
    fs.writeFileSync(POS_FILE, JSON.stringify(rows));
    s = await sync();
    const back = find(s, '줄리엣-화이트');
    ok(!!back, '다시 올리면 목록에 돌아옴');
    ok(back.stock === 4 && back.bottlePrice === 60000, '적어둔 재고·바틀 가격이 되살아남', `stock=${back?.stock}`);
  }

  section('상세 수정 — 포스 값은 못 바꾸고 메모만');
  {
    const w = find(await state(), '샤또 라로즈-레드');
    const r = await post('/api/wine/update', {
      id: w.id, name: '샤또 라로즈', kind: '레드', desc: '부드러운 탄닌', bottlePrice: 45000,
      posName: '내맘대로', glassPrice: 99999,   // 포스 값은 무시돼야 한다
    });
    ok(r.status === 200, '저장 성공');
    const s = await state();
    const u = s.wines.find((x) => x.id === w.id);
    ok(u.name === '샤또 라로즈' && u.bottlePrice === 45000, '보이는 이름·바틀 가격 저장');
    ok(u.posName === '샤또 라로즈-레드' && u.posPrice === 9000, '포스 이름·가격은 그대로', `${u.posName}/${u.posPrice}`);

    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
    ok((await post('/api/wine/update', { id: w.id, image: png })).status === 200, '사진 저장');
    const img = s.wines.find((x) => x.id === w.id);
    ok((await get(`/api/wine/image/${(await state()).wines.find((x) => x.id === w.id).image}`)).status === 200, '사진 내려받기');
    ok((await post('/api/wine/update', { id: w.id, image: 'data:text/html,<script>' })).status === 400, '사진 아닌 파일 거부');
    ok(img !== undefined, '사진 필드 존재');
  }

  section('포스에 있는 와인은 앱에서 못 지움');
  {
    const w = find(await state(), '가비-화이트');
    const r = await post('/api/wine/forget', { id: w.id });
    ok(r.status === 400 && /포스에서 지워주세요/.test(r.json.error), '포스에 있으면 거부하고 안내', r.json?.error);
  }

  section('파일 유지 (서버 재시작 대비)');
  {
    const s = await state();
    const file = path.join(DATA, 'wines.json');
    ok(fs.existsSync(file), 'wines.json 생성됨');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    ok(saved.version === 2, '새 형식(version 2)');
    ok(saved.wines.length === s.wines.length, `와인 ${s.wines.length}개 저장됨`);
    ok(saved.wines.every((w) => w.id && w.posName && typeof w.stock === 'number'), '필수 필드 저장됨');
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
