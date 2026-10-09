# 피그마 창 상태를 JSON 한 줄로 보고한다 (지킴이 진단용).
$ErrorActionPreference = 'SilentlyContinue'
# 한글 창 제목이 로그에서 깨지지 않도록
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class StateWin {
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@

$procs = @(Get-Process Figma)
$win = $procs | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1

$o = [ordered]@{
  running   = $procs.Count -gt 0
  processes = $procs.Count
  window    = $null
}
if ($win) {
  $h = $win.MainWindowHandle
  $o.window = [ordered]@{
    title      = $win.MainWindowTitle
    minimized  = [bool][StateWin]::IsIconic($h)
    visible    = [bool][StateWin]::IsWindowVisible($h)
    foreground = ([StateWin]::GetForegroundWindow() -eq $h)
    responding = $win.Responding
  }
}
$o | ConvertTo-Json -Compress -Depth 4
