// 로컬 WebSocket 브리지 — 피그마 플러그인(3055) / Chrome 확장(3056)이 여기에 접속한다.
// 요청: {id, op, cmd, args}  응답: {id, ok, result|error} · 진행: {id, progress} · 인사: {hello, version}
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';

export const FIGMA_PORT = 3055;
export const EXT_PORT = 3056;

export function startBridge({ port, name }) {
  // localhost 가 IPv4/IPv6 어느 쪽으로 풀려도 붙도록 두 주소 모두 연다 (외부 네트워크에는 열지 않음)
  const servers = ['127.0.0.1', '::1'].map((host) => new WebSocketServer({ port, host }));
  let client = null;
  let info = null; // 클라이언트가 보낸 hello
  const pending = new Map();
  const waiters = [];
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn(!!client));

  servers.forEach((s, i) => {
    s.on('error', (e) => {
      if (i === 1 && e.code === 'EADDRNOTAVAIL') return; // IPv6 미지원 PC
      console.error(e.code === 'EADDRINUSE' ? `[${name}] 포트 ${port}이 이미 사용 중입니다 (서버가 이미 실행 중인지 확인)` : e.message);
    });
    s.on('connection', (ws) => {
      if (client && client !== ws) client.terminate(); // 새 연결 우선
      client = ws;
      emit();
      waiters.splice(0).forEach((w) => w());
      ws.on('message', (raw) => {
        let m;
        try { m = JSON.parse(raw.toString()); } catch { return; }
        if (m.hello) { info = m; emit(); return; }
        const p = m.id && pending.get(m.id);
        if (!p) return;
        if (m.progress) { p.onProgress && p.onProgress(m.progress); p.touch(); return; }
        pending.delete(m.id);
        m.ok ? p.resolve(m.result) : p.reject(new Error(m.error));
      });
      ws.on('close', () => {
        if (client !== ws) return;
        client = null;
        info = null;
        pending.forEach((p) => p.reject(new Error(`${name} 연결이 끊겼습니다`)));
        pending.clear();
        emit();
      });
    });
  });

  // 확장 서비스워커가 잠들지 않도록 주기적으로 신호 (id 없는 메시지는 클라이언트가 무시)
  const keepalive = setInterval(() => { if (client) try { client.send(JSON.stringify({ ping: Date.now() })); } catch {} }, 20000);

  return {
    name,
    get connected() { return !!client; },
    get info() { return info; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async waitConnected(ms = 60000) {
      if (client) return;
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${name}이(가) 연결되지 않았습니다.`)), ms);
        waiters.push(() => { clearTimeout(t); resolve(); });
      });
    },
    // 응답 없이 ms 가 지나면 실패. 진행 보고가 오면 타이머를 다시 잰다.
    call(op, args = {}, { timeout = 60000, onProgress } = {}) {
      if (!client) return Promise.reject(new Error(`${name}이(가) 연결되어 있지 않습니다.`));
      const id = randomUUID();
      if (process.env.DEBUG_BRIDGE) console.log(`  → [${name}] ${op} ${JSON.stringify(args).replace(/"value":"[^"]*"/g, '"value":"***"').slice(0, 120)}`);
      return new Promise((resolve, reject) => {
        let t;
        const touch = () => { clearTimeout(t); t = setTimeout(() => { pending.delete(id); reject(new Error(`${name} 응답 시간 초과 (${op})`)); }, timeout); };
        touch();
        pending.set(id, { onProgress, touch, resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
        client.send(JSON.stringify({ id, op, cmd: op, args }));
      });
    },
    close() {
      clearInterval(keepalive);
      servers.forEach((s) => { s.clients.forEach((c) => c.terminate()); s.close(); });
    },
  };
}
