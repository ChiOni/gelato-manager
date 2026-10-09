// 배달앱 로그인 정보 — Windows DPAPI 로 암호화해 automation/.secrets/<site>.cred 에 저장 (현재 Windows 계정만 복호화 가능)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SECRETS_DIR = path.resolve(here, '..', '.secrets');

export function loadCred(site) {
  const file = path.join(SECRETS_DIR, `${site}.cred`);
  if (!fs.existsSync(file)) return null;
  const ps = `$s = Get-Content -LiteralPath '${file.replace(/'/g, "''")}' | ConvertTo-SecureString; [Console]::OutputEncoding=[Text.Encoding]::UTF8; [Net.NetworkCredential]::new('', $s).Password`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
  return JSON.parse(out.trim());
}
