# 로그인/API 정보를 암호화 저장: .\automation\save-cred.ps1 baemin | coupang | tosspos
# Windows DPAPI 로 암호화 → 이 PC의 현재 Windows 계정에서만 복호화 가능
param([Parameter(Mandatory)][ValidateSet('baemin', 'coupang', 'tosspos')][string]$Site)
$dir = Join-Path $PSScriptRoot '.secrets'
New-Item -ItemType Directory -Force $dir | Out-Null
$plain = { param($s) [Net.NetworkCredential]::new('', $s).Password }
if ($Site -eq 'tosspos') {
  # 토스플레이스 개발자센터 → 내 애플리케이션 → 인증 정보 / 가맹점 ID
  $accessKey = Read-Host 'Access Key'
  $secretKey = & $plain (Read-Host 'Access Secret' -AsSecureString)
  $merchantId = Read-Host '가맹점 ID (MerchantId)'
  $json = @{ accessKey = $accessKey.Trim(); secretKey = $secretKey.Trim(); merchantId = $merchantId.Trim() } | ConvertTo-Json -Compress
} else {
  $id = Read-Host "$Site 아이디"
  $pw = & $plain (Read-Host "$Site 비밀번호" -AsSecureString)
  $json = @{ id = $id; pw = $pw } | ConvertTo-Json -Compress
}
ConvertTo-SecureString $json -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -Encoding ascii (Join-Path $dir "$Site.cred")
Write-Host "저장 완료: $Site"
