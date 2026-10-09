// 메뉴판 자동화 플러그인
// menu CLI(ws://localhost:3055) → ui.html → 이 코드 순서로 명령을 받아 피그마 메뉴판을 수정한다.
//
// 메뉴판(98:28) 안의 4개 Auto layout 프레임 = 4개 영역
//   live      좌상단 판매중 목록
//   soldout   좌하단 Sold out
//   seasonoff 좌하단 Season off
//   later     우하단 See you later
// 메뉴 = 영역 프레임의 직계 자식(이름 텍스트 + 설명 텍스트). 영역 이동 = appendChild.

const BOARD = { id: '98:28', name: '메뉴판' };
const SECTIONS = [
  { key: 'live', layer: '[판매중]', id: '1092:18', heading: null },
  { key: 'soldout', layer: '[Sold out]', id: '1168:12', heading: 'Sold out' },
  { key: 'seasonoff', layer: '[Season off]', id: '1169:49', heading: 'Season off' },
  { key: 'later', layer: '[See you later]', id: '1169:115', heading: 'See you later' },
];
const SECTION_LABEL = { live: '판매중', soldout: 'Sold out', seasonoff: 'Season off', later: 'See you later' };

// ---------- "깔끔하게 정리됨" 규격 ----------
// 모든 메뉴 아이템:  <메뉴명> Frame(세로, 간격 4, Hug)
//                     ├ title Frame(가로, 간격 6, Hug, 베이스라인 정렬)
//                     │   ├ 이름  Pretendard SemiBold 18 / 검정
//                     │   └ 뱃지  Pretendard Regular 14 / #862727 (NEW · ☆best · 계절 한정)
//                     └ 설명  Pretendard Regular 15 / 검정
// 공통: 줄간격 Auto, 자간 -3%, 텍스트 박스 Hug, 앞뒤 공백 제거·연속 공백 1칸
// 영역 프레임: 세로 Auto layout, 간격 20, Hug, 패딩 0 / 제목 SemiBold 22 (#862727), " - 부제" 15
const SPEC_VERSION = 'v1';
const PLUGIN_VERSION = 4; // 서버가 확인 — 코드가 바뀌면 올린다
const FONT = 'Pretendard';
const RED = { r: 134 / 255, g: 39 / 255, b: 39 / 255 };
const BLACK = { r: 0, g: 0, b: 0 };
const T = {
  name: { size: 18, style: 'SemiBold', color: BLACK },
  desc: { size: 15, style: 'Regular', color: BLACK },
  badge: { size: 14, style: 'Regular', color: RED },
  heading: { size: 22, style: 'SemiBold', color: RED },
};
const HEADING_SUB_SIZE = 15;
const GAP = { section: 20, item: 4, title: 6, star: 1 };

// 우측 상단 "판매 메뉴 & 가격" 영역 규격
// [Menu] Frame(세로, 블록 간격 56) @ 판매중 목록과 같은 y
//   ├ 기본 메뉴 블록(세로, 간격 40): 상품 × N
//   ├ Special Menu 블록(세로, 간격 12): 제목 + 상품
//   └ Instagram Event 블록(세로, 간격 12): 제목 + 설명
// 상품 = Frame(세로, 간격 12) > row(가로, 베이스라인) [상품명 고정폭 148 → 가격 세로줄 맞춤] + 설명
//   상품명 SemiBold 22 검정 / 가격 Medium 16 검정("120g / 4,500원") / 설명 Regular 14, 강조 #862727
const P = {
  product: { size: 22, style: 'SemiBold', color: BLACK },
  price: { size: 16, style: 'Medium', color: BLACK },
  pdesc: { size: 14, style: 'Regular', color: BLACK },
};
const PRODUCT_NAME_WIDTH = 148;
const PGAP = { block: 56, products: 40, inBlock: 12, product: 12 };
const PRODUCT_AREA = '[Menu]';
// 정리 전(레거시) 노드 ID — 최초 tidy 때 한 번만 사용
const LEGACY_PRODUCTS = {
  basic: [
    { title: '98:89', desc: '98:92' },
    { title: '896:18', desc: '896:21' },
    { title: '98:96', price: '98:95', desc: '98:98' },
  ],
  special: { heading: '1567:21', title: '1567:16', desc: '1567:19' },
  insta: { heading: '1621:36', desc: '1621:46' },
};
const STAR_SIZE = 16;
const STAR_SVG = '<svg width="17" height="17" viewBox="0 0 17 17" xmlns="http://www.w3.org/2000/svg"><path d="M6.26844 12.6258L8.49966 11.28L10.7309 12.6435L10.1465 10.0935L12.1121 8.39355L9.52673 8.16334L8.49966 5.75504L7.47259 8.14564L4.88721 8.37584L6.85281 10.0935L6.26844 12.6258ZM4.12576 15.583L5.27679 10.6071L1.41641 7.26023L6.51635 6.81753L8.49966 2.12487L10.483 6.81753L15.5829 7.26023L11.7225 10.6071L12.8736 15.583L8.49966 12.9445L4.12576 15.583Z" fill="#862727"/></svg>';

// ---------- 진행 보고 / 단계 타임아웃 ----------

let currentId = null;
function progress(text) {
  if (typeof figma !== 'undefined' && !figma.__mock && currentId) figma.ui.postMessage({ id: currentId, progress: text });
}

async function step(label, promise, ms = 30000) {
  progress(label);
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`'${label}' 단계가 ${ms / 1000}초 넘게 응답이 없습니다.`)), ms); });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer); }
}

// ---------- 노드 유틸 ----------

const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function isRedText(t) {
  const f = Array.isArray(t.fills) ? t.fills.find((p) => p.type === 'SOLID' && p.visible !== false) : null;
  return !!f && f.color.r > 0.4 && f.color.g < 0.3 && f.color.b < 0.3;
}

function isBold(t) {
  if (typeof t.fontWeight === 'number') return t.fontWeight >= 600;
  const style = t.fontName && t.fontName.style ? t.fontName.style : '';
  return /semibold|bold|black|heavy/i.test(style);
}

function textsOf(node, out = []) {
  if (node.visible === false) return out;
  if (node.type === 'TEXT') out.push(node);
  if ('children' in node) node.children.forEach((c) => textsOf(c, out));
  return out;
}

// 메뉴 아이템의 이름/설명 텍스트 노드 (빨간 텍스트 = NEW/best/계절 한정 뱃지 → 제외)
function nameDesc(item) {
  const texts = textsOf(item).filter((t) => !isRedText(t));
  const name = texts.find(isBold) || null;
  const desc = texts.find((t) => t !== name) || null;
  return { name, desc };
}

function absXY(node) {
  const m = node.absoluteTransform;
  return { x: m[0][2], y: m[1][2] };
}

// 그룹은 자식 좌표가 그룹의 부모 기준이므로 그룹이 아닌 조상까지 올라가서 기준점을 구한다
function setAbsPos(node, ax, ay) {
  let p = node.parent;
  while (p && p.type === 'GROUP') p = p.parent;
  const o = absXY(p);
  node.x = ax - o.x;
  node.y = ay - o.y;
}

async function loadFonts(textNode) {
  const fonts = textNode.getRangeAllFontNames(0, Math.max(1, textNode.characters.length));
  await Promise.all(fonts.map((f) => figma.loadFontAsync(f)));
}

async function loadSpecFonts() {
  await Promise.all(['Regular', 'Medium', 'SemiBold'].map((style) => figma.loadFontAsync({ family: FONT, style })));
}

// 아이템 안에서 빨간 텍스트만 가진 가지(뱃지)를 찾는다. filter로 특정 뱃지만 고를 수 있다.
function badgeBranches(item, filter) {
  const out = [];
  (function walk(n) {
    if (n === item || !('children' in n) || textsOf(n).some((t) => !isRedText(t))) {
      if ('children' in n) n.children.forEach(walk);
      return;
    }
    // n 이하에는 빨간 텍스트(또는 아이콘)만 존재 → 뱃지 가지
    const reds = textsOf(n);
    if (reds.length && (!filter || reds.some(filter))) out.push(n);
  })(item);
  // 빨간 TEXT 노드 자체가 뱃지인 경우 (가지로 묶이지 않은 것)
  (function walk(n) {
    if (!('children' in n) || n.visible === false) return;
    n.children.forEach((c) => {
      if (c.type === 'TEXT' && c.visible !== false && isRedText(c) && (!filter || filter(c)) && !out.some((b) => b === c || isAncestor(b, c))) out.push(c);
      else walk(c);
    });
  })(item);
  // 두 번의 탐색 결과를 레이어(화면) 순서로 정렬
  const order = new Map();
  (function dfs(n) { order.set(n, order.size); if ('children' in n) n.children.forEach(dfs); })(item);
  return out.sort((a, b) => order.get(a) - order.get(b));
}

function isAncestor(a, n) {
  for (let p = n.parent; p; p = p.parent) if (p === a) return true;
  return false;
}

// ---------- 규격 노드 생성 ----------

function styleText(t, spec) {
  t.fontName = { family: FONT, style: spec.style };
  t.fontSize = spec.size;
  t.lineHeight = { unit: 'AUTO' };
  t.letterSpacing = { unit: 'PERCENT', value: -3 };
  t.fills = [{ type: 'SOLID', color: spec.color }];
  t.textAutoResize = 'WIDTH_AND_HEIGHT';
}

function makeText(chars, spec, layerName) {
  const t = figma.createText();
  t.fontName = { family: FONT, style: spec.style };
  t.characters = chars;
  styleText(t, spec);
  t.name = layerName || chars;
  return t;
}

function autoFrame(name, direction, gap) {
  const f = figma.createFrame();
  f.name = name;
  f.layoutMode = direction;
  f.itemSpacing = gap;
  f.primaryAxisSizingMode = 'AUTO';
  f.counterAxisSizingMode = 'AUTO';
  f.paddingTop = f.paddingRight = f.paddingBottom = f.paddingLeft = 0;
  f.fills = [];
  f.clipsContent = false;
  return f;
}

function badgeKind(label) {
  const n = norm(label);
  if (n === 'new') return 'new';
  if (n.includes('best')) return 'best';
  if (n.includes('계절한정')) return 'seasonal';
  return null;
}

function makeBadge(label) {
  const kind = badgeKind(label);
  if (kind === 'best') {
    const f = autoFrame('badge/best', 'HORIZONTAL', GAP.star);
    f.counterAxisAlignItems = 'CENTER';
    const star = figma.createNodeFromSvg(STAR_SVG);
    star.name = 'star';
    star.fills = [];
    star.rescale(STAR_SIZE / star.width);
    f.appendChild(star);
    f.appendChild(makeText('best', T.badge));
    return f;
  }
  const text = kind === 'new' ? 'NEW' : kind === 'seasonal' ? '계절 한정' : clean(label);
  return makeText(text, T.badge, `badge/${kind || 'custom'}`);
}

function buildItem({ name, desc, badges }) {
  const item = autoFrame(clean(name), 'VERTICAL', GAP.item);
  const title = autoFrame('title', 'HORIZONTAL', GAP.title);
  try { title.counterAxisAlignItems = 'BASELINE'; } catch (e) { title.counterAxisAlignItems = 'CENTER'; }
  title.appendChild(makeText(clean(name), T.name, 'name'));
  (badges || []).forEach((b) => title.appendChild(makeBadge(b)));
  item.appendChild(title);
  item.appendChild(makeText(clean(desc), T.desc, 'desc'));
  item.setPluginData('spec', SPEC_VERSION);
  return item;
}

const isCanonical = (item) => item.getPluginData && item.getPluginData('spec') === SPEC_VERSION;

// ---------- 영역/아이템 탐색 ----------

async function getBoard() {
  let board = await figma.getNodeByIdAsync(BOARD.id);
  if (!board) {
    await figma.currentPage.loadAsync();
    board = figma.currentPage.findOne((n) => n.type === 'FRAME' && n.name === BOARD.name);
  }
  if (!board) throw new Error('메뉴판 프레임을 찾을 수 없습니다. 메뉴판 파일에서 플러그인을 실행하세요.');
  return board;
}

async function getSections(board) {
  const out = {};
  for (const def of SECTIONS) {
    let node = board.children.find((c) => c.name === def.layer);
    if (!node) {
      const byId = await figma.getNodeByIdAsync(def.id);
      if (byId && byId.parent === board) node = byId;
    }
    if (!node && def.heading) {
      node = board.children.find((c) => c.type === 'FRAME' && c.children.some((t) => t.type === 'TEXT' && t.characters.startsWith(def.heading)));
    }
    if (!node) throw new Error(`'${SECTION_LABEL[def.key]}' 영역 프레임을 찾을 수 없습니다.`);
    out[def.key] = node;
  }
  return out;
}

function headingOf(section) {
  const first = section.children[0];
  return first && first.type === 'TEXT' ? first : null;
}

function itemsOf(section) {
  return section.children.filter((c) => c.type !== 'TEXT' && c.layoutPositioning !== 'ABSOLUTE' && c.visible !== false && nameDesc(c).name);
}

function describe(item) {
  const { name, desc } = nameDesc(item);
  const badges = badgeBranches(item).map((b) => (b.type === 'TEXT' ? b.characters : textsOf(b).map((t) => t.characters).join('')).trim());
  return { name: name.characters.trim(), desc: desc ? desc.characters.trim() : '', badges, deliveryOff: isDeliveryOff(item) };
}

// ---------- 배달만 OFF ----------
// 매장(컵)에서는 팔지만 배달앱에서는 숨긴 메뉴. 메뉴판 화면에는 보이지 않는 플러그인 데이터로 기록한다.
const DELIVERY_KEY = 'deliveryOff';
const isDeliveryOff = (item) => !!(item.getPluginData && item.getPluginData(DELIVERY_KEY) === '1');
const setDeliveryOff = (item, off) => item.setPluginData(DELIVERY_KEY, off ? '1' : '');

function findItem(sections, query) {
  const q = norm(query);
  const all = [];
  for (const key of Object.keys(sections)) itemsOf(sections[key]).forEach((item) => all.push({ key, item, name: nameDesc(item).name.characters.trim() }));
  let hits = all.filter((a) => norm(a.name) === q);
  if (!hits.length) hits = all.filter((a) => norm(a.name).includes(q) || q.includes(norm(a.name)));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error(`'${query}'와 비슷한 메뉴가 여러 개입니다: ${hits.map((h) => h.name).join(', ')}`);
  return null;
}

// ---------- 기본 정리(매 명령 전, 화면 변화 없음) ----------

function normalize(board, sections) {
  const changes = [];
  for (const def of SECTIONS) {
    const s = sections[def.key];
    if (s.name !== def.layer) { s.name = def.layer; changes.push(`영역 이름 → ${def.layer}`); }
    // 아이템이 늘어나도 프레임이 따라 늘어나도록 (Hug)
    if (s.layoutMode !== 'NONE' && s.primaryAxisSizingMode !== 'AUTO') s.primaryAxisSizingMode = 'AUTO';

    // 영역 프레임에 떠 있는(absolute) 뱃지를 해당 아이템 안으로 붙인다 → 아이템과 같이 움직이게
    const items = itemsOf(s);
    for (const c of s.children.slice()) {
      if (c.layoutPositioning !== 'ABSOLUTE' || c.type === 'TEXT' && !isRedText(c)) continue;
      const cb = c.absoluteBoundingBox;
      const cy = cb.y + cb.height / 2;
      const owner = items.find((it) => {
        const ib = it.absoluteBoundingBox;
        return cy >= ib.y && cy <= ib.y + ib.height;
      });
      if (!owner) continue;
      owner.appendChild(c);
      if (owner.type !== 'GROUP' && owner.layoutMode && owner.layoutMode !== 'NONE') c.layoutPositioning = 'ABSOLUTE';
      if ('clipsContent' in owner) owner.clipsContent = false;
      setAbsPos(c, cb.x, cb.y);
      changes.push(`떠 있던 뱃지 → '${nameDesc(owner).name.characters.trim()}' 안으로 이동`);
    }

    // 레이어 이름을 메뉴명으로 (Frame 83 → 구운 아몬드)
    for (const it of items) {
      const n = nameDesc(it).name.characters.trim();
      if (/^(Frame|Group) \d+$/.test(it.name)) it.name = n;
    }
  }
  return changes;
}

// ---------- 규격 정리 (tidy) ----------

async function tidySection(section) {
  const report = { rebuilt: 0, removed: 0 };
  section.layoutMode = 'VERTICAL';
  section.itemSpacing = GAP.section;
  section.primaryAxisSizingMode = 'AUTO';
  section.counterAxisSizingMode = 'AUTO';
  section.counterAxisAlignItems = 'MIN';
  section.paddingTop = section.paddingRight = section.paddingBottom = section.paddingLeft = 0;
  section.clipsContent = false;

  const heading = headingOf(section);
  if (heading) {
    await loadFonts(heading);
    const chars = clean(heading.characters);
    heading.characters = chars;
    styleText(heading, T.heading);
    const sub = chars.indexOf('- ');
    if (sub > 0) heading.setRangeFontSize(sub, chars.length, HEADING_SUB_SIZE);
  }

  const items = itemsOf(section);
  for (const item of items) {
    if (isCanonical(item)) continue;
    const d = describe(item);
    const fresh = buildItem(d);
    setDeliveryOff(fresh, d.deliveryOff);
    section.insertChild(section.children.indexOf(item), fresh);
    item.remove();
    report.rebuilt++;
  }
  // 제목·메뉴가 아닌 잔여물(떠 있는 뱃지, 빈 프레임, 숨김 노드) 제거
  for (const c of section.children.slice()) {
    if (c === heading || isCanonical(c)) continue;
    c.remove();
    report.removed++;
  }
  return report;
}

// ---------- 우측 상단 판매 메뉴 & 가격 ----------

// 텍스트를 [{ch, red}] 로 읽는다 (빨간 강조 구간 보존용)
function richChars(t) {
  const segs = t.getStyledTextSegments(['fills']);
  const out = [];
  segs.forEach((s) => { const red = isRedText({ fills: s.fills }); for (const ch of s.characters) out.push({ ch, red }); });
  return out;
}

// 공백 정리(연속 공백 1칸, 줄 앞뒤 공백 제거, 끝 공백·줄바꿈 제거)하면서 강조 구간 유지
function cleanRich(chars) {
  const kept = [];
  for (const c of chars) {
    const last = kept[kept.length - 1];
    if (c.ch === '\n') { while (kept.length && kept[kept.length - 1].ch === ' ') kept.pop(); if (kept.length) kept.push(c); continue; }
    if (/\s/.test(c.ch)) { if (!last || last.ch === ' ' || last.ch === '\n') continue; kept.push({ ch: ' ', red: c.red }); continue; }
    kept.push(c);
  }
  while (kept.length && /\s/.test(kept[kept.length - 1].ch)) kept.pop();
  return kept;
}

function makeRichText(chars, spec, layerName) {
  const text = chars.map((c) => c.ch).join('');
  const t = makeText(text, spec, layerName);
  let i = 0;
  while (i < chars.length) {
    if (!chars[i].red) { i++; continue; }
    let j = i;
    while (j < chars.length && chars[j].red) j++;
    t.setRangeFills(i, j, [{ type: 'SOLID', color: RED }]);
    i = j;
  }
  return t;
}

const cleanPrice = (s) => clean(s).replace(/\s*\/\s*/g, ' / ');

function buildProduct({ name, price, desc }) {
  const f = autoFrame(clean(name), 'VERTICAL', PGAP.product);
  const row = autoFrame('row', 'HORIZONTAL', 0);
  try { row.counterAxisAlignItems = 'BASELINE'; } catch (e) { row.counterAxisAlignItems = 'CENTER'; }
  const n = makeText(clean(name), P.product, 'name');
  n.textAutoResize = 'HEIGHT';
  n.resize(PRODUCT_NAME_WIDTH, n.height); // 가격이 세로줄로 맞도록 상품명 칸 고정폭
  row.appendChild(n);
  row.appendChild(makeText(cleanPrice(price), P.price, 'price'));
  f.appendChild(row);
  f.appendChild(makeRichText(desc, P.pdesc, 'desc'));
  return f;
}

async function readLegacyProduct(def) {
  const title = await figma.getNodeByIdAsync(def.title);
  const descNode = await figma.getNodeByIdAsync(def.desc);
  if (!title || !descNode) throw new Error('우측 판매 메뉴 영역의 원본 노드를 찾지 못했습니다. (이미 수동으로 수정된 경우 알려주세요)');
  const texts = textsOf(title);
  const name = texts.find(isBold);
  let price = texts.find((t) => t !== name);
  if (def.price) price = await figma.getNodeByIdAsync(def.price);
  if (!name || !price) throw new Error(`상품명/가격을 읽지 못했습니다: ${title.name}`);
  await loadFonts(descNode);
  return { name: name.characters, price: price.characters, desc: cleanRich(richChars(descNode)), nodes: [title, descNode, price] };
}

async function tidyProducts(board, anchorY) {
  if (board.children.some((c) => c.name === PRODUCT_AREA && isCanonical(c))) return { rebuilt: 0 };

  const basic = [];
  for (const def of LEGACY_PRODUCTS.basic) basic.push(await readLegacyProduct(def));
  const special = await readLegacyProduct(LEGACY_PRODUCTS.special);
  const specialHeading = await figma.getNodeByIdAsync(LEGACY_PRODUCTS.special.heading);
  const instaHeading = await figma.getNodeByIdAsync(LEGACY_PRODUCTS.insta.heading);
  const instaDesc = await figma.getNodeByIdAsync(LEGACY_PRODUCTS.insta.desc);
  if (!specialHeading || !instaHeading || !instaDesc) throw new Error('Special Menu / Instagram Event 원본 노드를 찾지 못했습니다.');
  await loadFonts(instaDesc);
  const legacy = [...basic.flatMap((p) => p.nodes), ...special.nodes, specialHeading, instaHeading, instaDesc];
  const left = Math.round(Math.min(...legacy.map((n) => n.absoluteBoundingBox.x)));

  const area = autoFrame(PRODUCT_AREA, 'VERTICAL', PGAP.block);
  const basicBlock = autoFrame('기본 메뉴', 'VERTICAL', PGAP.products);
  basic.forEach((p) => basicBlock.appendChild(buildProduct(p)));
  const specialBlock = autoFrame('Special Menu', 'VERTICAL', PGAP.inBlock);
  specialBlock.appendChild(makeText(clean(specialHeading.characters), T.heading, 'heading'));
  specialBlock.appendChild(buildProduct(special));
  const instaBlock = autoFrame('Instagram Event', 'VERTICAL', PGAP.inBlock);
  instaBlock.appendChild(makeText(clean(instaHeading.characters), T.heading, 'heading'));
  instaBlock.appendChild(makeRichText(cleanRich(richChars(instaDesc)), P.pdesc, 'desc'));
  [basicBlock, specialBlock, instaBlock].forEach((b) => area.appendChild(b));
  area.setPluginData('spec', SPEC_VERSION);

  board.appendChild(area);
  setAbsPos(area, left, anchorY);
  legacy.forEach((n) => { if (!n.removed) n.remove(); });
  return { rebuilt: basic.length + 1 };
}

async function cmdTidy(board, sections) {
  const productsDone = board.children.some((c) => c.name === PRODUCT_AREA && isCanonical(c));
  const dirty = !productsDone || SECTIONS.some((def) => sections[def.key].children.some((c) => c !== headingOf(sections[def.key]) && !isCanonical(c)));
  if (dirty && figma.saveVersionHistoryAsync) await step('버전 기록에 백업 저장', figma.saveVersionHistoryAsync('메뉴판 자동 정리 전 백업', 'menu tidy 실행 직전 자동 저장'), 180000); // 버전 저장은 수십 초~2분 걸릴 수 있음
  await step('Pretendard 폰트 로드', loadSpecFonts());
  const lines = [];
  let total = 0;
  const liveTop = sections.live.absoluteBoundingBox.y;
  for (const def of SECTIONS) {
    const r = await step(`${SECTION_LABEL[def.key]} 정리`, tidySection(sections[def.key]), 60000);
    total += r.rebuilt + r.removed;
    lines.push(`${SECTION_LABEL[def.key]}: 메뉴 ${r.rebuilt}개 규격화${r.removed ? `, 잔여 노드 ${r.removed}개 제거` : ''}`);
  }
  const pr = await step('[Menu] 판매 메뉴 & 가격 정리', tidyProducts(board, liveTop), 60000);
  if (pr.rebuilt) { total += pr.rebuilt; lines.push(`판매 메뉴 & 가격: 상품 ${pr.rebuilt}개 규격화 (Special Menu · Instagram Event 포함)`); }
  return { changed: total > 0, message: total ? `메뉴판 정리 완료 (버전 기록에 백업 저장)\n   ${lines.join('\n   ')}` : '이미 깔끔한 상태입니다.' };
}

// ---------- 명령 ----------

function snapshot(sections) {
  const out = {};
  for (const def of SECTIONS) out[def.key] = itemsOf(sections[def.key]).map(describe);
  return out;
}

function layoutWarnings(board, sections) {
  const w = [];
  const bottom = (n) => n.absoluteBoundingBox.y + n.absoluteBoundingBox.height;
  const top = (n) => n.absoluteBoundingBox.y;
  if (bottom(sections.live) > top(sections.soldout) - 20) w.push('판매중 목록이 길어져 Sold out 영역과 겹칩니다. Sold out/Season off 위치를 내려주세요.');
  if (bottom(sections.soldout) > top(sections.seasonoff) - 20) w.push('Sold out 목록이 길어져 Season off 영역과 겹칩니다.');
  if (bottom(sections.seasonoff) > bottom(board)) w.push('Season off 목록이 메뉴판 아래로 넘칩니다.');
  if (bottom(sections.later) > bottom(board)) w.push('See you later 목록이 메뉴판 아래로 넘칩니다.');
  return w;
}

async function cmdAdd(sections, { name, desc, badges }) {
  if (!name || !desc) throw new Error('add 명령에는 name, desc가 필요합니다.');
  const exist = findItem(sections, name);
  if (exist && norm(exist.name) === norm(name)) {
    if (exist.key === 'live') return { changed: false, message: `'${exist.name}'은(는) 이미 판매중 목록에 있습니다.` };
    throw new Error(`'${exist.name}'은(는) 이미 '${SECTION_LABEL[exist.key]}'에 있는 기존 메뉴입니다. 신규 추가 대신 restore를 사용하세요.`);
  }
  await step('Pretendard 폰트 로드', loadSpecFonts());
  sections.live.appendChild(buildItem({ name, desc, badges: badges || [] }));
  return { changed: true, message: `'${clean(name)}' 판매중 목록 맨 아래에 추가` };
}

// ---------- NEW / BEST 뱃지 ----------
// NEW·best 는 켜고 끄는 뱃지, 그 외(계절 한정 등)는 그대로 유지한다.
const TOGGLE_BADGES = { new: 'NEW', best: 'best' };

function withBadges(current, flags) {
  const keep = current.filter((b) => !TOGGLE_BADGES[badgeKind(b)]);
  return [...(flags.new ? ['NEW'] : []), ...(flags.best ? ['best'] : []), ...keep];
}

function flagsOf(badges) {
  return { new: badges.some((b) => badgeKind(b) === 'new'), best: badges.some((b) => badgeKind(b) === 'best') };
}

// 아이템을 같은 자리에 규격대로 다시 만든다 (뱃지 변경용)
async function rebuild(item, data) {
  await step('Pretendard 폰트 로드', loadSpecFonts());
  const parent = item.parent;
  const fresh = buildItem(data);
  setDeliveryOff(fresh, isDeliveryOff(item));
  parent.insertChild(parent.children.indexOf(item), fresh);
  item.remove();
  return fresh;
}

// to=live(활성화) 일 때 badges: 다시 붙일 뱃지 (기본 없음 = NEW·best OFF)
async function cmdMove(sections, { name, to, badges }) {
  if (!sections[to]) throw new Error(`알 수 없는 영역: ${to}`);
  const hit = findItem(sections, name);
  if (!hit) throw new Error(`'${name}' 메뉴를 메뉴판에서 찾을 수 없습니다.`);
  if (hit.key === to) return { changed: false, name: hit.name, message: `'${hit.name}'은(는) 이미 ${SECTION_LABEL[to]}에 있습니다.` };
  const d = describe(hit.item);
  sections[to].appendChild(hit.item);
  setDeliveryOff(hit.item, false);
  // 활성화: NEW·best 는 요청한 것만 / 비활성화: NEW·best 제거 (다시 올라올 때 기본 OFF)
  const flags = to === 'live' ? flagsOf(badges || []) : { new: false, best: false };
  const next = withBadges(d.badges, flags);
  if (next.join('|') !== d.badges.join('|')) await rebuild(hit.item, { ...d, badges: next });
  const on = to === 'live' && next.filter((b) => TOGGLE_BADGES[badgeKind(b)]).length ? ` (${next.filter((b) => TOGGLE_BADGES[badgeKind(b)]).join(', ')} 표시)` : '';
  return { changed: true, name: hit.name, message: `'${hit.name}': ${SECTION_LABEL[hit.key]} → ${SECTION_LABEL[to]}${on}` };
}

async function cmdSetDelivery(sections, { name, off }) {
  const hit = findItem(sections, name);
  if (!hit) throw new Error(`'${name}' 메뉴를 메뉴판에서 찾을 수 없습니다.`);
  if (hit.key !== 'live') throw new Error(`'${hit.name}'은(는) 판매중 메뉴가 아닙니다. (배달만 끄기/켜기는 판매중 메뉴만 가능)`);
  const was = isDeliveryOff(hit.item);
  setDeliveryOff(hit.item, !!off);
  const label = off ? '배달만 OFF (메뉴판은 판매중 유지)' : '배달 다시 ON';
  // 피그마 기록이 이미 같아도 배달앱 쪽은 다시 맞추도록 changed 와 무관하게 진행된다
  return { changed: was !== !!off, name: hit.name, message: `'${hit.name}' ${label}${was === !!off ? ' — 메뉴판 기록은 이미 같음' : ''}` };
}

async function cmdSetBadge(sections, { name, badge, on }) {
  if (!TOGGLE_BADGES[badge]) throw new Error(`알 수 없는 뱃지: ${badge}`);
  const hit = findItem(sections, name);
  if (!hit) throw new Error(`'${name}' 메뉴를 메뉴판에서 찾을 수 없습니다.`);
  if (hit.key !== 'live') throw new Error(`'${hit.name}'은(는) 판매중 메뉴가 아니라 ${TOGGLE_BADGES[badge]} 표시를 바꿀 수 없습니다.`);
  const d = describe(hit.item);
  const flags = flagsOf(d.badges);
  const label = `${TOGGLE_BADGES[badge]} ${on ? 'ON' : 'OFF'}`;
  if (flags[badge] === !!on) return { changed: false, name: hit.name, message: `'${hit.name}' 이미 ${label}` };
  flags[badge] = !!on;
  await rebuild(hit.item, { ...d, badges: withBadges(d.badges, flags) });
  return { changed: true, name: hit.name, message: `'${hit.name}' ${label}` };
}

async function cmdSetDesc(sections, { name, desc }) {
  const text = clean(desc);
  if (!text) throw new Error('설명을 입력하세요.');
  const hit = findItem(sections, name);
  if (!hit) throw new Error(`'${name}' 메뉴를 메뉴판에서 찾을 수 없습니다.`);
  const d = nameDesc(hit.item).desc;
  if (!d) throw new Error(`'${hit.name}' 메뉴에 설명 텍스트가 없습니다.`);
  if (clean(d.characters) === text) return { changed: false, name: hit.name, message: `'${hit.name}' 설명이 이미 같습니다.` };
  await loadFonts(d);
  d.characters = text;
  return { changed: true, name: hit.name, message: `'${hit.name}' 설명 수정` };
}

async function handle(msg) {
  const board = await getBoard();
  const sections = await getSections(board);
  const fixes = normalize(board, sections);
  let result;
  if (msg.cmd === 'snapshot') result = { changed: false };
  else if (msg.cmd === 'add') result = await cmdAdd(sections, msg.args);
  else if (msg.cmd === 'move') result = await cmdMove(sections, msg.args);
  else if (msg.cmd === 'tidy') result = await cmdTidy(board, sections);
  else if (msg.cmd === 'setDesc') result = await cmdSetDesc(sections, msg.args);
  else if (msg.cmd === 'setBadge') result = await cmdSetBadge(sections, msg.args);
  else if (msg.cmd === 'setDelivery') result = await cmdSetDelivery(sections, msg.args);
  else throw new Error(`알 수 없는 명령: ${msg.cmd}`);
  if (result.changed || fixes.length) figma.commitUndo();
  return { ...result, fixes, warnings: layoutWarnings(board, sections), snapshot: snapshot(sections) };
}

// ---------- 플러그인 진입점 ----------

if (typeof figma !== 'undefined' && !figma.__mock) {
  figma.showUI(__html__, { width: 320, height: 220, title: '메뉴판 자동화' });
  figma.ui.postMessage({ version: PLUGIN_VERSION });
  figma.ui.onmessage = async (msg) => {
    if (!msg || !msg.id) return;
    currentId = msg.id;
    try {
      const result = await handle(msg);
      if (result.changed) figma.notify(result.message.split('\n')[0]);
      figma.ui.postMessage({ id: msg.id, ok: true, result });
    } catch (e) {
      figma.notify(String(e.message || e), { error: true });
      figma.ui.postMessage({ id: msg.id, ok: false, error: String(e.message || e) });
    }
  };
}

if (typeof module !== 'undefined') module.exports = { handle, norm };
