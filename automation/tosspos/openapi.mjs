#!/usr/bin/env node
// 토스플레이스 Open API — 조회 전용 (토스 공식 API는 카탈로그 변경 기능이 없다)
//   node automation/tosspos/openapi.mjs merchant            매장 정보 (연결 확인용)
//   node automation/tosspos/openapi.mjs menu [검색어]        카테고리별 상품 · 판매상태(판매중/품절) · 사용여부 · 가격
//   node automation/tosspos/openapi.mjs sales [일수=7] [검색어]  최근 N일 상품별 판매 수량 (와인 재고 계산용)
//   node automation/tosspos/openapi.mjs raw <경로>           응답 원문 확인 (예: /catalog/items?page=1&size=5)
// 인증 정보: .\automation\save-cred.ps1 tosspos  (Access Key / Secret / 가맹점 ID, DPAPI 암호화 저장)
// 문서: https://docs.tossplace.com/reference/open-api/catalog.html
import { loadCred } from '../lib/secrets.mjs';

const BASE = 'https://open-api.tossplace.com/api-public/openapi/v1';

function cred() {
  const c = loadCred('tosspos');
  if (!c || !c.accessKey || !c.secretKey || !c.merchantId) {
    throw new Error('토스플레이스 Open API 인증 정보가 없습니다. 개발자센터에서 Access Key/Secret 을 발급받은 뒤 `.\\automation\\save-cred.ps1 tosspos` 로 저장하세요.');
  }
  return c;
}

export async function api(path, c = cred()) {
  const url = `${BASE}/merchants/${encodeURIComponent(c.merchantId)}${path}`;
  const r = await fetch(url, { headers: { 'x-access-key': c.accessKey, 'x-secret-key': c.secretKey, 'content-type': 'application/json' } });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!r.ok) throw new Error(`토스 API ${r.status} ${path}: ${typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`);
  return body;
}

// 응답 래퍼 모양이 문서마다 달라서, 안쪽의 배열을 찾아 꺼낸다
function listOf(body) {
  if (Array.isArray(body)) return body;
  for (const k of ['content', 'items', 'list', 'data', 'result', 'success', 'orders', 'categories', 'options']) {
    const v = body && body[k];
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') { const inner = listOf(v); if (inner.length) return inner; }
  }
  return [];
}

async function all(path) {
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const rows = listOf(await api(`${path}${sep}page=${page}&size=100`));
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
}

const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
const won = (p) => (p && typeof p === 'object' ? p.priceValue ?? p.value ?? p.amount : p);

export async function menu() {
  const [cats, items] = await Promise.all([all('/catalog/categories'), all('/catalog/items')]);
  const catName = new Map(cats.map((c) => [String(c.id), c.title]));
  return items.map((i) => ({
    id: i.id,
    title: i.title,
    category: i.category?.title || catName.get(String(i.category?.id ?? i.categoryId)) || '(미분류)',
    soldOut: i.state === 'SOLD_OUT',
    enabled: i.enabled !== false,
    price: won(i.price),
  }));
}

// 최근 N일 상품별 판매 수량 — 주문 상세 모양을 몰라도 되도록 상품명/수량 필드를 넓게 찾는다
export async function sales(days = 7) {
  const to = Date.now(), from = to - days * 864e5;
  const orders = await all(`/order/orders?from=${from}&to=${to}&orderStates=COMPLETED`);
  const qty = new Map();
  for (const o of orders) {
    for (const li of o.lineItems || o.items || o.orderItems || o.lines || []) {
      const name = li.title || li.name || li.item?.title || li.catalogItem?.title || '(이름 없음)';
      const n = Number(li.quantity ?? li.count ?? li.qty ?? 1);
      qty.set(name, (qty.get(name) || 0) + n);
    }
  }
  return { orders: orders.length, from, to, qty: [...qty.entries()].sort((a, b) => b[1] - a[1]) };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'merchant') { console.log(JSON.stringify(await api(''), null, 2)); return; }
  if (cmd === 'raw') { console.log(JSON.stringify(await api(rest[0] || ''), null, 2).slice(0, 6000)); return; }
  if (cmd === 'menu') {
    const q = norm(rest.join(' '));
    const rows = (await menu()).filter((m) => !q || norm(m.title).includes(q) || norm(m.category).includes(q));
    const byCat = new Map();
    rows.forEach((m) => { if (!byCat.has(m.category)) byCat.set(m.category, []); byCat.get(m.category).push(m); });
    for (const [cat, list] of byCat) {
      console.log(`\n[${cat}] ${list.length}개`);
      list.forEach((m) => console.log(`  ${m.soldOut ? '🚫 품절' : '✅ 판매'}${m.enabled ? '' : ' · 사용안함'}  ${m.title}${m.price != null ? `  ${Number(m.price).toLocaleString()}원` : ''}`));
    }
    console.log(`\n총 ${rows.length}개`);
    return;
  }
  if (cmd === 'sales') {
    const days = Number(rest[0]) || 7;
    const q = norm(rest.slice(1).join(' '));
    const s = await sales(days);
    console.log(`최근 ${days}일 완료 주문 ${s.orders}건`);
    s.qty.filter(([n]) => !q || norm(n).includes(q)).forEach(([n, c]) => console.log(`  ${String(c).padStart(4)}  ${n}`));
    if (!s.qty.length && s.orders) console.log('  (주문에서 상품 목록을 찾지 못했습니다 — `raw /order/orders?size=1` 로 응답 모양을 확인하세요)');
    return;
  }
  console.log('사용법: node automation/tosspos/openapi.mjs merchant | menu [검색어] | sales [일수] [검색어] | raw <경로>');
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) main().catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
