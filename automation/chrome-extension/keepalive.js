// 쿠팡이츠 탭이 열려 있는 동안 서비스워커를 깨워 CLI 연결을 유지한다
function ping() { try { chrome.runtime.sendMessage({ ping: 1 }).catch(() => {}); } catch (e) {} }
ping();
setInterval(ping, 15000);
