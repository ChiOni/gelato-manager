// 스쿱 카카오 스킬서버 — Vercel Edge Function
// 라우팅: URL ?skill= 쿼리스트링
// 폴백: ?skill=handleUtterance → utterance 파싱 (버튼 클릭 포함)

export const config = { runtime: 'edge' };

const AS = 'https://script.google.com/macros/s/AKfycbxgye70JFDlNUPNtokT2N60hqcor5Pl5ZomQvCoPu203OSnfb6HyItrn-Pqt-BeAIwj/exec';

// ─── Upstash Redis 헬퍼 ──────────────────────────────────────────────────────

async function redisGet(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const { result } = await res.json();
  return result ? JSON.parse(result) : null;
}

async function redisSet(key, value) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;
  await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([['SET', key, JSON.stringify(value)]])
  });
}

async function redisDel(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;
  await fetch(`${url}/del/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
}

async function getData(key, asAction) {
  let data = await redisGet(key);
  if (!data) {
    const res = await fetch(`${AS}?action=${asAction}`, { redirect: 'follow' });
    const json = await res.json();
    data = json.data || [];
    await redisSet(key, data);
  }
  return data;
}

// ─── 사용자 인증 시스템 ──────────────────────────────────────────────────────

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'scoop2024';

async function getAllowedUsers() { return (await redisGet('allowed_users')) || {}; }
async function getPendingUsers()  { return (await redisGet('pending_users'))  || []; }

async function authCheck(userId) {
  const allowed = await getAllowedUsers();
  return allowed[userId] || null;
}

// 새 사용자 등록 흐름 (이름 입력 → 승인 대기)
async function handleNewUser(userId, utterance) {
  const u = utterance.trim();

  // 관리자 최초 등록: "관리자 [SECRET]"
  if (u.startsWith('관리자 ')) {
    const secret = u.slice(4).trim();
    if (secret === ADMIN_SECRET) {
      const allowed = await getAllowedUsers();
      const hasAdmin = Object.values(allowed).some(v => v.role === 'admin');
      if (hasAdmin) return simpleText('이미 관리자가 등록되어 있습니다.');
      allowed[userId] = { name: '치원', role: 'admin', approvedAt: new Date().toISOString() };
      await redisSet('allowed_users', allowed);
      return simpleText('✅ 관리자 등록 완료! 환영합니다 치원님.');
    }
    return simpleText('❌ 비밀번호가 틀렸습니다.');
  }

  // 이름 입력 대기 중인 사용자
  const regState = await redisGet(`reg_${userId}`);
  if (regState === '1') {
    if (!u || u.length > 20) return simpleText('이름을 다시 입력해주세요. (20자 이내)');
    const pending = await getPendingUsers();
    if (!pending.some(p => p.userId === userId)) {
      pending.push({ userId, name: u, requestedAt: new Date().toISOString() });
      await redisSet('pending_users', pending);
    }
    await redisDel(`reg_${userId}`);
    return simpleText(`✅ "${u}"으로 승인 요청 완료!\n관리자 승인 후 이용 가능합니다.`);
  }

  // 대기 중인 사용자
  const pending = await getPendingUsers();
  if (pending.some(p => p.userId === userId)) {
    return simpleText('⏳ 승인 대기 중입니다.\n관리자 승인 후 이용 가능합니다.');
  }

  // 완전히 새 사용자 — 이름 요청
  await redisSet(`reg_${userId}`, '1');
  return simpleText('👋 안녕하세요! 스쿱 봇입니다.\n\n이름을 입력해주세요.\n예: 홍길동');
}

// 관리자 전용 명령
async function handleAdminCommand(u) {
  if (u === '승인관리') {
    const pending = await getPendingUsers();
    if (!pending.length) return simpleText('✅ 승인 대기 중인 사용자가 없습니다.');
    const list = pending.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
    return {
      version: '2.0',
      template: {
        outputs: [{ simpleText: { text: `📋 승인 대기 목록\n${list}\n\n아래에서 선택하세요.` } }],
        quickReplies: [
          ...pending.map(p => ({ label: `✅ ${p.name}`, action: 'message', messageText: `승인 ${p.name}` })),
          ...pending.map(p => ({ label: `❌ ${p.name}`, action: 'message', messageText: `거절 ${p.name}` })),
        ]
      }
    };
  }

  if (u.startsWith('승인 ')) {
    const name = u.slice(3).trim();
    const pending = await getPendingUsers();
    const target = pending.find(p => p.name === name);
    if (!target) return simpleText(`"${name}"을 찾을 수 없습니다.`);
    const allowed = await getAllowedUsers();
    allowed[target.userId] = { name, role: 'user', approvedAt: new Date().toISOString() };
    await Promise.all([
      redisSet('allowed_users', allowed),
      redisSet('pending_users', pending.filter(p => p.userId !== target.userId))
    ]);
    return simpleText(`✅ "${name}" 승인 완료!`);
  }

  if (u.startsWith('거절 ')) {
    const name = u.slice(3).trim();
    const pending = await getPendingUsers();
    const filtered = pending.filter(p => p.name !== name);
    if (filtered.length === pending.length) return simpleText(`"${name}"을 찾을 수 없습니다.`);
    await redisSet('pending_users', filtered);
    return simpleText(`❌ "${name}" 거절 완료.`);
  }

  return null; // 관리자 명령 아님
}

function syncToSheet(params, ctx) {
  const url = `${AS}?${new URLSearchParams({ action: 'kakaoSkill', ...params })}`;
  ctx?.waitUntil?.(fetch(url, { redirect: 'follow' }).catch(() => {}));
}

// ─── Kakao 응답 헬퍼 ─────────────────────────────────────────────────────────

const QUICK = [
  { label: '🍦 레시피', action: 'message', messageText: '레시피 목록' },
  { label: '🍷 와인 목록', action: 'message', messageText: '와인 목록' }
];

function ok(data) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function simpleText(text) {
  return { version: '2.0', template: { outputs: [{ simpleText: { text } }], quickReplies: QUICK } };
}

// ─── 와인 핸들러 ─────────────────────────────────────────────────────────────

async function getWineList() {
  const wines = await getData('wines', 'getWines');
  if (!wines.length) return simpleText('등록된 와인이 없습니다.');

  const items = wines.slice(0, 5).map(w => ({
    title: String(w['이름']),
    description: `${w['가격']}원 · 재고 ${parseInt(w['재고']) || 0}병`
  }));

  return {
    version: '2.0',
    template: {
      outputs: [{ listCard: { header: { title: `🍷 와인 목록 (${wines.length}종)` }, items } }],
      quickReplies: wines.slice(0, 10).map(w => ({
        label: String(w['이름']), action: 'message', messageText: `${w['이름']} 상세`
      }))
    }
  };
}

async function getWineDetail(wineName) {
  const name = String(wineName).replace(/\s*상세$/, '').trim();
  const wines = await getData('wines', 'getWines');
  const wine = wines.find(w => String(w['이름']).trim() === name);
  if (!wine) return simpleText(`❓ "${name}" 와인을 찾을 수 없습니다.`);

  const stock = parseInt(wine['재고']) || 0;
  return {
    version: '2.0',
    template: {
      outputs: [{
        basicCard: {
          title: String(wine['이름']),
          description: `🍇 ${wine['특징']}\n\n💰 가격: ${wine['가격']}원\n📦 재고: ${stock > 0 ? stock + '병' : '❌ 품절'}`,
          buttons: [
            { label: '재고 추가 (+1)', action: 'message', messageText: `${wine['이름']} 재고 추가` },
            { label: '재고 감소 (-1)', action: 'message', messageText: `${wine['이름']} 재고 감소` }
          ]
        }
      }],
      quickReplies: QUICK
    }
  };
}

async function addWine(params, ctx) {
  if (!params.wine_name) return simpleText('❗ 와인 이름을 입력해주세요.');
  const wines = await getData('wines', 'getWines');
  wines.push({ 이름: params.wine_name, 특징: params.wine_feature || '', 가격: params.wine_price || '', 재고: parseInt(params.wine_stock) || 0 });
  await redisSet('wines', wines);
  syncToSheet({ skillAction: 'addWine', wine_name: params.wine_name, wine_feature: params.wine_feature || '', wine_price: params.wine_price || '', wine_stock: params.wine_stock || '0' }, ctx);
  return simpleText(`✅ "${params.wine_name}" 와인이 추가되었습니다.`);
}

async function updateWine(params, ctx) {
  if (!params.wine_name) return simpleText('❗ 와인 이름을 입력해주세요.');
  const wines = await getData('wines', 'getWines');
  const idx = wines.findIndex(w => String(w['이름']).trim() === String(params.wine_name).trim());
  if (idx < 0) return simpleText(`❌ "${params.wine_name}" 와인을 찾을 수 없습니다.`);
  if (params.wine_feature !== undefined) wines[idx]['특징'] = params.wine_feature;
  if (params.wine_price   !== undefined) wines[idx]['가격'] = params.wine_price;
  if (params.wine_stock   !== undefined) wines[idx]['재고'] = parseInt(params.wine_stock) || 0;
  await redisSet('wines', wines);
  syncToSheet({ skillAction: 'updateWine', ...params }, ctx);
  return simpleText(`✅ "${params.wine_name}" 와인 정보가 수정되었습니다.`);
}

async function updateWineStock(wineName, quantity, stockAction, ctx) {
  const wines = await getData('wines', 'getWines');
  const idx = wines.findIndex(w => String(w['이름']).trim() === String(wineName).trim());
  if (idx < 0) return simpleText(`❌ "${wineName}" 와인을 찾을 수 없습니다.`);

  const current = parseInt(wines[idx]['재고']) || 0;
  const qty = parseInt(quantity) || 1;
  const newStock = stockAction === 'add' ? current + qty : stockAction === 'sub' ? Math.max(0, current - qty) : qty;
  wines[idx]['재고'] = newStock;
  await redisSet('wines', wines);
  syncToSheet({ skillAction: 'updateWineStock', wine_name: wineName, quantity, stock_action: stockAction }, ctx);
  return simpleText(`✅ ${wineName} 재고 업데이트\n${current}병 → ${newStock}병`);
}

// ─── 레시피 핸들러 ──────────────────────────────────────────────────────────

async function getRecipeList() {
  const recipes = await getData('recipes_v2', 'getRecipesForKakao');
  if (!recipes.length) return simpleText('등록된 레시피가 없습니다.');
  return {
    version: '2.0',
    template: {
      outputs: [{ simpleText: { text: '🍦 어떤 메뉴의 레시피를 확인할까요?' } }],
      quickReplies: recipes.map(r => ({
        label: String(r['이름']), action: 'message', messageText: `${r['이름']} 레시피`
      }))
    }
  };
}

async function getRecipeDetail(menuName) {
  const name = String(menuName).replace(/\s*레시피$/, '').trim();
  if (!name) return simpleText('어떤 메뉴의 레시피를 확인할까요?');
  const recipes = await getData('recipes_v2', 'getRecipesForKakao');
  const r = recipes.find(recipe => String(recipe['이름']).trim() === name);
  if (!r) return simpleText(`❓ "${name}" 레시피를 찾을 수 없습니다.`);
  const ingredients = String(r['재료']).split(' · ').map(s => `• ${s}`).join('\n');
  return {
    version: '2.0',
    template: {
      outputs: [{
        basicCard: {
          title: `🍦 ${name} 레시피`,
          description: ingredients
        }
      }],
      quickReplies: [{ label: '다른 레시피', action: 'message', messageText: '레시피 목록' }, ...QUICK]
    }
  };
}

async function addRecipe(params, ctx) {
  if (!params.menu_name) return simpleText('❗ 레시피 이름을 입력해주세요.');
  const recipes = await getData('recipes_v2', 'getRecipesForKakao');
  recipes.push({ 이름: params.menu_name, 재료: params.ingredients || '', 특징: params.feature || '' });
  await redisSet('recipes_v2', recipes);
  syncToSheet({ skillAction: 'addRecipe', menu_name: params.menu_name, ingredients: params.ingredients || '', feature: params.feature || '' }, ctx);
  return simpleText(`✅ "${params.menu_name}" 레시피가 추가되었습니다.`);
}

// ─── 폴백 핸들러: utterance 파싱으로 라우팅 ─────────────────────────────────
// 모든 버튼(action:message)이 발화로 전달되면 여기서 처리

async function handleUtterance(utterance, ctx) {
  const u = String(utterance || '').trim();
  if (!u) return simpleText('❓ 알 수 없는 요청입니다.\n메뉴에서 선택해주세요!');

  // "XX 레시피" → 레시피 상세
  if (u.endsWith('레시피')) return getRecipeDetail(u);

  // "XX 상세" → 와인 상세
  if (u.endsWith('상세')) return getWineDetail(u);

  // "XX 재고 추가" → 재고 증가
  if (u.includes('재고 추가')) {
    const name = u.replace(/\s*재고\s*추가.*$/, '').trim();
    return updateWineStock(name, '1', 'add', ctx);
  }

  // "XX 재고 감소" → 재고 감소
  if (u.includes('재고 감소')) {
    const name = u.replace(/\s*재고\s*감소.*$/, '').trim();
    return updateWineStock(name, '1', 'sub', ctx);
  }

  return simpleText(`🤔 "${u}"를 이해하지 못했어요.\n아래 메뉴에서 선택해주세요.`);
}

// ─── CORS 헬퍼 (웹앱 → Vercel 브라우저 요청용) ──────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function corsJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS }
  });
}

// ─── 메인 핸들러 ─────────────────────────────────────────────────────────────

export default async function handler(req, ctx) {
  const { searchParams } = new URL(req.url);

  // OPTIONS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (req.method === 'GET') {
    if (searchParams.get('seed') === '1') {
      // 기존 캐시 삭제 후 최신 데이터로 재시드
      await Promise.all([redisDel('wines'), redisDel('recipes_v2')]);
      const [wines, recipes] = await Promise.all([
        getData('wines', 'getWines'),
        getData('recipes_v2', 'getRecipesForKakao')
      ]);
      return new Response(
        `✅ Redis 시드 완료\n와인 ${wines.length}개 · 레시피 ${recipes.length}개 캐시됨`,
        { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
      );
    }
    return new Response('스쿱 카카오 스킬서버 정상 작동 중 🍦🍷', { status: 200 });
  }
  if (req.method !== 'POST') return new Response(null, { status: 405 });

  let body;
  try { body = await req.json(); } catch { return ok(simpleText('요청 파싱 오류')); }

  // 웹앱에서 직접 캐시 업데이트 (CORS 포함)
  const skill = searchParams.get('skill');
  if (skill === 'syncRecipes') {
    const recipes = body?.recipes;
    if (Array.isArray(recipes)) {
      await redisSet('recipes_v2', recipes);
      return corsJson({ ok: true, count: recipes.length });
    }
    return corsJson({ ok: false }, 400);
  }
  if (skill === 'syncWines') {
    const wines = body?.wines;
    if (Array.isArray(wines)) {
      await redisSet('wines', wines);
      return corsJson({ ok: true, count: wines.length });
    }
    return corsJson({ ok: false }, 400);
  }

  const skillAction = skill || '';
  const params = body?.action?.params || {};
  const utterance = body?.userRequest?.utterance || '';
  const userId   = body?.userRequest?.user?.id   || '';

  // ── 인증 체크 ──────────────────────────────────────────────────────────────
  const userInfo = await authCheck(userId);
  if (!userInfo) {
    return ok(await handleNewUser(userId, utterance));
  }

  try {
    let result;

    // 관리자 전용 명령 우선 처리
    if (userInfo.role === 'admin') {
      const adminResult = await handleAdminCommand(utterance.trim());
      if (adminResult) return ok(adminResult);
    }

    switch (skillAction) {
      case 'getWineList':       result = await getWineList();                                                                         break;
      case 'getWineDetail':     result = await getWineDetail(params.wine_name || utterance);                                          break;
      case 'addWine':           result = await addWine(params, ctx);                                                                  break;
      case 'updateWine':        result = await updateWine(params, ctx);                                                               break;
      case 'updateWineStock':   result = await updateWineStock(params.wine_name || '', params.quantity || '1', params.stock_action || 'add', ctx); break;
      case 'getRecipeList':     result = await getRecipeList();                                                                       break;
      case 'getRecipeDetail':   result = await getRecipeDetail(params.menu_name || utterance);                                        break;
      case 'addRecipe':         result = await addRecipe(params, ctx);                                                                break;
      case 'handleUtterance':   result = await handleUtterance(utterance, ctx);                                                       break;
      default:                  result = simpleText('❓ 알 수 없는 요청입니다.\n메뉴에서 선택해주세요!');
    }

    // 관리자에게 승인 대기 알림 quickReply 추가
    if (userInfo.role === 'admin' && result?.template) {
      const pending = await getPendingUsers();
      if (pending.length) {
        result.template.quickReplies = result.template.quickReplies || [];
        result.template.quickReplies.push({
          label: `⚠️ 승인 대기 ${pending.length}명`,
          action: 'message',
          messageText: '승인관리'
        });
      }
    }

    return ok(result);
  } catch (err) {
    return ok(simpleText('오류: ' + (err.message || '알 수 없는 오류')));
  }
}
