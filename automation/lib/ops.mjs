// 메뉴 변경 작업 실행기 — 웹 서버와 menu CLI 가 함께 쓴다.
// 피그마(메뉴판 = 기준) → 배민 → 쿠팡 순서로 실행하고, 채널별 진행/결과를 기록한다.
import { figmaChannel } from '../channels/figma.mjs';
import { baemin } from '../channels/baemin.mjs';
import { coupang } from '../channels/coupang.mjs';

export const CHANNEL_NAMES = { figma: '피그마', baemin: '배민', coupang: '쿠팡' };

// cmd → 실행할 채널
const PLAN = {
  add: ['figma', 'baemin', 'coupang'],
  restore: ['figma', 'baemin', 'coupang'],
  soldout: ['figma', 'baemin', 'coupang'],
  seasonoff: ['figma', 'baemin', 'coupang'],
  later: ['figma', 'baemin', 'coupang'],
  setDesc: ['figma'],
  setBadge: ['figma'],
  deliveryOff: ['figma', 'baemin', 'coupang'], // 메뉴판은 판매중 유지, 배달앱만 숨김
  deliveryOn: ['figma', 'baemin', 'coupang'],
  tidy: ['figma'],
  check: ['baemin', 'coupang'],
};

export const COMMAND_LABEL = {
  add: '신규 추가', restore: '활성화', soldout: '비활성화(Sold out)', seasonoff: '비활성화(Season off)',
  later: '비활성화(See you later)', setDesc: '설명 수정', setBadge: '뱃지 변경', deliveryOff: '배달만 OFF', deliveryOn: '배달 다시 ON', tidy: '메뉴판 정리', check: '배달앱 점검',
};

export function validate({ cmd, name, desc, badge }) {
  if (!PLAN[cmd]) throw new Error(`알 수 없는 작업: ${cmd}`);
  if (cmd === 'setBadge' && !['new', 'best'].includes(badge)) throw new Error('뱃지는 new 또는 best 만 가능합니다.');
  if (!['tidy', 'check'].includes(cmd) && !String(name || '').trim()) throw new Error('메뉴 이름이 필요합니다.');
  if (['add', 'setDesc'].includes(cmd) && !String(desc || '').trim()) throw new Error('설명이 필요합니다.');
}

// isNew/isBest: 신규 추가 시 뱃지 · badges: 활성화 시 다시 붙일 뱃지 ['NEW','best'] · badge/on: 뱃지 켜고 끄기
export function newJob({ cmd, name = '', desc = '', isNew = false, isBest = false, badges = [], badge = null, on = false, only = null, dryRun = false }) {
  validate({ cmd, name, desc, badge });
  const keys = PLAN[cmd].filter((k) => !only || only.includes(k));
  const label = cmd === 'setBadge' ? `${badge === 'new' ? 'NEW' : 'BEST'} ${on ? '켜기' : '끄기'}` : COMMAND_LABEL[cmd];
  return {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    cmd, label, name: String(name).trim(), desc: String(desc).trim(), isNew: !!isNew, isBest: !!isBest,
    badges: (badges || []).filter((b) => ['NEW', 'best'].includes(b)), badge, on: !!on, dryRun,
    state: 'queued', createdAt: Date.now(), startedAt: null, finishedAt: null,
    channels: keys.map((key) => ({ key, name: CHANNEL_NAMES[key], state: 'pending', progress: '', message: '' })),
  };
}

// bridges: { figma: wsbridge(3055), ext: wsbridge(3056) } / onUpdate(job) 은 상태가 바뀔 때마다 호출
export async function runJob(job, bridges, onUpdate = () => {}) {
  const figma = figmaChannel(bridges.figma);
  const apps = { baemin, coupang };
  const touch = () => onUpdate(job);
  job.state = 'running';
  job.startedAt = Date.now();
  touch();

  let canonical = job.name; // 피그마가 찾은 정식 메뉴명을 배달앱에 넘긴다 (민트초코 → 민트 초코)
  let abort = null;

  for (const ch of job.channels) {
    if (abort) { ch.state = 'skipped'; ch.message = abort; touch(); continue; }
    ch.state = 'running';
    touch();
    const onProgress = (p) => { ch.progress = p; touch(); };
    try {
      let r;
      if (ch.key === 'figma') {
        // 플러그인이 멈춰 있으면(창 최소화로 렌더러가 얼었거나 앱이 꺼졌으면) 지킴이가 깨운다.
        // 예전에는 여기서 바로 "연결되어 있지 않습니다"로 실패해, 피그마를 손으로 켜야 했다.
        if (bridges.ensureFigma && !(await bridges.ensureFigma(onProgress))) {
          throw new Error('피그마 플러그인을 깨우지 못했습니다. 피그마에서 Ctrl+K → "메뉴판 자동화"를 실행해 주세요.');
        }
        if (job.dryRun) {
          const snap = (await figma.snapshot()).snapshot;
          const hit = Object.values(snap).flat().find((i) => i.name.replace(/\s+/g, '') === canonical.replace(/\s+/g, ''));
          if (hit) canonical = hit.name;
          r = { changed: false, message: `[미리보기] 변경 없음${hit ? ` (메뉴명 '${hit.name}')` : ''}` };
        } else if (job.cmd === 'add') r = await figma.add(canonical, job.desc, { new: job.isNew, best: job.isBest, onProgress });
        else if (job.cmd === 'restore') r = await figma.restore(canonical, { badges: job.badges, onProgress });
        else if (job.cmd === 'setBadge') r = await figma.setBadge(canonical, job.badge, job.on, { onProgress });
        else if (job.cmd === 'deliveryOff' || job.cmd === 'deliveryOn') r = await figma.setDelivery(canonical, job.cmd === 'deliveryOff', { onProgress });
        else if (job.cmd === 'setDesc') r = await figma.setDesc(canonical, job.desc, { onProgress });
        else if (job.cmd === 'tidy') r = await figma.tidy({ onProgress });
        else r = await figma[job.cmd](canonical, { onProgress });
        if (r.name) canonical = r.name;
      } else {
        const opts = { bridge: bridges.ext, dryRun: job.dryRun, onProgress };
        if (job.cmd === 'check') {
          const s = await apps[ch.key].state(opts);
          const list = Array.isArray(s) ? s : Object.values(s).flat();
          r = { changed: false, message: `로그인·화면 정상 (옵션 ${list.length}개 확인)` };
        } else if (job.cmd === 'add') r = await apps[ch.key].add(canonical, job.desc, opts);
        else {
          // 배달만 OFF/ON 은 배달앱에서 숨김/숨김해제와 같다
          const appCmd = { deliveryOff: 'soldout', deliveryOn: 'restore' }[job.cmd] || job.cmd;
          r = await apps[ch.key][appCmd](canonical, opts);
        }
      }
      ch.state = 'done';
      ch.changed = !!r.changed;
      ch.message = r.message || '';
      ch.warnings = r.warnings || [];
      if (ch.key === 'figma') job.figmaResult = r;
    } catch (e) {
      ch.state = 'failed';
      ch.message = String(e.message || e);
      // 피그마(기준)가 실패하면 배달앱은 건드리지 않는다 — 서로 어긋나지 않게
      if (ch.key === 'figma') abort = '피그마 실패로 중단';
    }
    ch.progress = '';
    touch();
  }
  job.resolvedName = canonical;
  job.state = job.channels.some((c) => c.state === 'failed') ? 'failed' : 'done';
  job.finishedAt = Date.now();
  touch();
  return job;
}
