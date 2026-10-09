// 피그마 플러그인 로직 QA — 실제 메뉴판 노드 JSON(Figma REST)으로 Plugin API를 흉내 내서 시나리오 검증
//   node automation/test/figma-plugin.test.cjs <node.json 경로>
//   node.json: GET /v1/files/vqBJv4BQlR85xTdXSS22jH/nodes?ids=98:28 (또는 7-2) 응답
const assert = require('node:assert/strict');
const fs = require('node:fs');

// ---------- Plugin API mock ----------
let seq = 0;
const byId = new Map();
const loadedFonts = new Set();
const versions = [];
const fontKey = (f) => `${f.family}/${f.style}`;

function makeNode(type, props = {}) {
  const n = {
    id: props.id || `new-${++seq}`, type, name: props.name || type, visible: props.visible !== false, parent: null,
    fills: props.fills || [], layoutMode: props.layoutMode || 'NONE', layoutPositioning: props.layoutPositioning || 'AUTO',
    primaryAxisSizingMode: props.primaryAxisSizingMode || 'AUTO', clipsContent: !!props.clipsContent, _data: {},
    _box: { ...(props.absoluteBoundingBox || { x: 0, y: 0, width: 16, height: 16 }) },
  };
  Object.defineProperty(n, 'absoluteBoundingBox', { get() { return { ...n._box }; } });
  Object.defineProperty(n, 'absoluteTransform', { get() { return [[1, 0, n._box.x], [0, 1, n._box.y]]; } });
  Object.defineProperty(n, 'x', { set(v) { n._box.x = originOf(n).x + v; } });
  Object.defineProperty(n, 'y', { set(v) { n._box.y = originOf(n).y + v; } });
  Object.defineProperty(n, 'width', { get() { return n._box.width; } });
  n.setPluginData = (k, v) => { n._data[k] = v; };
  n.getPluginData = (k) => n._data[k] || '';
  n.remove = () => { detach(n); n.removed = true; };
  n.rescale = (s) => { n._box.width *= s; n._box.height *= s; };
  if (type === 'TEXT') {
    let chars = props.characters || '';
    let fontName = props.fontName || { family: 'Inter', style: 'Regular' };
    n.fontWeight = props.fontWeight; // 생성 노드는 undefined → fontName.style 로 판단
    Object.defineProperty(n, 'fontName', {
      get: () => fontName,
      set: (f) => { assert.ok(loadedFonts.has(fontKey(f)), `fontName 설정 전 폰트 미로드: ${fontKey(f)}`); fontName = f; n.fontWeight = /SemiBold|Bold/.test(f.style) ? 600 : 400; },
    });
    Object.defineProperty(n, 'characters', {
      get: () => chars,
      set: (v) => { assert.ok(loadedFonts.has(fontKey(fontName)), `characters 설정 전 폰트 미로드: ${fontKey(fontName)}`); chars = v; },
    });
    n.getRangeAllFontNames = () => [fontName];
    const overrides = props.characterStyleOverrides || [];
    const table = props.styleOverrideTable || {};
    n.getStyledTextSegments = (fields) => {
      assert.deepEqual(fields, ['fills']);
      const segs = [];
      [...chars].forEach((ch, i) => {
        const k = overrides[i] || 0;
        const fills = (table[k] && table[k].fills) || n.fills;
        const last = segs[segs.length - 1];
        if (last && last.k === k) { last.characters += ch; last.end++; } else segs.push({ k, characters: ch, start: i, end: i + 1, fills });
      });
      return segs;
    };
    n.setRangeFills = (s, e, fills) => { assert.ok(s >= 0 && e <= chars.length && s < e); n._fillRanges = (n._fillRanges || []).concat([[s, e, fills]]); };
    n.resize = (w, h) => { n._box.width = w; n._box.height = h; };
    Object.defineProperty(n, 'height', { get() { return n._box.height; } });
    n.setRangeFontSize = (s, e, size) => { assert.ok(s >= 0 && e <= chars.length && s < e); n._ranges = (n._ranges || []).concat([[s, e, size]]); };
  }
  if (['FRAME', 'GROUP', 'INSTANCE', 'COMPONENT', 'CANVAS'].includes(type)) {
    n.children = [];
    n.appendChild = (c) => { detach(c); c.parent = n; n.children.push(c); };
    n.insertChild = (i, c) => { detach(c); c.parent = n; n.children.splice(i, 0, c); };
    n.clone = () => { throw new Error('clone 사용 안 함'); };
  }
  byId.set(n.id, n);
  return n;
}
function originOf(n) { let p = n.parent; while (p && p.type === 'GROUP') p = p.parent; return p ? { x: p._box.x, y: p._box.y } : { x: 0, y: 0 }; }
function detach(c) { if (c.parent) c.parent.children = c.parent.children.filter((k) => k !== c); c.parent = null; }

function fromJson(j, parent) {
  const n = makeNode(j.type, {
    ...j, fontWeight: j.style && j.style.fontWeight,
    fontName: j.style && { family: j.style.fontFamily, style: j.style.fontWeight >= 600 ? 'SemiBold' : 'Regular' },
  });
  n.parent = parent;
  (j.children || []).forEach((c) => n.children.push(fromJson(c, n)));
  return n;
}

global.figma = {
  __mock: true,
  getNodeByIdAsync: async (id) => { const n = byId.get(id); return n && !n.removed ? n : null; },
  loadFontAsync: async (f) => { loadedFonts.add(fontKey(f)); },
  commitUndo: () => {},
  saveVersionHistoryAsync: async (title) => { versions.push(title); },
  createFrame: () => makeNode('FRAME', { fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }] }),
  createText: () => makeNode('TEXT'),
  createNodeFromSvg: () => { const f = makeNode('FRAME', { absoluteBoundingBox: { x: 0, y: 0, width: 17, height: 17 } }); f.appendChild(makeNode('VECTOR')); return f; },
  currentPage: { loadAsync: async () => {}, findOne: () => null },
};

const { handle } = require('../figma-plugin/code.js');

// ---------- 규격 검사 ----------
function assertCanonical(item) {
  const where = `'${item.name}'`;
  assert.equal(item.type, 'FRAME', where);
  assert.equal(item.layoutMode, 'VERTICAL', where);
  assert.equal(item.itemSpacing, 4, where);
  assert.deepEqual(item.fills, [], where);
  assert.equal(item.children.length, 2, `${where} 자식은 title + desc`);
  const [title, desc] = item.children;
  assert.equal(title.layoutMode, 'HORIZONTAL', where);
  assert.equal(title.itemSpacing, 6, where);
  const name = title.children[0];
  for (const [t, size, style] of [[name, 18, 'SemiBold'], [desc, 15, 'Regular']]) {
    assert.equal(t.type, 'TEXT', where);
    assert.equal(t.fontSize, size, `${where} ${t.name} size`);
    assert.equal(t.fontName.style, style, where);
    assert.deepEqual(t.lineHeight, { unit: 'AUTO' }, where);
    assert.deepEqual(t.letterSpacing, { unit: 'PERCENT', value: -3 }, where);
    assert.equal(t.textAutoResize, 'WIDTH_AND_HEIGHT', where);
    assert.equal(t.characters, t.characters.replace(/\s+/g, ' ').trim(), `${where} 공백 정리`);
  }
  title.children.slice(1).forEach((b) => assert.ok(b.name.startsWith('badge/'), `${where} 뱃지 레이어`));
}

(async () => {
  const src = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const doc = Object.values(src.nodes)[0].document;
  fromJson(doc, null);
  const names = (snap, key) => snap[key].map((i) => i.name);
  const run = async (cmd, args = {}) => handle({ id: 't', cmd, args });

  // 0) 조회 + 기본 정리
  let r = await run('snapshot');
  const before = r.snapshot;
  assert.deepEqual(names(before, 'live'), ['코코망고', '구운 아몬드', '발로나 초코', '피스타치오', '스트라치아텔라', '시나몬 크림치즈', '밀크티', '바나나 소르베']);
  assert.deepEqual([before.soldout.length, before.seasonoff.length, before.later.length], [4, 5, 19]);
  assert.deepEqual(before.live.find((i) => i.name === '바나나 소르베').badges, ['NEW']);
  assert.deepEqual(before.live.find((i) => i.name === '구운 아몬드').badges, ['best'], '숨김 best 뱃지 무시');
  assert.deepEqual((await run('snapshot')).fixes, [], '기본 정리는 멱등');

  // 1) tidy: 규격화
  r = await run('tidy');
  console.log(r.message);
  assert.equal(r.changed, true);
  assert.equal(versions.length, 1, '정리 전 버전 백업');
  const after = r.snapshot;
  for (const key of ['live', 'soldout', 'seasonoff', 'later']) {
    assert.deepEqual(names(after, key), names(before, key).map((s) => s.replace(/\s+/g, ' ').trim()), `${key} 순서/이름 보존`);
    after[key].forEach((it, i) => {
      assert.equal(it.desc, before[key][i].desc.replace(/\s+/g, ' ').trim(), `${it.name} 설명 보존`);
      assert.deepEqual(it.badges, before[key][i].badges, `${it.name} 뱃지 보존`);
    });
  }
  const sections = ['1092:18', '1168:12', '1169:49', '1169:115'].map((id) => byId.get(id));
  for (const s of sections) {
    assert.equal(s.itemSpacing, 20);
    assert.equal(s.primaryAxisSizingMode, 'AUTO');
    s.children.filter((c) => c.type !== 'TEXT').forEach(assertCanonical);
    const h = s.children[0];
    if (h.type === 'TEXT') {
      assert.equal(h.fontSize, 22);
      if (h.characters.includes('- ')) assert.equal(h._ranges.at(-1)[2], 15, '부제 15px');
    }
  }
  assert.equal(sections[0].children.length, 8, '판매중: 떠 있던 뱃지 등 잔여물 없음');

  // 우측 판매 메뉴 & 가격
  const board = byId.get('98:28');
  const area = board.children.find((c) => c.name === '[Menu]');
  assert.ok(area, '[Menu] 프레임 생성');
  assert.deepEqual([area._box.x - board._box.x, area._box.y - board._box.y], [745, 225], '위치: 판매중 목록과 같은 높이, x=745');
  for (const id of ['98:89', '98:92', '896:18', '896:21', '98:96', '98:95', '98:98', '1567:21', '1567:16', '1567:19', '1621:36', '1621:46'])
    assert.ok(!board.children.some((c) => c.id === id), `원본 노드 ${id} 제거`);
  const [basicB, specialB, instaB] = area.children;
  assert.deepEqual(area.children.map((b) => b.name), ['기본 메뉴', 'Special Menu', 'Instagram Event']);
  assert.equal(area.itemSpacing, 56);
  assert.equal(basicB.itemSpacing, 40);
  const prod = (f) => ({ name: f.children[0].children[0].characters, price: f.children[0].children[1].characters, desc: f.children[1].characters });
  assert.deepEqual(basicB.children.map(prod), [
    { name: '젤라또 작은컵', price: '120g / 4,500원', desc: '계절을 담은 젤라또\n두 가지 맛으로 담아드려요' },
    { name: '젤라또 큰컵', price: '180g / 7,000원', desc: '더 푸짐하게\n세 가지 맛으로 담아드려요' },
    { name: '젤라또 박스', price: '500g / 18,000원', desc: '함께 나누고 싶은 순간\n세 가지 맛을 박스에 담아드려요' },
  ]);
  const red = (t) => (t._fillRanges || []).map(([s, e]) => t.characters.slice(s, e));
  assert.deepEqual(basicB.children.map((f) => red(f.children[1])), [['두 가지 맛'], ['세 가지 맛'], ['세 가지 맛']], '강조 구간 보존');
  basicB.children.forEach((f) => {
    const [n, pr] = f.children[0].children;
    assert.equal(n._box.width, 148, '상품명 고정폭 → 가격 세로줄 정렬');
    assert.deepEqual([n.fontSize, n.fontName.style, pr.fontSize, pr.fontName.style, f.children[1].fontSize], [22, 'SemiBold', 16, 'Medium', 14]);
    assert.equal(f.itemSpacing, 12);
  });
  assert.equal(specialB.children[0].characters, 'Special Menu');
  assert.deepEqual(prod(specialB.children[1]), { name: '젤라또&위스키', price: '120g+15ml / 8,900원', desc: '젤라또 한 가지 맛에 버번 위스키를 뿌려먹어요\n말돈소금우유 추천' });
  assert.deepEqual(red(specialB.children[1].children[1]), ['한 가지 맛']);
  assert.equal(instaB.children[0].characters, '★ Instagram Event - @scoopn_sip');
  assert.equal(instaB.children[0]._ranges, undefined, '인스타 제목에는 부제 규칙 미적용');
  assert.equal(instaB.children[1].characters, '스쿱앤십 인스타를 팔로우하시면,\n서비스 스푼을 올려 드려요');
  assert.deepEqual(red(instaB.children[1]), ['서비스 스푼']);

  // tidy 두 번째 → 변화 없음, 버전 백업은 남기되 재생성 없음
  r = await run('tidy');
  assert.equal(r.changed, false);
  assert.equal(r.message, '이미 깔끔한 상태입니다.');

  // 2) 신규 추가 → 규격 아이템, --new 뱃지
  r = await run('add', { name: ' 흑임자  크림 ', desc: '고소한 흑임자에 크림을 더한 ', badges: ['NEW'] });
  assert.equal(names(r.snapshot, 'live').at(-1), '흑임자 크림');
  assert.deepEqual(r.snapshot.live.at(-1).badges, ['NEW']);
  assertCanonical(sections[0].children.at(-1));
  assert.equal((await run('add', { name: '흑임자크림', desc: 'x' })).changed, false, '중복 추가 방지');
  await assert.rejects(run('add', { name: '오레오', desc: 'x' }), /restore/);

  // 3) 재활성화
  r = await run('move', { name: '딸기소르베', to: 'live' });
  assert.ok(names(r.snapshot, 'live').includes('딸기 소르베'));
  r = await run('move', { name: '말차 오레오', to: 'live' });
  assert.equal(r.snapshot.later.length, 18);

  // 4) 비활성화: NEW·best 모두 제거, 규격 유지
  r = await run('move', { name: '흑임자 크림', to: 'soldout' });
  assert.deepEqual(r.snapshot.soldout.at(-1).badges, []);
  assertCanonical(sections[1].children.at(-1));
  r = await run('move', { name: '발로나 초코', to: 'soldout' });
  assert.deepEqual(r.snapshot.soldout.at(-1).badges, [], 'best 도 제거');
  assert.equal((await run('move', { name: '발로나 초코', to: 'soldout' })).changed, false);
  // 계절 한정 같은 비토글 뱃지는 유지
  r = await run('move', { name: '자두 소르베', to: 'live' });
  assert.deepEqual(r.snapshot.live.at(-1).badges, ['계절 한정'], '활성화 기본: NEW·best OFF, 계절 한정 유지');

  // 5) 재활성화 기본 OFF / 선택 ON
  r = await run('move', { name: '발로나 초코', to: 'live' });
  assert.deepEqual(r.snapshot.live.at(-1).badges, [], '활성화 기본은 NEW·best 모두 OFF');
  r = await run('move', { name: '흑임자 크림', to: 'live', badges: ['NEW', 'best'] });
  assert.deepEqual(r.snapshot.live.at(-1).badges, ['NEW', 'best'], '활성화 시 선택 ON');
  assertCanonical(sections[0].children.at(-1));
  assert.match(r.message, /NEW, best 표시/);

  // 6) NEW / BEST 토글
  r = await run('setBadge', { name: '발로나 초코', badge: 'best', on: true });
  assert.equal(r.changed, true);
  assert.deepEqual(r.snapshot.live.find((i) => i.name === '발로나 초코').badges, ['best']);
  r = await run('setBadge', { name: '발로나초코', badge: 'new', on: true });
  assert.deepEqual(r.snapshot.live.find((i) => i.name === '발로나 초코').badges, ['NEW', 'best'], 'NEW 가 best 앞');
  assert.equal((await run('setBadge', { name: '발로나 초코', badge: 'new', on: true })).changed, false, '이미 ON');
  r = await run('setBadge', { name: '발로나 초코', badge: 'best', on: false });
  assert.deepEqual(r.snapshot.live.find((i) => i.name === '발로나 초코').badges, ['NEW']);
  const idx = r.snapshot.live.findIndex((i) => i.name === '발로나 초코');
  r = await run('setBadge', { name: '발로나 초코', badge: 'new', on: false });
  assert.equal(r.snapshot.live.findIndex((i) => i.name === '발로나 초코'), idx, '토글해도 순서 유지');
  assert.equal(r.snapshot.live[idx].desc, '찐-하고 쫀득한 생초콜릿', '설명 유지');
  r = await run('setBadge', { name: '자두 소르베', badge: 'best', on: true });
  assert.deepEqual(r.snapshot.live.find((i) => i.name === '자두 소르베').badges, ['best', '계절 한정']);
  await assert.rejects(run('setBadge', { name: '오레오', badge: 'new', on: true }), /판매중 메뉴가 아니라/);
  await assert.rejects(run('setBadge', { name: '발로나 초코', badge: 'hot', on: true }), /알 수 없는 뱃지/);
  sections.forEach((s) => s.children.filter((c) => c.type !== 'TEXT').forEach(assertCanonical));

  // 7) 배달만 OFF — 메뉴판(판매중)엔 그대로, 기록만 남김
  const liveBefore = names((await run('snapshot')).snapshot, 'live');
  r = await run('setDelivery', { name: '피스타치오', off: true });
  assert.equal(r.changed, true);
  assert.deepEqual(names(r.snapshot, 'live'), liveBefore, '판매중 목록/순서 그대로');
  assert.equal(r.snapshot.live.find((i) => i.name === '피스타치오').deliveryOff, true);
  assert.equal(r.snapshot.live.find((i) => i.name === '구운 아몬드').deliveryOff, false);
  assert.equal((await run('setDelivery', { name: '피스타치오', off: true })).changed, false, '이미 OFF');
  // 뱃지를 바꿔(아이템 재생성) 도 배달 OFF 기록 유지
  r = await run('setBadge', { name: '피스타치오', badge: 'best', on: true });
  assert.equal(r.snapshot.live.find((i) => i.name === '피스타치오').deliveryOff, true, '재생성 후에도 유지');
  // 다시 ON
  r = await run('setDelivery', { name: '피스타치오', off: false });
  assert.equal(r.snapshot.live.find((i) => i.name === '피스타치오').deliveryOff, false);
  // 비활성화 → 활성화 하면 배달 OFF 기록은 해제
  await run('setDelivery', { name: '피스타치오', off: true });
  await run('move', { name: '피스타치오', to: 'soldout' });
  r = await run('move', { name: '피스타치오', to: 'live' });
  assert.equal(r.snapshot.live.find((i) => i.name === '피스타치오').deliveryOff, false, '활성화하면 배달도 ON');
  await assert.rejects(run('setDelivery', { name: '오레오', off: true }), /판매중 메뉴가 아닙니다/);
  assert.equal((await run('tidy')).changed, false, '배달 OFF 기록이 규격을 깨지 않음');

  await assert.rejects(run('move', { name: '없는맛', to: 'live' }), /찾을 수 없습니다/);
  await assert.rejects(run('move', { name: '소르베', to: 'live' }), /여러 개/);

  // 설명 수정
  r = await run('setDesc', { name: '구운아몬드', desc: '  새 설명  입니다 ' });
  assert.equal(r.changed, true);
  assert.equal(r.snapshot.live.find((i) => i.name === '구운 아몬드').desc, '새 설명 입니다');
  assert.equal((await run('setDesc', { name: '구운 아몬드', desc: '새 설명 입니다' })).changed, false);
  await assert.rejects(run('setDesc', { name: '구운 아몬드', desc: '   ' }), /설명을 입력/);

  // tidy 는 이동 후에도 변화 없음 (모두 규격 유지)
  assert.equal((await run('tidy')).changed, false);

  console.log('\n✅ 피그마 플러그인 시나리오 테스트 통과 (tidy 규격 36개 아이템 검사 포함)');
})().catch((e) => { console.error('❌', e); process.exit(1); });
