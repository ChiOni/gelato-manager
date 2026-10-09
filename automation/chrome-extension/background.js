// 메뉴 자동화 브리지 — ws://127.0.0.1:3056 (menu CLI) ↔ 쿠팡이츠·배민 탭
// CLI → {id, op, args} / 확장 → {id, ok, result|error}
//   op: tab(url 패턴으로 탭 찾기/열기) · goto · page(페이지 안 동작) · capture(스크린샷)
//       release(작업 전 보던 탭으로 복귀) · info(버전)

importScripts('page-ops.js'); // pageOp()

const WS_URL = 'ws://127.0.0.1:3056';
let ws = null;
let connecting = false;

function connect() {
  if (connecting || (ws && ws.readyState <= 1)) return;
  connecting = true;
  try {
    ws = new WebSocket(WS_URL);
  } catch (e) { connecting = false; return; }
  ws.onopen = () => { connecting = false; ws.send(JSON.stringify({ hello: 'chrome-extension', version: chrome.runtime.getManifest().version })); };
  ws.onclose = () => { connecting = false; ws = null; };
  ws.onerror = () => { connecting = false; };
  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    if (!msg.id) return;
    try {
      const result = await handle(msg);
      ws.send(JSON.stringify({ id: msg.id, ok: true, result }));
    } catch (err) {
      ws.send(JSON.stringify({ id: msg.id, ok: false, error: String(err && err.message || err) }));
    }
  };
}

// 깨어 있는 동안 1초마다 연결 시도 (CLI가 떠 있을 때만 붙음)
setInterval(connect, 1000);
connect();
chrome.alarms.create('wake', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(connect);
chrome.runtime.onMessage.addListener(() => { connect(); });
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

// ---------- 탭 ----------

let tabId = null;
let prevTabId = null; // 작업 시작 전 사용자가 보던 탭 (작업 후 되돌린다)

// 페이지 '완전 로딩'(광고·추적 스크립트 포함)을 기다리되, 오래 걸려도 실패로 보지 않는다.
// 실제로 필요한 화면 요소는 이후 waitText 로 확인한다. (배민은 완전 로딩이 30초 넘게 걸리기도 함)
function waitComplete(id, timeout = 20000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { chrome.tabs.onUpdated.removeListener(fn); resolve(); }, timeout);
    function fn(tid, info) { if (tid === id && info.status === 'complete') { clearTimeout(t); chrome.tabs.onUpdated.removeListener(fn); resolve(); } }
    chrome.tabs.onUpdated.addListener(fn);
    chrome.tabs.get(id).then((tab) => { if (tab.status === 'complete') { clearTimeout(t); chrome.tabs.onUpdated.removeListener(fn); resolve(); } });
  });
}

async function handle({ op, args = {} }) {
  if (op === 'info') return { version: chrome.runtime.getManifest().version };
  if (op === 'release') {
    if (prevTabId != null) { const id = prevTabId; prevTabId = null; await chrome.tabs.update(id, { active: true }).catch(() => {}); }
    return { released: true };
  }
  if (op === 'tab') {
    if (prevTabId == null) {
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (active) prevTabId = active.id;
    }
    const tabs = await chrome.tabs.query({ url: args.match || 'https://store.coupangeats.com/*' });
    let tab = tabs[0];
    if (!tab) tab = await chrome.tabs.create({ url: args.url, active: true });
    else if (args.url && !tab.url.startsWith(args.url)) tab = await chrome.tabs.update(tab.id, { url: args.url, active: true });
    else await chrome.tabs.update(tab.id, { active: true });
    tabId = tab.id;
    if (prevTabId === tabId) prevTabId = null;
    await waitComplete(tabId);
    return { tabId, url: (await chrome.tabs.get(tabId)).url };
  }
  if (!tabId) throw new Error('먼저 tab 명령으로 쿠팡이츠 탭을 지정해야 합니다.');
  if (op === 'goto') {
    await chrome.tabs.update(tabId, { url: args.url });
    await new Promise((r) => setTimeout(r, 300));
    await waitComplete(tabId);
    return { url: (await chrome.tabs.get(tabId)).url };
  }
  if (op === 'capture') {
    const tab = await chrome.tabs.get(tabId);
    return { dataUrl: await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }) };
  }
  if (op === 'page') {
    // 클릭으로 페이지가 이동하면 주입 스크립트가 응답 없이 사라지므로, 이동 감지 시 바로 반환
    let onNav;
    const navigated = new Promise((resolve) => {
      onNav = (tid, info) => { if (tid === tabId && info.status === 'loading') resolve([{ result: { navigated: true } }]); };
      chrome.tabs.onUpdated.addListener(onNav);
    });
    try {
      const [res] = await Promise.race([chrome.scripting.executeScript({ target: { tabId }, func: pageOp, args: [args.action, args.params || {}] }), navigated]);
      if (res.result && res.result.__error) throw new Error(res.result.__error);
      return res.result;
    } finally {
      chrome.tabs.onUpdated.removeListener(onNav);
    }
  }
  throw new Error('알 수 없는 op: ' + op);
}
