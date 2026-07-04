// 스쿱 카카오 스킬서버 — Vercel Edge Function
// 아키텍처: Kakao POST → Edge Function → Upstash Redis (캐시, ~10ms)
//                                       → Apps Script GET (캐시 miss 시만, ~4s)

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

// Redis 캐시 먼저, 없으면 Apps Script에서 로드 후 캐시에 저장
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

// 쓰기 작업: Redis 즉시 업데이트 + Apps Script 백그라운드 동기화
function syncToSheet(params, ctx) {
  const url = `${AS}?${new URLSearchParams({ action: 'kakaoSkill', ...params })}`;
  ctx?.waitUntil?.(fetch(url, { redirect: 'follow' }).catch(() => {}));
}

// ─── Kakao 응답 헬퍼 ─────────────────────────────────────────────────────────

const QUICK = [
  { label: '🍦 레시피', action: 'block', messageText: '레시피 목록' },
  { label: '🍷 와인 목록', action: 'block', messageText: '와인 목록' }
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
        label: String(w['이름']), action: 'block', messageText: `${w['이름']} 상세`
      }))
    }
  };
}

async function getWineDetail(wineName) {
  const wines = await getData('wines', 'getWines');
  const wine = wines.find(w => String(w['이름']).trim() === String(wineName).trim());
  if (!wine) return simpleText(`❓ "${wineName}" 와인을 찾을 수 없습니다.`);

  const stock = parseInt(wine['재고']) || 0;
  return {
    version: '2.0',
    template: {
      outputs: [{
        basicCard: {
          title: String(wine['이름']),
          description: `🍇 ${wine['특징']}\n\n💰 가격: ${wine['가격']}원\n📦 재고: ${stock > 0 ? stock + '병' : '❌ 품절'}`,
          buttons: [
            { label: '재고 추가 (+1)', action: 'block', messageText: `${wine['이름']} 재고 추가` },
            { label: '재고 감소 (-1)', action: 'block', messageText: `${wine['이름']} 재고 감소` }
          ]
        }
      }]
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
  const recipes = await getData('recipes', 'getRecipes');
  if (!recipes.length) return simpleText('등록된 레시피가 없습니다.');
  return {
    version: '2.0',
    template: {
      outputs: [{ simpleText: { text: '🍦 어떤 메뉴의 레시피를 확인할까요?' } }],
      quickReplies: recipes.map(r => ({
        label: String(r['이름']), action: 'block', messageText: `${r['이름']} 레시피`
      }))
    }
  };
}

async function getRecipeDetail(menuName) {
  const name = menuName.replace(' 레시피', '').trim();
  const recipes = await getData('recipes', 'getRecipes');
  const r = recipes.find(recipe => String(recipe['이름']).trim() === name);
  if (!r) return simpleText(`❓ "${name}" 레시피를 찾을 수 없습니다.`);
  return {
    version: '2.0',
    template: {
      outputs: [{
        basicCard: {
          title: `🍦 ${name} 레시피 (1.5L 배치)`,
          description: `${r['재료']}\n\n${r['특징']}`
        }
      }],
      quickReplies: [{ label: '다른 레시피', action: 'block', messageText: '레시피 목록' }, ...QUICK]
    }
  };
}

async function addRecipe(params, ctx) {
  if (!params.menu_name) return simpleText('❗ 레시피 이름을 입력해주세요.');
  const recipes = await getData('recipes', 'getRecipes');
  recipes.push({ 이름: params.menu_name, 재료: params.ingredients || '', 특징: params.feature || '' });
  await redisSet('recipes', recipes);
  syncToSheet({ skillAction: 'addRecipe', menu_name: params.menu_name, ingredients: params.ingredients || '', feature: params.feature || '' }, ctx);
  return simpleText(`✅ "${params.menu_name}" 레시피가 추가되었습니다.`);
}

// ─── 메인 핸들러 ─────────────────────────────────────────────────────────────

export default async function handler(req, ctx) {
  const { searchParams } = new URL(req.url);

  if (req.method === 'GET') {
    if (searchParams.get('seed') === '1') {
      const [wines, recipes] = await Promise.all([
        getData('wines', 'getWines'),
        getData('recipes', 'getRecipes')
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

  // action.name은 Kakao 내부 ID라 사용 불가 → URL ?skill= 쿼리스트링으로 라우팅
  const skillAction = searchParams.get('skill') || '';
  const params = body?.action?.params || {};

  try {
    let result;
    switch (skillAction) {
      case 'getWineList':     result = await getWineList();                                                             break;
      case 'getWineDetail':   result = await getWineDetail(params.wine_name || '');                                    break;
      case 'addWine':         result = await addWine(params, ctx);                                                     break;
      case 'updateWine':      result = await updateWine(params, ctx);                                                  break;
      case 'updateWineStock': result = await updateWineStock(params.wine_name || '', params.quantity || '1', params.stock_action || 'add', ctx); break;
      case 'getRecipeList':   result = await getRecipeList();                                                          break;
      case 'getRecipeDetail': result = await getRecipeDetail(params.menu_name || '');                                  break;
      case 'addRecipe':       result = await addRecipe(params, ctx);                                                   break;
      default:                result = simpleText('❓ 알 수 없는 요청입니다.\n메뉴에서 선택해주세요!');
    }
    return ok(result);
  } catch (err) {
    return ok(simpleText('오류: ' + (err.message || '알 수 없는 오류')));
  }
}
