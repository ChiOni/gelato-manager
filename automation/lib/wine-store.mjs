// 와인 메모 — automation/data/wines.json
//
// 목록의 주인은 포스다. 어떤 와인이 있고 판매중인지(고객용 채널 노출)는 전부 포스가 정한다.
// 이 파일은 포스가 담을 칸이 없는 값(개봉 여부·미개봉 재고·바틀 가격·사진·설명)만
// 포스 상품에 붙여 둔다. 사용자가 따로 등록하는 절차는 없다 — 불러올 때 자동으로 생기고 사라진다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// WINE_DATA_DIR: 테스트에서 실제 파일을 건드리지 않도록 하는 용도 (평소에는 비워 둔다)
export const DATA_DIR = process.env.WINE_DATA_DIR || path.resolve(here, '..', 'data');
export const IMAGE_DIR = path.join(DATA_DIR, 'wine-images');
const FILE = path.join(DATA_DIR, 'wines.json');

export const KINDS = ['화이트', '레드', '스파클링', '오렌지', '내추럴', '로제', '무알콜', '기타'];

const EMPTY = { version: 2, wines: [], orphans: {}, posSeenAt: null, posExcluded: [] };
let db = null;

export function load() {
  if (db) return db;
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    db = { ...EMPTY, ...raw };
    if (raw.version !== 2) { db.wines = []; db.version = 2; } // 예전 형식은 포스에서 다시 불러온다
    db.orphans = db.orphans || {};
  } catch {
    db = { ...EMPTY, wines: [], orphans: {} };
  }
  return db;
}

export function save() {
  const d = load();
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, FILE); // 원자적 교체 — 쓰는 중에 서버가 죽어도 파일이 깨지지 않는다
  return d;
}

export const wines = () => load().wines;
export const byId = (id) => wines().find((w) => w.id === id);
export const newId = () => `w_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
export const normName = (s) => String(s || '').replace(/[\s\-–·,()（）]/g, '');

const num = (v, d = 0) => {
  const n = Number(String(v ?? '').replace(/[^\d]/g, ''));
  return Number.isFinite(n) ? n : d;
};
const str = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

// 화면에 보일 이름 — 포스 이름은 OCR 결과라 오타가 섞인다('가비'→'가리').
// 사용자가 보기 좋은 이름을 적어두면 그걸 쓰고, 안 적었으면 포스 이름을 그대로 쓴다.
export const label = (w) => w.name || w.posName;

// 포스 상품 하나에 대응하는 기록을 만든다 (불러올 때 자동 호출 — 사용자가 등록하지 않는다)
export function create({ posName, posPrice, expose }) {
  return {
    id: newId(),
    posName: str(posName, 60),   // 포스 매칭에 쓰는 이름 (바꾸지 않는다)
    posPrice: num(posPrice),     // 포스 기본가격 = 글라스 가격
    posExpose: !!expose,
    posOcrName: str(posName, 60),
    posSyncAt: Date.now(),
    posState: 'ok',
    posNote: '',
    active: !!expose,
    name: '',                    // 화면용 이름 (비어 있으면 posName)
    kind: '기타',
    desc: '',
    bottlePrice: 0,
    image: null,
    stock: 0,
    opened: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// 사용자가 상세에서 적는 값만 받는다. 이름·글라스 가격은 포스 것이라 여기서 바꾸지 않는다.
export function applyEdits(w, input) {
  if (input.name !== undefined) w.name = str(input.name, 40);
  if (input.kind !== undefined) w.kind = KINDS.includes(input.kind) ? input.kind : w.kind;
  if (input.desc !== undefined) w.desc = str(input.desc, 80);
  if (input.bottlePrice !== undefined) w.bottlePrice = num(input.bottlePrice);
  w.updatedAt = Date.now();
  return w;
}

// ---------- 포스에서 사라진 와인 ----------
// 포스에서 잠깐 내렸다가 다시 올리는 경우가 있어, 적어둔 값(재고·사진 등)은 버리지 않고 보관한다.

const KEEP = ['name', 'kind', 'desc', 'bottlePrice', 'image', 'stock', 'opened'];

export function toOrphan(w) {
  const d = load();
  d.orphans[normName(w.posName)] = { ...Object.fromEntries(KEEP.map((k) => [k, w[k]])), at: Date.now() };
}

export function restoreOrphan(w) {
  const d = load();
  const key = normName(w.posName);
  const o = d.orphans[key];
  if (!o) return w;
  for (const k of KEEP) if (o[k] !== undefined && o[k] !== null && o[k] !== '') w[k] = o[k];
  delete d.orphans[key];
  return w;
}

// ---------- 사진 ----------

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// 브라우저에서 긴 변 600px JPEG 로 줄여 보낸 data URL 만 받는다
export function saveImage(id, dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new Error('사진 형식을 알 수 없어요. 다시 선택해 주세요.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 2e6) throw new Error('사진이 너무 커요. 다른 사진을 골라 주세요.');
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  const file = `${id}.${EXT[m[1]]}`;
  for (const e of Object.values(EXT)) { try { fs.unlinkSync(path.join(IMAGE_DIR, `${id}.${e}`)); } catch {} }
  fs.writeFileSync(path.join(IMAGE_DIR, file), buf);
  return file;
}

export function removeImage(w) {
  if (w.image) { try { fs.unlinkSync(path.join(IMAGE_DIR, w.image)); } catch {} }
  w.image = null;
}

export function imagePath(file) {
  const safe = path.basename(String(file || '')); // 경로 탈출 방지
  if (!/^w_[a-z0-9]+\.(jpg|png|webp)$/i.test(safe)) return null;
  const p = path.join(IMAGE_DIR, safe);
  return fs.existsSync(p) ? p : null;
}
