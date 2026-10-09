// 피그마 지킴이 — 플러그인이 멈춰 있을 때 작업을 바로 실패시키지 않고 기다린다.
//
// 메뉴판을 고칠 수 있는 주체는 데스크톱 앱 안에서 돌아가는 "메뉴판 자동화" 플러그인뿐이다.
// (피그마 REST API로는 노드 텍스트/레이어를 수정할 수 없고, 로컬 개발 플러그인은
//  데스크톱 앱에서만 실행된다.) 그래서 플러그인이 꺼져 있으면 서버가 할 수 있는 일이 없다.
//
// 측정해 보면 피그마 창이 최소화돼 있어도 읽기·쓰기는 모두 몇 초 안에 끝난다 —
// 백그라운드 스로틀링 문제는 없다. 실제로 막히는 경우는 하나뿐이다: 플러그인 창이 닫혀 있을 때.
// 그때 예전에는 "연결되어 있지 않습니다"로 즉시 실패해서, 피그마를 켜고 처음부터 다시 눌러야 했다.
// 이제는 작업이 큐에서 기다리다가, 플러그인이 켜지는 즉시 이어서 처리된다.
//
// 자동으로 창을 띄우거나 키를 넣지는 않는다. 이 PC는 토스 POS 가 전체화면으로 떠 있는
// 매장 단말이라, 영업 중에 화면을 가로채는 쪽이 더 위험하다.
// (피그마는 디버깅 포트도 막아 둬서 — Electron 43 — 화면을 건드리지 않는 조작 통로가 없다.)
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 어디까지 자동으로 할지
//   wait   (기본) 기다리기만 한다. 멈춘 순간의 상태는 로그에 남긴다.
//   launch 피그마가 아예 꺼져 있을 때만 실행한다. (켜져 있으면 건드리지 않음)
// 바꾸려면 서버 실행 전에:  $env:MENU_FIGMA_AUTOFIX = 'launch'
export const AUTOFIX = ['wait', 'launch'].includes(String(process.env.MENU_FIGMA_AUTOFIX || '').toLowerCase())
  ? String(process.env.MENU_FIGMA_AUTOFIX).toLowerCase()
  : 'wait';

// ---------- PowerShell 도우미 ----------

function ps(script, args = [], { capture = false } = {}) {
  const argv = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, script), ...args];
  return new Promise((resolve) => {
    const p = spawn('powershell.exe', argv, { windowsHide: true, stdio: capture ? ['ignore', 'pipe', 'ignore'] : 'ignore' });
    let out = '';
    if (capture) p.stdout.on('data', (d) => { out += d; });
    p.on('exit', (code) => resolve({ code, out: out.trim() }));
    p.on('error', (e) => resolve({ code: -1, out: e.message }));
  });
}

function figmaProcessAlive() {
  return new Promise((resolve) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-Command', 'if (Get-Process Figma -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }'], { windowsHide: true, stdio: 'ignore' });
    p.on('exit', (code) => resolve(code === 0));
    p.on('error', () => resolve(false));
  });
}

// 창 상태(최소화/보임/포커스/응답) — 멈춤이 재현되지 않을 때를 위한 기록
export async function diagnose() {
  const r = await ps('figma-state.ps1', [], { capture: true });
  try { return JSON.parse(r.out); } catch { return { error: r.out.slice(0, 200) || `exit ${r.code}` }; }
}

// ---------- 지킴이 ----------

// bridge: 피그마 WS 브리지 / probe(): 플러그인이 실제로 응답하는지 확인 (snapshot)
// onNote(text): 상태 표시용 한 줄 (UI 로 흘려보낸다)
export function createKeeper({ bridge, probe, log = () => {}, onNote = () => {} }) {
  let busy = null;        // 진행 중인 ensure — 동시 호출은 같은 약속을 기다린다
  let lastLaunch = 0;     // 앱 실행은 2분에 한 번까지
  const note = (t) => { onNote(t); log(`지킴이: ${t}`); };

  // 플러그인이 "지금 명령을 처리할 수 있는지" 확인.
  // 연결만으로는 부족하다 — 멈춰 있어도 WS 는 붙어 있을 수 있다. 그래서 실제로 한 번 물어본다.
  async function responsive(ms = 8000) {
    if (!bridge.connected) return false;
    if (!probe) return true;
    let timer;
    try {
      await Promise.race([probe(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('probe timeout')), ms); })]);
      return true;
    } catch { return false; } finally { clearTimeout(timer); }
  }

  async function waitReady(ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await responsive(Math.min(8000, Math.max(2000, until - Date.now())))) return true;
      await sleep(1500);
    }
    return false;
  }

  async function run(onProgress = () => {}) {
    const say = (t) => { onProgress(t); note(t); };
    if (await responsive()) return true;

    // 멈춘 순간의 상태를 남긴다 (최소화였는지, 창이 응답했는지)
    diagnose().then((d) => log(`지킴이 진단: ${JSON.stringify(d)}`)).catch(() => {});

    // 앱 자체가 꺼져 있으면 실행 (설정했을 때만). 피그마가 열려 있던 탭을 복원한다.
    if (AUTOFIX === 'launch' && !(await figmaProcessAlive()) && Date.now() - lastLaunch > 120000) {
      lastLaunch = Date.now();
      say('피그마가 꺼져 있어 실행합니다');
      await ps('figma-start.ps1', ['-Quiet']);
      if (await waitReady(60000)) return true;
    }

    // 플러그인이 켜질 때까지 기다린다 — 작업은 큐에 남아 있다가 이어서 처리된다
    say('피그마 플러그인을 기다리는 중… (피그마에서 Ctrl+K → "메뉴판 자동화")');
    return await waitReady(bridge.connected ? 60000 : 180000);
  }

  return {
    // 작업 직전에 호출 — 준비되면 true. 동시 호출은 하나로 합친다.
    async ensure(onProgress) {
      if (busy) return busy;
      busy = run(onProgress).finally(() => { busy = null; });
      return busy;
    },
    // 주기 점검 — 응답이 없으면 기록만 남긴다 (화면은 건드리지 않는다)
    async healQuietly() {
      if (busy || !bridge.connected) return false;
      if (await responsive(6000)) return false;
      log(`지킴이: 플러그인이 응답하지 않습니다. ${JSON.stringify(await diagnose())}`);
      return false;
    },
    get working() { return !!busy; },
    responsive,
    diagnose,
  };
}
