# 메뉴 관리 서버 실행기 — 서버가 꺼지면 5초 뒤 다시 켠다. (작업 스케줄러가 로그인 시 숨김 창으로 실행)
Set-Location $PSScriptRoot
New-Item -ItemType Directory -Force (Join-Path $PSScriptRoot 'logs') | Out-Null

function Test-ServerUp {
  try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:8787/api/health).StatusCode -eq 200 } catch { $false }
}

if (Test-ServerUp) { exit 0 }  # 이미 실행 중

while ($true) {
  & node server.mjs *>> (Join-Path $PSScriptRoot 'logs\stdout.log')
  Start-Sleep -Seconds 5
  if (Test-ServerUp) { exit 0 }  # 다른 실행기가 이미 띄움
}
