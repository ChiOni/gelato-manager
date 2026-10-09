// 피그마 메뉴명 ↔ 배달앱 옵션명 매칭
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ALIASES = JSON.parse(fs.readFileSync(path.resolve(here, '..', 'menu-aliases.json'), 'utf8'));

export const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
const bare = (s) => norm(String(s || '').replace(/\([^)]*\)/g, '')); // 괄호 설명 제거: 스트라치아텔라(우유+초코칩) → 스트라치아텔라

// 피그마 이름 → 채널 옵션명 후보들 중 실제로 있는 것 하나. 없으면 null, 애매하면 에러.
export function matchOption(figmaName, channel, optionNames) {
  const alias = Object.entries(ALIASES).find(([k]) => norm(k) === norm(figmaName));
  const wanted = alias && alias[1][channel] ? alias[1][channel] : figmaName;
  for (const key of [norm, bare]) {
    const hits = optionNames.filter((o) => key(o) === key(wanted));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      const exact = hits.filter((o) => norm(o) === norm(wanted));
      if (exact.length === 1) return exact[0];
      throw new Error(`'${figmaName}'와 매칭되는 옵션이 여러 개입니다: ${hits.join(', ')} → automation/menu-aliases.json 에 지정하세요.`);
    }
  }
  return null;
}

// 신규 추가 시 채널에 등록할 이름
export function optionNameFor(figmaName, channel) {
  const alias = Object.entries(ALIASES).find(([k]) => norm(k) === norm(figmaName));
  return alias && alias[1][channel] ? alias[1][channel] : figmaName.replace(/\s+/g, ' ').trim();
}
