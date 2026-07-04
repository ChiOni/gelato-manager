// 스쿱 카카오 스킬서버 — Vercel Edge Function
// Kakao POST 요청을 받아 Apps Script doGet으로 프록시
// Edge Runtime = 콜드스타트 없음

export const config = { runtime: 'edge' };

const AS = 'https://script.google.com/macros/s/AKfycbxgye70JFDlNUPNtokT2N60hqcor5Pl5ZomQvCoPu203OSnfb6HyItrn-Pqt-BeAIwj/exec';

function errorResponse(msg) {
  return new Response(
    JSON.stringify({
      version: '2.0',
      template: { outputs: [{ simpleText: { text: msg } }] }
    }),
    { headers: { 'Content-Type': 'application/json; charset=utf-8' } }
  );
}

export default async function handler(req) {
  if (req.method === 'GET') {
    return new Response('스쿱 카카오 스킬서버 정상 작동 중 🍦🍷', { status: 200 });
  }

  if (req.method !== 'POST') {
    return new Response(null, { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return errorResponse('요청 파싱 오류');
  }

  const skillAction = body?.action?.name || '';
  const params = body?.action?.params || {};

  if (!skillAction) {
    return errorResponse('❓ 알 수 없는 요청입니다.\n메뉴에서 선택해주세요!');
  }

  try {
    const qs = new URLSearchParams({ action: 'kakaoSkill', skillAction, ...params });
    const asRes = await fetch(`${AS}?${qs}`, { redirect: 'follow' });

    if (!asRes.ok) {
      return errorResponse('서버 오류 (' + asRes.status + ')');
    }

    const data = await asRes.json();
    return new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  } catch (err) {
    return errorResponse('오류: ' + (err.message || '알 수 없는 오류'));
  }
}
