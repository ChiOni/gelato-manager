import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEBUG_DIR = path.resolve(here, '..', '.debug'); // 오류 화면 캡처 저장 위치
