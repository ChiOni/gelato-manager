// 배민 셀프서비스 채널 — 옵션그룹 "맛 선택"(일반) + "리뷰 이벤트 (맛 1가지 추가)"(리뷰)
// 평소 쓰는 Chrome에 설치한 확장 "메뉴 자동화 브리지"(automation/chrome-extension)로 조작한다.
// (자동화 브라우저는 배민이 '비정상 동작'으로 차단하는 경우가 있어 실제 Chrome을 사용)
//   숨김/숨김해제: 옵션 클릭 → 시트의 [숨김]/[숨김해제]
//   신규 추가:     그룹 [변경] → 옵션 [변경] → [새 옵션 추가] → 옵션명·가격 → [적용하기] → [적용하기]
import fs from 'node:fs';
import { matchOption, optionNameFor } from '../lib/names.mjs';
import { loadCred } from '../lib/secrets.mjs';
import { DEBUG_DIR } from '../lib/paths.mjs';

const OPTIONS_URL = 'https://self.baemin.com/shops/14831943/menu-management/option-groups';
const GROUPS = [
  { key: 'normal', title: '맛 선택', label: '일반', prefix: '' },
  { key: 'review', title: '리뷰 이벤트 (맛 1가지 추가)', label: '리뷰', prefix: '[리뷰] ' },
];
const PRICE = '0';
const DIALOG = '[role=dialog]';
const BAEMIN_TABS = ['https://self.baemin.com/*', 'https://biz-member.baemin.com/*'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page = (br, action, params = {}) => br.call('page', { action, params });

// ---------- 페이지 ----------

async function openOptions(br) {
  await br.call('tab', { match: BAEMIN_TABS, url: OPTIONS_URL });
  let { url } = await br.call('goto', { url: OPTIONS_URL });
  await sleep(1500);
  ({ url } = await br.call('tab', { match: BAEMIN_TABS }));
  if (/login/.test(url)) {
    // 로그인 풀림 → 저장된 계정으로 로그인 (자동 로그인 체크)
    const cred = loadCred('baemin');
    if (!cred) throw new Error('배민 로그인이 풀렸습니다. Chrome에서 배민 셀프서비스에 로그인해 주세요.');
    await page(br, 'fill', { selector: 'input[name=id]', value: cred.id });
    await page(br, 'fill', { selector: 'input[name=password]', value: cred.pw });
    await page(br, 'click', { text: '자동 로그인', exact: true, wait: 300 }).catch(() => {});
    await page(br, 'click', { selector: 'button[type=submit]', wait: 50 });
    await sleep(5000);
    ({ url } = await br.call('goto', { url: OPTIONS_URL }));
    if (/login/.test(url)) throw new Error('배민 자동 로그인 실패. Chrome에서 직접 로그인해 주세요.');
  }
  const blocked = await page(br, 'waitText', { text: '잠시 이용이 제한돼요', timeout: 1500 }).then(() => true, () => false);
  if (blocked) throw new Error('배민이 일시적으로 이용을 제한했습니다(비정상 동작 감지). 10~30분 뒤 다시 시도하세요.');
  await page(br, 'waitText', { text: GROUPS[1].title, timeout: 45000 });
  await sleep(1200);
}

// 버튼 텍스트 = "[상태 라벨들] 옵션명 가격원"  예) "숨김 [리뷰] 레몬요거트 0원"
async function readState(br) {
  const rows = await page(br, 'groupedButtons', {
    titles: GROUPS.map((g) => g.title),
    headRe: String.raw`^\[(선택|필수)\]`,
    textRe: String.raw` [\d,]+원$`,
  });
  const state = Object.fromEntries(GROUPS.map((g) => [g.key, []]));
  for (const r of rows) {
    const g = GROUPS.find((x) => x.title === r.group);
    const labels = (r.text.match(/^((숨김|품절)\s+)+/) || [''])[0];
    let name = r.text.slice(labels.length).replace(/ [\d,]+원$/, '');
    if (g.prefix && name.startsWith(g.prefix)) name = name.slice(g.prefix.length);
    state[g.key].push({ idx: r.i, name: name.trim(), hidden: /숨김/.test(labels), soldout: /품절/.test(labels) });
  }
  return state;
}

function find(state, groupKey, figmaName) {
  const list = state[groupKey];
  const hit = matchOption(figmaName, 'baemin', list.map((o) => o.name));
  return hit ? list.find((o) => o.name === hit) : null;
}

// ---------- 동작 ----------

async function closeDialogs(br) {
  for (let i = 0; i < 3; i++) {
    const r = await page(br, 'click', { text: '닫기', exact: true, within: DIALOG, wait: 500 }).catch(() => null);
    if (!r) break;
  }
}

async function setHidden(br, opt, hide) {
  await page(br, 'click', { selector: `[data-mx-opt="${opt.idx}"]`, wait: 1200 });
  await page(br, 'waitText', { text: '옵션 삭제하기', within: DIALOG, timeout: 10000 });
  await page(br, 'click', { text: hide ? '숨김' : '숨김해제', exact: true, within: DIALOG, wait: 1200 });
  // 확인 팝업이 뜨는 경우
  await page(br, 'click', { text: '확인', exact: true, within: DIALOG, wait: 800 }).catch(() => {});
  await closeDialogs(br);
}

async function addOption(br, group, optionName) {
  await page(br, 'clickAfter', { anchorText: group.title, targetText: '변경', wait: 1500 });
  await page(br, 'waitText', { text: '옵션', within: DIALOG, timeout: 10000 });
  await page(br, 'clickAfter', { anchorText: '옵션', targetText: '변경', within: DIALOG, wait: 1500 });
  await page(br, 'click', { text: '새 옵션 추가', exact: true, within: DIALOG, wait: 1200 });
  await page(br, 'fill', { selector: 'input[type=text]', nth: 0, within: DIALOG, value: optionName });
  await page(br, 'fill', { selector: 'input[type=text]', nth: 1, within: DIALOG, value: PRICE });
  await page(br, 'click', { text: '적용하기', exact: true, within: DIALOG, wait: 1500 }); // 새 옵션 입력 적용
  await page(br, 'waitText', { text: optionName, within: DIALOG, timeout: 5000 });
  await page(br, 'click', { text: '적용하기', exact: true, within: DIALOG, wait: 2000 }); // 옵션 목록 변경 적용
  await page(br, 'click', { text: '확인', exact: true, within: DIALOG, wait: 800 }).catch(() => {});
  await closeDialogs(br);
}

async function shot(br, tag) {
  try {
    const { dataUrl } = await br.call('capture');
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const file = `${DEBUG_DIR}/baemin-${Date.now()}-${tag}.png`;
    fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
    return file;
  } catch { return null; }
}

// ---------- 채널 인터페이스 ----------

// opts.bridge: Chrome 확장 브리지(wsbridge, 포트 3056) — 서버/CLI가 만들어 넘겨준다
async function run(fn, { dryRun = false, bridge: br, onProgress = () => {} } = {}) {
  if (!br) throw new Error('Chrome 확장 브리지가 필요합니다.');
  if (!br.connected) {
    onProgress('Chrome 확장 연결 대기');
    await br.waitConnected(40000).catch(() => { throw new Error('Chrome 확장이 연결되지 않았습니다. 이 컴퓨터의 Chrome이 켜져 있는지 확인하세요.'); });
  }
  try {
    onProgress('배민 옵션 화면 여는 중');
    await openOptions(br);
    return await fn(br, dryRun, onProgress);
  } catch (e) {
    const file = await shot(br, 'error');
    if (file) e.message += `\n   (화면: ${file})`;
    throw e;
  } finally {
    await br.call('release').catch(() => {}); // 작업 전 보던 탭으로 되돌리기
  }
}

// 숨김 여부를 맞춘다. 옵션이 없으면 addIfMissing 일 때 추가.
async function ensure(figmaName, { hide, addIfMissing }, opts) {
  return run(async (br, dryRun, onProgress) => {
    const lines = [];
    let changed = false;
    for (const g of GROUPS) {
      const opt = find(await readState(br), g.key, figmaName);
      if (!opt) {
        if (!addIfMissing) { lines.push(`${g.label}: 옵션 없음 (변경 없음)`); continue; }
        const name = g.prefix + optionNameFor(figmaName, 'baemin');
        if (dryRun) { lines.push(`${g.label}: '${name}' 새 옵션 추가 예정`); continue; }
        onProgress(`${g.label}: 새 옵션 추가 중`);
        await addOption(br, g, name);
        await openOptions(br);
        if (!find(await readState(br), g.key, figmaName)) throw new Error(`${g.label}: '${name}' 추가 후 목록에서 확인되지 않습니다.`);
        lines.push(`${g.label}: '${name}' 새 옵션 추가`);
        changed = true;
        continue;
      }
      if (opt.hidden === hide) { lines.push(`${g.label}: '${opt.name}' 이미 ${hide ? '숨김' : '노출'} 상태`); continue; }
      if (dryRun) { lines.push(`${g.label}: '${opt.name}' ${hide ? '숨김' : '숨김해제'} 예정`); continue; }
      onProgress(`${g.label}: ${hide ? '숨김' : '숨김해제'} 처리 중`);
      await setHidden(br, opt, hide);
      await openOptions(br);
      const after = find(await readState(br), g.key, figmaName);
      if (!after || after.hidden !== hide) throw new Error(`${g.label}: '${opt.name}' ${hide ? '숨김' : '숨김해제'} 후 상태가 바뀌지 않았습니다.`);
      lines.push(`${g.label}: '${opt.name}' ${hide ? '숨김' : '숨김해제'}`);
      changed = true;
    }
    return { changed, message: (dryRun ? '[미리보기] ' : '') + lines.join(' / ') };
  }, opts);
}

export const baemin = {
  name: '배민',
  add: (name, desc, opts) => ensure(name, { hide: false, addIfMissing: true }, opts),
  restore: (name, opts) => ensure(name, { hide: false, addIfMissing: true }, opts),
  soldout: (name, opts) => ensure(name, { hide: true, addIfMissing: false }, opts),
  seasonoff: (name, opts) => ensure(name, { hide: true, addIfMissing: false }, opts),
  later: (name, opts) => ensure(name, { hide: true, addIfMissing: false }, opts),
  state: (opts) => run((br) => readState(br), opts),
};
