#!/usr/bin/env node
// 메뉴 관리 서버 — http://localhost:8787
// 피그마 플러그인(3055)·Chrome 확장(3056) 연결을 유지하고, 메뉴 변경 작업을 한 번에 하나씩 실행한다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBridge, FIGMA_PORT, EXT_PORT } from './lib/wsbridge.mjs';
import { newJob, runJob } from './lib/ops.mjs';
import { figmaChannel } from './channels/figma.mjs';
import { createKeeper } from './lib/figma-keeper.mjs';
import { SECRETS_DIR } from './lib/secrets.mjs';
import { wineRoute } from './lib/wine-api.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const HTTP_PORT = Number(process.env.MENU_PORT || 8787);
const HOST = process.env.MENU_HOST || '127.0.0.1';
const LOG_DIR = path.join(here, 'logs');
const NEED_PLUGIN = 4;
const NEED_EXT = '1.2.1';

fs.mkdirSync(LOG_DIR, { recursive: true });
const log = (line) => {
  const s = `[${new Date().toLocaleString('ko-KR', { hour12: false })}] ${line}`;
  console.log(s);
  fs.appendFileSync(path.join(LOG_DIR, 'server.log'), s + '\n');
};

// ---------- 연결 ----------

const bridges = {
  figma: startBridge({ port: FIGMA_PORT, name: '피그마 플러그인' }),
  ext: startBridge({ port: EXT_PORT, name: 'Chrome 확장' }),
};
const figma = figmaChannel(bridges.figma);

// ---------- 상태 ----------

const state = {
  menu: null,          // 피그마 스냅샷 {live, soldout, seasonoff, later}
  menuAt: null,
  figmaError: null,    // 마지막 조회 오류
  appCheck: {},        // 배달앱 점검 결과 {baemin: {ok, message, at}, coupang: …}
  jobs: [],            // 최근 작업 (최신이 앞)
  keeperNote: '',      // 지킴이가 지금 하는 일 (피그마 깨우기 등)
};

// 피그마 지킴이 — 플러그인이 멈췄으면 깨우고, 앱이 꺼졌으면 띄운다. (lib/figma-keeper.mjs)
const keeper = createKeeper({
  bridge: bridges.figma,
  probe: () => figma.snapshot(),
  log,
  onNote: (t) => { state.keeperNote = t; push(); },
});
const queue = [];
let running = null;

// 작업 기록은 파일에 남긴다 — 서버가 재시작돼도 [실패한 곳만 다시 시도] 가능
const JOBS_FILE = path.join(LOG_DIR, 'jobs.json');
try {
  state.jobs = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
  for (const j of state.jobs) {
    if (j.state !== 'queued' && j.state !== 'running') continue;
    j.state = 'failed';
    for (const c of j.channels) if (c.state === 'pending' || c.state === 'running') { c.state = 'failed'; c.message = '서버 재시작으로 중단됨'; c.progress = ''; }
  }
} catch {}
let saveTimer = null;
const saveJobs = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => fs.writeFile(JOBS_FILE, JSON.stringify(state.jobs.slice(0, 50)), () => {}), 300); };

const verLt = (a, b) => {
  const pa = String(a || '0').split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0); }
  return false;
};

const GUIDE = {
  figmaOff: [
    '이 컴퓨터에서 피그마 앱을 열고 "메뉴판" 파일을 엽니다.',
    'Ctrl + K 를 누르고, Recents(최근 사용)에 있는 "메뉴판 자동화"를 누릅니다. (안 보이면 "메뉴판 자동화"를 검색)',
    '작은 창에 초록 점과 "연결됨"이 보이면 완료입니다. 그 창은 닫지 마세요.',
  ],
  figmaOld: ['피그마의 "메뉴판 자동화" 작은 창을 닫고, Ctrl + K → "메뉴판 자동화"를 다시 실행해 주세요. (새 버전 적용)'],
  figmaError: [
    '피그마 앱 위쪽에 "오프라인/재연결 중" 표시가 있는지 확인하세요.',
    '메뉴판 파일 탭을 닫았다가 다시 열고, Ctrl + K → "메뉴판 자동화"를 다시 실행해 주세요.',
  ],
  extOff: [
    '이 컴퓨터에서 Chrome을 켜주세요. (Chrome이 꺼져 있으면 배민·쿠팡을 바꿀 수 없어요)',
    '1분 정도 기다려도 빨간불이면, Chrome에서 배민 셀프서비스나 쿠팡이츠 사장님 사이트를 한 번 열어주세요.',
    '그래도 안 되면 Chrome 주소창에 chrome://extensions 입력 → "메뉴 자동화 브리지"가 켜져 있는지 확인하세요.',
  ],
  extOld: ['Chrome 주소창에 chrome://extensions 입력 → "메뉴 자동화 브리지" 카드의 새로고침(↻) 버튼을 눌러주세요.'],
  baeminLogin: ['Chrome에서 배민 셀프서비스(self.baemin.com)에 로그인해 주세요. "자동 로그인"을 체크하면 다음부터 유지돼요.', '로그인 후 [다시 점검]을 눌러주세요.'],
  coupangLogin: ['Chrome에서 쿠팡이츠 사장님 사이트(store.coupangeats.com)에 로그인해 주세요.', '로그인 후 [다시 점검]을 눌러주세요.'],
  appBlocked: ['배민이 잠시 이용을 제한했어요. 10~30분 뒤 [다시 점검]을 눌러주세요.'],
};

function statusOf() {
  const f = bridges.figma, x = bridges.ext;
  let figmaS;
  // 지킴이가 깨우는 중이면 빨간불로 겁주지 않는다 — 곧 알아서 된다
  if (keeper.working) figmaS = { light: 'gray', title: state.keeperNote || '피그마 플러그인을 기다리는 중…', detail: '작업은 큐에서 기다리다가, 플러그인이 켜지면 이어서 처리됩니다.', guide: GUIDE.figmaOff };
  else if (!f.connected) figmaS = { light: 'red', title: '피그마 플러그인이 꺼져 있어요', guide: GUIDE.figmaOff };
  else if ((f.info?.version || 0) < NEED_PLUGIN) figmaS = { light: 'red', title: '피그마 플러그인을 다시 실행해야 해요', guide: GUIDE.figmaOld };
  else if (state.figmaError) figmaS = { light: 'red', title: '피그마 메뉴판을 읽지 못했어요', detail: state.figmaError, guide: GUIDE.figmaError };
  else figmaS = {
    light: state.menu ? 'green' : 'gray',
    title: state.menu ? '연결됨' : '확인 중…',
    detail: state.menu
      ? `판매중 ${state.menu.live.length}개${state.menu.live.some((m) => m.deliveryOff) ? ` (배달 OFF ${state.menu.live.filter((m) => m.deliveryOff).length})` : ''} · 비활성 ${state.menu.soldout.length + state.menu.seasonoff.length + state.menu.later.length}개`
      : '',
  };

  const app = (key, loginGuide) => {
    const hasCred = fs.existsSync(path.join(SECRETS_DIR, `${key}.cred`));
    if (!x.connected) return { light: 'red', title: 'Chrome 확장이 연결되지 않았어요', guide: GUIDE.extOff };
    if (verLt(x.info?.version, NEED_EXT)) return { light: 'red', title: 'Chrome 확장을 새로고침해야 해요', guide: GUIDE.extOld };
    const c = state.appCheck[key];
    if (c && !c.ok) {
      const blocked = /제한/.test(c.message);
      return { light: 'red', title: blocked ? '일시적으로 이용이 제한됐어요' : '점검에 실패했어요', detail: c.message.split('\n')[0], guide: blocked ? GUIDE.appBlocked : loginGuide, checkedAt: c.at };
    }
    return {
      light: 'green',
      title: c ? '정상' : 'Chrome 연결됨',
      detail: c ? c.message : (hasCred ? '로그인이 풀려도 자동으로 다시 로그인해요' : '로그인 정보가 저장돼 있지 않아요 (로그인 유지 필요)'),
      checkedAt: c?.at,
    };
  };
  return { figma: figmaS, baemin: app('baemin', GUIDE.baeminLogin), coupang: app('coupang', GUIDE.coupangLogin) };
}

// ---------- 실시간 전송 (SSE) ----------

const clients = new Set();
let pushTimer = null;
function snapshotForClient() {
  return { status: statusOf(), menu: state.menu, menuAt: state.menuAt, jobs: state.jobs.slice(0, 20), running: running?.id || null, queued: queue.map((j) => j.id) };
}
function push() {
  saveJobs();
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    const data = `event: state\ndata: ${JSON.stringify(snapshotForClient())}\n\n`;
    clients.forEach((res) => res.write(data));
  }, 100);
}
bridges.figma.onChange(() => { if (bridges.figma.connected) refreshMenu(); else push(); });
bridges.ext.onChange(push);

// ---------- 피그마 메뉴판 조회 ----------

let refreshing = false;
async function refreshMenu() {
  if (refreshing || !bridges.figma.connected || (bridges.figma.info?.version || 0) < NEED_PLUGIN) { push(); return; }
  refreshing = true;
  try {
    const r = await figma.snapshot();
    state.menu = r.snapshot;
    state.menuAt = Date.now();
    state.figmaError = null;
  } catch (e) {
    state.figmaError = String(e.message || e);
  } finally {
    refreshing = false;
    push();
  }
}
setInterval(() => { if (!running) refreshMenu(); }, 10000);

// 플러그인이 붙어 있는데 응답하지 않으면 그 순간의 상태를 기록해 둔다
setInterval(() => { if (!running && !keeper.working) keeper.healQuietly(); }, 30000);

// ---------- 작업 큐 ----------

function enqueue(spec) {
  const job = newJob(spec);
  state.jobs.unshift(job);
  state.jobs = state.jobs.slice(0, 50);
  queue.push(job);
  log(`접수: ${job.label} ${job.name}${job.desc ? ` / "${job.desc}"` : ''}${spec.only ? ` (only ${spec.only.join(',')})` : ''}`);
  push();
  setImmediate(drain);
  return job;
}

// 피그마가 멈춰 있으면 깨운다 — 작업 실행기(ops)가 피그마 단계 직전에 부른다
const ensureFigma = (onProgress) => keeper.ensure(onProgress);

async function drain() {
  if (running || !queue.length) return;
  running = queue.shift();
  let figmaRefreshed = false;
  const onUpdate = (job) => {
    // 피그마 단계가 끝나면 바로 목록 갱신 (배달앱 작업을 기다리지 않고 페이지에 반영)
    const f = job.channels.find((c) => c.key === 'figma');
    if (f && f.state === 'done' && !figmaRefreshed) { figmaRefreshed = true; refreshMenu(); }
    push();
  };
  try {
    await runJob(running, { ...bridges, ensureFigma }, onUpdate);
  } catch (e) {
    running.state = 'failed';
    running.error = String(e.message || e);
  }
  const j = running;
  if (j.cmd === 'check') {
    for (const c of j.channels) state.appCheck[c.key] = { ok: c.state === 'done', message: c.message, at: Date.now() };
  }
  log(`${j.state === 'done' ? '완료' : '실패'}: ${j.label} ${j.resolvedName || j.name} — ${j.channels.map((c) => `${c.name}:${c.state}${c.state === 'failed' ? `(${c.message.split('\n')[0]})` : ''}`).join(', ')}`);
  running = null;
  await refreshMenu();
  setImmediate(drain);
}

// ---------- HTTP ----------

const INDEX = path.join(here, 'web', 'index.html');

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readBody(req) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 1e5) throw new Error('too large'); }
  return s ? JSON.parse(s) : {};
}

// 와인 탭 — /api/wine/* 와 /wine.js·/wine.css 를 전담한다 (젤라또와 상태·큐 분리)
const wine = wineRoute({ busy: () => !!running, log });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (await wine(req, res, url)) return;
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return send(res, 200, fs.readFileSync(INDEX, 'utf8'), 'text/html; charset=utf-8');
    if (req.method === 'GET' && ['/favicon.png', '/favicon.ico'].includes(url.pathname)) {
      res.writeHead(200, { 'content-type': url.pathname.endsWith('.png') ? 'image/png' : 'image/x-icon', 'cache-control': 'max-age=86400' });
      return res.end(fs.readFileSync(path.join(here, 'web', url.pathname.slice(1))));
    }
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, snapshotForClient());
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify(snapshotForClient())}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    const jobMatch = url.pathname.match(/^\/api\/jobs\/([\w]+)$/);
    if (req.method === 'GET' && jobMatch) {
      const job = state.jobs.find((j) => j.id === jobMatch[1]);
      return job ? send(res, 200, job) : send(res, 404, { error: '작업을 찾을 수 없습니다.' });
    }

    if (req.method === 'POST') {
      // 다른 웹사이트가 이 서버를 몰래 호출하지 못하도록 (브라우저는 교차 출처 요청에 이 헤더를 못 붙인다)
      if (req.headers['x-menu-app'] !== '1') return send(res, 403, { error: 'forbidden' });
      const body = await readBody(req);
      if (url.pathname === '/api/jobs') {
        const job = enqueue({ cmd: body.cmd, name: body.name, desc: body.desc, isNew: !!body.isNew, isBest: !!body.isBest, badges: body.badges || [], badge: body.badge || null, on: !!body.on, only: body.only || null, dryRun: !!body.dryRun });
        return send(res, 200, job);
      }
      const retry = url.pathname.match(/^\/api\/jobs\/([\w]+)\/retry$/);
      if (retry) {
        const prev = state.jobs.find((j) => j.id === retry[1]);
        if (!prev) return send(res, 404, { error: '작업을 찾을 수 없습니다.' });
        const only = prev.channels.filter((c) => c.state === 'failed' || c.state === 'skipped').map((c) => c.key);
        if (!only.length) return send(res, 400, { error: '다시 시도할 채널이 없습니다.' });
        const job = enqueue({ cmd: prev.cmd, name: prev.resolvedName || prev.name, desc: prev.desc, isNew: prev.isNew, isBest: prev.isBest, badges: prev.badges, badge: prev.badge, on: prev.on, only });
        return send(res, 200, job);
      }
      if (url.pathname === '/api/refresh') { await refreshMenu(); return send(res, 200, snapshotForClient()); }
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 400, { error: String(e.message || e) });
  }
});

server.on('error', (e) => {
  log(e.code === 'EADDRINUSE' ? `포트 ${HTTP_PORT}이 이미 사용 중 — 서버가 이미 실행 중입니다.` : `서버 오류: ${e.message}`);
  process.exit(1);
});
server.listen(HTTP_PORT, HOST, () => log(`메뉴 관리 서버 시작: http://localhost:${HTTP_PORT}`));
