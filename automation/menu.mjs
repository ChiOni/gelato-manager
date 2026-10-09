#!/usr/bin/env node
// 메뉴 변경 CLI — 피그마 메뉴판 · 배민 · 쿠팡을 한 번에 갱신한다.
//
//   menu add <이름> <한줄설명> [--new] [--best]   신규 메뉴 → 판매중 (NEW·BEST 뱃지 선택)
//   menu restore <이름> [--new] [--best]          비활성 → 판매중 (뱃지 기본 OFF)
//   menu badge <이름> new|best on|off             판매중 메뉴의 NEW·BEST 표시 켜고 끄기
//   menu delivery <이름> off|on                   배달앱에서만 숨기기/다시 켜기 (메뉴판은 판매중 유지)
//   menu soldout <이름>                   판매중 → Sold out
//   menu seasonoff <이름>                 → Season off
//   menu later <이름>                     → See you later
//   menu desc <이름> <새 설명>            설명 수정 (피그마만)
//   menu status                           메뉴판 현재 상태
//   menu tidy                             메뉴판을 '깔끔하게 정리됨' 규격으로 정리
//   menu check                            배민·쿠팡 로그인/화면 점검
//   공통: --dry-run (배달앱은 바꾸지 않고 미리보기), --only figma,baemin,coupang
//
// 메뉴 관리 서버(automation/server.mjs)가 켜져 있으면 서버를 통해 실행하고,
// 꺼져 있으면 직접 피그마 플러그인·Chrome 확장에 연결해 실행한다.
import { startBridge, FIGMA_PORT, EXT_PORT } from './lib/wsbridge.mjs';
import { newJob, runJob } from './lib/ops.mjs';
import { createKeeper } from './lib/figma-keeper.mjs';
import { figmaChannel } from './channels/figma.mjs';

const SERVER = `http://127.0.0.1:${process.env.MENU_PORT || 8787}`;
const LABEL = { live: '판매중', soldout: 'Sold out', seasonoff: 'Season off', later: 'See you later' };
const USAGE = `사용법:
  menu add <이름> <한줄설명> [--new] [--best]
  menu restore <이름> [--new] [--best]
  menu badge <이름> new|best on|off
  menu delivery <이름> off|on
  menu soldout <이름>
  menu seasonoff <이름>
  menu later <이름>
  menu desc <이름> <새 설명>
  menu status
  menu tidy
  menu check
  (공통 옵션: --dry-run, --only figma,baemin,coupang)`;

// ---------- 출력 ----------

function printSnapshot(snap) {
  for (const key of Object.keys(LABEL)) {
    const items = snap[key] || [];
    console.log(`\n[${LABEL[key]}] ${items.length}개`);
    items.forEach((it) => console.log(`  - ${it.name}${it.badges.length ? ` (${it.badges.join(', ')})` : ''}  ·  ${it.desc}`));
  }
}

const ICON = { done: '✅', failed: '❌', skipped: '⏭ ', pending: '·', running: '…' };
function printJob(job) {
  for (const c of job.channels) {
    const icon = c.state === 'done' && !c.changed ? '➖' : ICON[c.state];
    console.log(`${icon} [${c.name}] ${c.message}`);
    (c.warnings || []).forEach((w) => console.log(`   ⚠️  ${w}`));
  }
  const fixes = job.figmaResult?.fixes || [];
  fixes.forEach((f) => console.log(`   🔧 ${f}`));
}

// ---------- 서버 경유 ----------

async function serverUp() {
  try { return (await fetch(`${SERVER}/api/health`, { signal: AbortSignal.timeout(800) })).ok; } catch { return false; }
}

async function viaServer(spec) {
  const r = await fetch(`${SERVER}/api/jobs`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-menu-app': '1' }, body: JSON.stringify(spec) });
  let job = await r.json();
  if (!r.ok) throw new Error(job.error);
  console.log('(메뉴 관리 서버를 통해 실행)');
  let last = '';
  while (job.state === 'queued' || job.state === 'running') {
    await new Promise((res) => setTimeout(res, 1000));
    job = await (await fetch(`${SERVER}/api/jobs/${job.id}`)).json();
    const ch = job.channels.find((c) => c.state === 'running');
    const line = job.state === 'queued' ? '대기 중' : ch ? `${ch.name}: ${ch.progress || '진행 중'}` : '';
    if (line && line !== last) { console.log(`   … ${line}`); last = line; }
  }
  return job;
}

// ---------- 직접 실행 ----------

async function direct(spec, { needExt }) {
  const bridges = {
    figma: startBridge({ port: FIGMA_PORT, name: '피그마 플러그인' }),
    ext: startBridge({ port: EXT_PORT, name: 'Chrome 확장' }),
  };
  // 피그마가 꺼져 있거나 멈춰 있으면 지킴이가 깨운다 (서버와 같은 동작)
  const keeper = createKeeper({
    bridge: bridges.figma,
    probe: () => figmaChannel(bridges.figma).snapshot(),
    log: (l) => console.log(`   … ${l}`),
  });
  const ensureFigma = (onProgress) => keeper.ensure(onProgress);
  try {
    const hint = setTimeout(() => console.log('⏳ 연결 대기 중… (피그마: 메뉴판 자동화 플러그인 / Chrome: 메뉴 자동화 브리지 확장)'), 2500);
    const waits = [];
    if (needExt) waits.push(bridges.ext.waitConnected(40000).catch(() => {})); // 확장은 채널에서 다시 기다림
    await Promise.all(waits).finally(() => clearTimeout(hint));
    if (spec.cmd === 'status') {
      if (!(await ensureFigma())) throw new Error('피그마 플러그인을 깨우지 못했습니다. 피그마에서 Ctrl+K → "메뉴판 자동화"를 실행하세요.');
      return { snapshot: (await figmaChannel(bridges.figma).snapshot()).snapshot };
    }
    let last = '';
    return await runJob(newJob(spec), { ...bridges, ensureFigma }, (job) => {
      const ch = job.channels.find((c) => c.state === 'running');
      const line = ch?.progress ? `${ch.name}: ${ch.progress}` : '';
      if (line && line !== last) { console.log(`   … ${line}`); last = line; }
    });
  } finally {
    bridges.figma.close();
    bridges.ext.close();
  }
}

// ---------- main ----------

async function main() {
  const argv = process.argv.slice(2);
  const onlyIdx = argv.findIndex((a) => a.startsWith('--only'));
  const onlyArg = onlyIdx >= 0 ? (argv[onlyIdx].split('=')[1] || argv[onlyIdx + 1] || '') : '';
  const only = onlyArg ? onlyArg.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const dryRun = argv.includes('--dry-run');
  const isNew = argv.includes('--new');
  const isBest = argv.includes('--best');
  const [cmd0, ...rest] = argv.filter((a, i) => !a.startsWith('--') && !(onlyIdx >= 0 && !argv[onlyIdx].includes('=') && i === onlyIdx + 1));
  const deliveryArg = cmd0 === 'delivery' ? argv.filter((a) => !a.startsWith('--'))[2] : null;
  if (cmd0 === 'delivery' && !['off', 'on'].includes(deliveryArg)) { console.error('사용법: menu delivery <이름> off|on'); process.exit(1); }
  const cmd = { desc: 'setDesc', badge: 'setBadge', delivery: deliveryArg === 'off' ? 'deliveryOff' : 'deliveryOn' }[cmd0] || cmd0;

  if (!['add', 'restore', 'soldout', 'seasonoff', 'later', 'setDesc', 'setBadge', 'deliveryOff', 'deliveryOn', 'status', 'tidy', 'check'].includes(cmd)) { console.log(USAGE); process.exit(cmd ? 1 : 0); }
  const name = rest[0] || '';
  const desc = rest.slice(1).join(' ');
  if (['add', 'restore', 'soldout', 'seasonoff', 'later', 'setDesc', 'setBadge', 'deliveryOff', 'deliveryOn'].includes(cmd) && !name) { console.log(USAGE); process.exit(1); }
  const [badge, onOff] = cmd === 'setBadge' ? rest.slice(1) : [];
  if (cmd === 'setBadge' && (!['new', 'best'].includes(badge) || !['on', 'off'].includes(onOff))) { console.error('사용법: menu badge <이름> new|best on|off'); process.exit(1); }
  if (['add', 'setDesc'].includes(cmd) && !desc) { console.error('설명을 입력하세요: menu add <이름> <한줄설명>'); process.exit(1); }

  const badges = cmd === 'restore' ? [...(isNew ? ['NEW'] : []), ...(isBest ? ['best'] : [])] : [];
  const spec = { cmd, name, desc: ['setBadge', 'deliveryOff', 'deliveryOn'].includes(cmd) ? '' : desc, isNew, isBest, badges, badge, on: onOff === 'on', only, dryRun };
  const up = await serverUp();

  if (cmd === 'status') {
    const snap = up ? (await (await fetch(`${SERVER}/api/state`)).json()).menu : (await direct(spec, { needExt: false })).snapshot;
    if (!snap) throw new Error('피그마 메뉴판을 아직 읽지 못했습니다. 피그마 플러그인이 켜져 있는지 확인하세요.');
    printSnapshot(snap);
    return;
  }

  const job = up ? await viaServer(spec) : await direct(spec, { needExt: !['setDesc', 'setBadge', 'tidy'].includes(cmd) });
  printJob(job);
  process.exit(job.state === 'failed' ? 1 : 0);
}

main().catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
