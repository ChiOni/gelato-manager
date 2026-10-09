# 피그마 데스크톱을 "백그라운드에서도 느려지지 않는" 옵션으로 실행한다.
#
# 메뉴판을 고칠 수 있는 건 데스크톱 앱 안에서 돌아가는 "메뉴판 자동화" 플러그인뿐이다
# (피그마 REST API로는 노드 텍스트/레이어를 수정할 수 없고, 로컬 개발 플러그인은
#  데스크톱 앱에서만 실행된다). 그래서 앱이 항상 떠 있어야 하고, 창이 가려져 있어도
# 렌더러가 느려지지 않아야 한다.
#
#   --disable-renderer-backgrounding        가려져도 렌더러 우선순위를 낮추지 않음 (Win11 EcoQoS 포함)
#   --disable-background-timer-throttling   백그라운드 타이머 감속 해제
#
# 참고: 피그마는 CalculateNativeWinOcclusion / IntensiveWakeUpThrottling 은 자체적으로 이미 끈다.
#       --remote-debugging-port 는 피그마가 막아 둬서(Electron 43) 열리지 않는다 —
#       그래서 플러그인 자동 실행은 창 포커스 + 키 입력(figma-runplugin.ps1)으로 한다.
#
# 사용: .\figma-start.ps1           꺼져 있으면 실행, 켜져 있으면 아무것도 안 함
#       .\figma-start.ps1 -Restart  켜져 있어도 종료 후 다시 실행 (옵션 적용)
param([switch]$Restart, [switch]$Quiet)

$ErrorActionPreference = 'Stop'

function Write-Note($msg) { if (-not $Quiet) { Write-Host $msg } }

function Get-FigmaExe {
  $root = Join-Path $env:LOCALAPPDATA 'Figma'
  # app-<버전> 중 가장 최신. Squirrel 런처(Figma.exe)는 플래그를 전달하지 않으므로 실제 실행 파일을 쓴다.
  $app = Get-ChildItem $root -Directory -Filter 'app-*' -ErrorAction SilentlyContinue |
    Sort-Object { [version]($_.Name -replace '^app-', '') } | Select-Object -Last 1
  if (-not $app) { throw "피그마 데스크톱을 찾지 못했습니다: $root" }
  Join-Path $app.FullName 'Figma.exe'
}

$FLAGS = @(
  '--disable-renderer-backgrounding'
  '--disable-background-timer-throttling'
)

$running = @(Get-Process Figma -ErrorAction SilentlyContinue)

if ($running.Count -gt 0 -and -not $Restart) {
  Write-Note '피그마가 이미 실행 중입니다.'
  exit 0
}

if ($running.Count -gt 0) {
  Write-Note '피그마 종료 중…'
  # 창을 정상적으로 닫아 저장을 마치게 한다 (강제 종료가 아님)
  $running | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $null = $_.CloseMainWindow() }
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    if (-not (Get-Process Figma -ErrorAction SilentlyContinue)) { break }
  }
  $left = @(Get-Process Figma -ErrorAction SilentlyContinue)
  if ($left.Count -gt 0) {
    Write-Note '남은 프로세스 정리 중…'
    $left | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }
}

$exe = Get-FigmaExe
Write-Note "실행: $exe"
Start-Process -FilePath $exe -ArgumentList $FLAGS | Out-Null

# 메뉴판 파일 탭이 복원될 때까지 기다린다 (창 제목으로 확인)
for ($i = 0; $i -lt 90; $i++) {
  Start-Sleep -Seconds 1
  $w = Get-Process Figma -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -First 1
  if ($w) { Write-Note "준비 완료: $($w.MainWindowTitle)"; exit 0 }
}
Write-Note '경고: 피그마 창이 90초 안에 뜨지 않았습니다.'
exit 1
