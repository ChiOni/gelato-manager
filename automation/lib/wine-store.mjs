// 와인 장부 — automation/data/wines.json (서버가 재시작돼도 유지된다)
// 포스에는 재고·개봉·바틀가격·사진을 담을 곳이 없어서 이 파일이 그 정보의 유일한 보관처다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// WINE_DATA_DIR: 테스트에서 실제 장부를 건드리지 않도록 하는 용도 (평소에는 비워 둔다)
export const DATA_DIR = process.env.WINE_DATA_DIR || path.resolve(here, '..', 'data');
export const IMAGE_DIR = path.join(DATA_DIR, 'wine-images');
const FILE = path.join(DATA_DIR, 'wines.json');

export const KINDS = ['화이트', '레드', '스파클링', '오렌지', '내추럴', '로제', '무알콜', '기타'];

const EMPTY = { version: 1, wines: [], posSeenAt: null, posUnknown: [], posExcluded: [] };
let db = null;

export function load() {
  if (db) return db;
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  try {
    db = { ...EMPTY, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    db = { ...EMPTY, wines: [] }; // 파일이 없거나 깨졌으면 빈 장부로 시작 (포스에서 불러오면 채워진다)
  }
  return db;
}

export function save() {
  const d = load();
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, FILE); // 원자적 교체 — 쓰는 중에 서버가 죽어도 장부가 깨지지 않는다
  return d;
}

export const wines = () => load().wines;
export const byId = (id) => wines().find((w) => w.id === id);
export const newId = () => `w_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

const num = (v, d = 0) => {
  const n = Number(String(v ?? '').replace(/[^\d]/g, ''));
  return Number.isFinite(n) ? n : d;
};
const str = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
export const normName = (s) => String(s || '').replace(/[\s\-–·,()（）]/g, '');

// 화면에서 온 입력값 → 장부 레코드. 믿을 수 없는 값은 모두 여기서 정리한다.
export function normalize(input, base = {}) {
  const w = {
    ...base,
    name: str(input.name ?? base.name, 40),
    nameEn: str(input.nameEn ?? base.nameEn, 40),
    posName: str(input.posName ?? base.posName, 60),
    kind: KINDS.includes(input.kind) ? input.kind : (base.kind || '기타'),
    desc: str(input.desc ?? base.desc, 80),
    glassPrice: num(input.glassPrice ?? base.glassPrice),
    bottlePrice: num(input.bottlePrice ?? base.bottlePrice),
    stock: Math.min(999, Math.max(0, num(input.stock ?? base.stock))),
    opened: input.opened === undefined ? !!base.opened : !!input.opened,
    updatedAt: Date.now(),
  };
  if (!w.posName) w.posName = w.name; // 포스 상품명을 따로 안 적었으면 이름을 그대로 쓴다
  w.posPrice = w.glassPrice;          // 포스 기본가격 = 글라스 가격 (매칭 기준)
  return w;
}

export function validate(w) {
  if (!w.name) throw new Error('와인 이름을 입력해 주세요.');
  if (!w.glassPrice) throw new Error('글라스 가격을 입력해 주세요.');
  if (!w.bottlePrice) throw new Error('바틀 가격을 입력해 주세요.');
  return w;
}

// 같은 와인을 두 번 등록하지 않도록 (이름 또는 포스 상품명+가격이 같으면 중복)
export function findDup(w, exceptId = null) {
  return wines().find((o) => o.id !== exceptId && (
    normName(o.name) === normName(w.name)
    || (normName(o.posName) === normName(w.posName) && o.posPrice === w.posPrice)
  ));
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// 사진 저장 — 브라우저에서 600px JPEG 로 줄여 보낸 data URL 만 받는다
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
