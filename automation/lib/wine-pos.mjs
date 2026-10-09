// 토스 포스 작업 실행기 — tosspos/wine_bridge.py 를 불러 쓴다.
// 포스는 작업 중 창을 맨 앞으로 띄우므로 동시에 두 개를 돌리면 서로 깨진다 → 한 번에 하나만.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// WINE_BRIDGE: 테스트에서 포스 대신 가짜 응답 스크립트를 쓰는 용도 (평소에는 비워 둔다)
const SCRIPT = process.env.WINE_BRIDGE || path.resolve(here, '..', 'tosspos', 'wine_bridge.py');
const PYTHON = process.env.WINE_PYTHON || 'python';
const TIMEOUT = 6 * 60 * 1000; // 목록 전체 읽기가 느릴 때를 넉넉히 감안

function runPy(cmd, arg) {
  return new Promise((resolve, reject) => {
    execFile(PYTHON, [SCRIPT, cmd, JSON.stringify(arg || {})],
      // PYTHONIOENCODING: Windows 기본 인코딩(cp949)으로 내보내면 한글 와인 이름이 깨진다
      { timeout: TIMEOUT, maxBuffer: 8e6, windowsHide: true, encoding: 'utf8',
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
      (err, stdout, stderr) => {
        const se = String(stderr || '').trim();
        // 표준출력의 마지막 줄이 JSON 결과 (진행 로그는 표준오류로 나온다)
        const line = String(stdout || '').trim().split('\n').filter(Boolean).pop();
        let out = null;
        try { out = line ? JSON.parse(line) : null; } catch {}
        if (out?.ok) return resolve({ ...out, log: se });
        if (out?.error) return reject(new Error(out.error));
        if (err?.killed) return reject(new Error('포스가 응답하지 않아 작업을 멈췄어요. 포스 화면을 확인해 주세요.'));
        if (err?.code === 'ENOENT') return reject(new Error('python 을 찾을 수 없어요. Python 3.12 설치를 확인해 주세요.'));
        reject(new Error(se.split('\n').pop() || err?.message || '포스 작업에 실패했어요.'));
      });
  });
}

export const POS_LABEL = { sync: '포스에서 불러오기', expose: '포스 노출 변경', add: '포스에 상품 등록' };

// busy(): 젤라또 작업이 돌고 있으면 true — 포스가 창을 앞으로 띄우면 크롬 자동화가 깨지므로 기다린다
export function createPos({ busy = () => false, onChange = () => {}, log = () => {} } = {}) {
  const jobs = [];      // 최근 작업 (최신이 앞) — 화면 표시용, 메모리에만 둔다
  const queue = [];
  let running = null;

  function enqueue(spec) {
    const job = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      kind: spec.kind,
      label: spec.label || POS_LABEL[spec.kind] || spec.kind,
      name: spec.name || '',
      wineId: spec.wineId || null,
      auto: !!spec.auto,
      state: 'queued',
      message: '',
      createdAt: Date.now(), startedAt: null, finishedAt: null,
      _spec: spec,
    };
    jobs.unshift(job);
    jobs.length = Math.min(jobs.length, 20);
    queue.push(job);
    onChange();
    setImmediate(drain);
    return job;
  }

  async function drain() {
    if (running || !queue.length) return;
    if (busy()) { // 젤라또 작업이 끝날 때까지 대기
      const head = queue[0];
      if (head.message !== '젤라또 작업이 끝나면 시작해요') { head.message = '젤라또 작업이 끝나면 시작해요'; onChange(); }
      setTimeout(drain, 3000);
      return;
    }
    running = queue.shift();
    const spec = running._spec;
    running.state = 'running';
    running.message = spec.progress || '포스 화면을 확인하는 중…';
    running.startedAt = Date.now();
    onChange();
    try {
      const out = await runPy(spec.kind, spec.arg);
      if (spec.then) await spec.then(out, running);
      running.state = 'done';
      running.message = spec.okMessage ? spec.okMessage(out) : '완료';
    } catch (e) {
      running.state = 'failed';
      running.message = String(e.message || e);
      if (spec.onFail) { try { await spec.onFail(e, running); } catch {} }
    }
    running.finishedAt = Date.now();
    log(`와인/${running.kind} ${running.name} — ${running.state === 'done' ? '완료' : `실패: ${running.message}`}`);
    running = null;
    onChange();
    setImmediate(drain);
  }

  return {
    enqueue,
    retry(id) {
      const prev = jobs.find((j) => j.id === id);
      if (!prev) throw new Error('작업을 찾을 수 없습니다.');
      if (prev.state === 'queued' || prev.state === 'running') throw new Error('아직 진행 중인 작업이에요.');
      return enqueue(prev._spec);
    },
    isBusy: () => !!running || !!queue.length,
    runningWineId: () => running?.wineId || null,
    // 큐에 들어 있는 와인까지 포함 — 화면에서 버튼을 잠그는 데 쓴다
    pendingWineIds: () => [running, ...queue].filter(Boolean).map((j) => j.wineId).filter(Boolean),
    snapshot: () => ({
      jobs: jobs.map(({ _spec, ...j }) => j),
      running: running?.id || null,
      queued: queue.length,
    }),
  };
}
