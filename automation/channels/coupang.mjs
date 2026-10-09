// 쿠팡이츠 스토어 채널 — 옵션 탭의 "젤라또 맛 선택" 그룹
// 쿠팡은 자동화 브라우저의 로그인을 차단(Akamai 403)하므로, 평소 쓰는 Chrome에 설치한
// 확장 "메뉴 자동화 브리지"(automation/chrome-extension)를 통해 조작한다.
//   숨김/숨김해제: 행의 편집(연필) → 상태 [옵션 숨김]/[판매중] → [저장]
//   신규 추가:     [옵션 추가] → 옵션명·가격 → [저장]
import fs from 'node:fs';
import { matchOption, optionNameFor } from '../lib/names.mjs';
import { loadCred } from '../lib/secrets.mjs';
import { DEBUG_DIR } from '../lib/paths.mjs';

const OPTIONS_URL = 'https://store.coupangeats.com/merchant/management/menu/952343/options';
const GROUP_TITLE = '젤라또 맛 선택';
const PRICE = '0';
const ROW = '.option-item-range';
const ROW_NAME = '.option-item-title .high-light-wrapper-v2';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page = (br, action, params = {}) => br.call('page', { action, params });

async function openOptions(br) {
  await br.call('tab', { match: 'https://store.coupangeats.com/*', url: OPTIONS_URL });
  let { url } = await br.call('goto', { url: OPTIONS_URL });
  if (url.includes('/login')) {
    // 로그인 풀림 → 저장된 계정으로 로그인 (평소 Chrome 이므로 쿠팡 보안에 막히지 않음)
    const cred = loadCred('coupang');
    if (!cred) throw new Error('쿠팡이츠 로그인이 풀렸습니다. Chrome에서 로그인해 주세요.');
    await page(br, 'fill', { selector: '#loginId', value: cred.id });
    await page(br, 'fill', { selector: '#password', value: cred.pw });
    await page(br, 'click', { selector: 'button[type=submit]', wait: 50 }); // 클릭 후 페이지 이동 → 바로 반환
    await sleep(5000);
    ({ url } = await br.call('goto', { url: OPTIONS_URL }));
    if (url.includes('/login')) throw new Error('쿠팡이츠 자동 로그인 실패. Chrome에서 직접 로그인해 주세요.');
  }
  await page(br, 'waitText', { text: GROUP_TITLE, timeout: 20000 });
  await sleep(800);
}

async function readState(br) {
  const rows = await page(br, 'list', { selector: ROW, sub: ROW_NAME, ctxSel: '.group-item-title' });
  return rows
    .filter((r) => r.ctx === GROUP_TITLE && r.sub)
    .map((r) => ({
      name: r.sub,
      hidden: /option_not-expose/.test(r.parentCls) || /(^| )숨김( |$)/.test(r.text.replace(r.sub, '')),
      soldout: /품절/.test(r.text.replace(r.sub, '')),
    }));
}

function find(state, figmaName) {
  const hit = matchOption(figmaName, 'coupang', state.map((o) => o.name));
  return hit ? state.find((o) => o.name === hit) : null;
}

async function shot(br, tag) {
  try {
    const { dataUrl } = await br.call('capture');
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const file = `${DEBUG_DIR}/coupang-${Date.now()}-${tag}.png`;
    fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
    return file;
  } catch { return null; }
}

async function setHidden(br, opt, hide) {
  await page(br, 'clickRow', { rowSelector: ROW, textSelector: ROW_NAME, text: opt.name, target: '.option-item-edit', wait: 1200 });
  await page(br, 'waitText', { text: '옵션 편집', timeout: 10000 });
  await page(br, 'click', { text: hide ? '옵션 숨김' : '판매중', exact: true, within: '.display-status', wait: 500 });
  await page(br, 'click', { text: '저장', exact: true, wait: 2500 });
}

async function addOption(br, name) {
  await page(br, 'click', { selector: '[data-testid=option-item-add-button]', wait: 1200 });
  await page(br, 'waitText', { text: '옵션 추가', timeout: 10000 });
  await page(br, 'fill', { selector: 'input[name=optionItemName]', value: name });
  await page(br, 'fill', { selector: 'input[name=optionItemPrice]', value: PRICE });
  await page(br, 'click', { text: '저장', exact: true, wait: 2500 });
}

// opts.bridge: Chrome 확장 브리지(wsbridge, 포트 3056) — 서버/CLI가 만들어 넘겨준다
async function run(fn, { dryRun = false, bridge: br, onProgress = () => {} } = {}) {
  if (!br) throw new Error('Chrome 확장 브리지가 필요합니다.');
  if (!br.connected) {
    onProgress('Chrome 확장 연결 대기');
    await br.waitConnected(40000).catch(() => { throw new Error('Chrome 확장이 연결되지 않았습니다. 이 컴퓨터의 Chrome이 켜져 있는지 확인하세요.'); });
  }
  try {
    onProgress('쿠팡이츠 옵션 화면 여는 중');
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

async function ensure(figmaName, { hide, addIfMissing }, opts) {
  return run(async (br, dryRun, onProgress) => {
    const opt = find(await readState(br), figmaName);
    if (!opt) {
      if (!addIfMissing) return { changed: false, message: '옵션 없음 (변경 없음)' };
      const name = optionNameFor(figmaName, 'coupang');
      if (dryRun) return { changed: false, message: `[미리보기] '${name}' 새 옵션 추가 예정` };
      onProgress('새 옵션 추가 중');
      await addOption(br, name);
      await openOptions(br);
      if (!find(await readState(br), figmaName)) throw new Error(`'${name}' 추가 후 목록에서 확인되지 않습니다.`);
      return { changed: true, message: `'${name}' 새 옵션 추가` };
    }
    if (opt.hidden === hide) return { changed: false, message: `'${opt.name}' 이미 ${hide ? '숨김' : '노출'} 상태` };
    if (dryRun) return { changed: false, message: `[미리보기] '${opt.name}' ${hide ? '숨김' : '숨김해제'} 예정` };
    onProgress(`${hide ? '숨김' : '숨김해제'} 처리 중`);
    await setHidden(br, opt, hide);
    await openOptions(br);
    const after = find(await readState(br), figmaName);
    if (!after || after.hidden !== hide) throw new Error(`'${opt.name}' ${hide ? '숨김' : '숨김해제'} 후 상태가 바뀌지 않았습니다.`);
    return { changed: true, message: `'${opt.name}' ${hide ? '숨김' : '숨김해제'}` };
  }, opts);
}

export const coupang = {
  name: '쿠팡',
  add: (name, desc, opts) => ensure(name, { hide: false, addIfMissing: true }, opts),
  restore: (name, opts) => ensure(name, { hide: false, addIfMissing: true }, opts),
  soldout: (name, opts) => ensure(name, { hide: true, addIfMissing: false }, opts),
  seasonoff: (name, opts) => ensure(name, { hide: true, addIfMissing: false }, opts),
  later: (name, opts) => ensure(name, { hide: true, addIfMissing: false }, opts),
  state: (opts) => run((br) => readState(br), opts),
};
