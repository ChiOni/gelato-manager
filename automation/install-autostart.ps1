# 메뉴 관리 서버 자동 실행 설치 (한 번만 실행, 관리자 권한 불필요)
#   - Windows 시작프로그램 폴더에 숨김 실행기 등록 → 로그인할 때마다 서버 자동 시작
#   - 바탕화면에 "메뉴 관리" 바로가기 생성
#   - 지금 바로 서버 시작
# 제거: 시작프로그램 폴더(shell:startup)의 GelatoMenuServer.vbs 삭제
$runner = Join-Path $PSScriptRoot 'run-server.ps1'
$startup = [Environment]::GetFolderPath('Startup')
$vbs = Join-Path $startup 'GelatoMenuServer.vbs'
# 창 없이(0) 실행기 실행 — 서버가 꺼지면 실행기가 다시 켠다
$q = [char]34  # "
$cmd = 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ' + $q + $q + $runner + $q + $q  # VBS 문자열 안의 따옴표는 "" 로
Set-Content -Encoding ascii $vbs ('CreateObject(' + $q + 'WScript.Shell' + $q + ').Run ' + $q + $cmd + $q + ', 0, False')

$desktop = [Environment]::GetFolderPath('Desktop')
Set-Content -Encoding ascii (Join-Path $desktop '메뉴 관리.url') "[InternetShortcut]`r`nURL=http://localhost:8787/`r`n"

Start-Process wscript.exe -ArgumentList "`"$vbs`""
Write-Host '설치 완료: 로그인할 때마다 메뉴 관리 서버가 자동으로 켜집니다.'
Write-Host '바탕화면의 "메뉴 관리" 바로가기 → http://localhost:8787'
