# Windows 내장 OCR(한국어)로 이미지의 글자 줄과 위치를 JSON 으로 출력
#   powershell -File ocr.ps1 <이미지경로>  →  [{text, x, y, w, h}, …]  (좌표는 이미지 픽셀)
param([Parameter(Mandatory)][string]$Path)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
[void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
[void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
[void][Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync((Resolve-Path $Path).Path)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('ko'))
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$stream.Dispose()

$out = foreach ($line in $result.Lines) {
  $xs = $line.Words | ForEach-Object { $_.BoundingRect }
  $x = ($xs | Measure-Object X -Minimum).Minimum; $y = ($xs | Measure-Object Y -Minimum).Minimum
  $r = ($xs | ForEach-Object { $_.X + $_.Width } | Measure-Object -Maximum).Maximum; $b = ($xs | ForEach-Object { $_.Y + $_.Height } | Measure-Object -Maximum).Maximum
  [pscustomobject]@{ text = $line.Text; x = [int]$x; y = [int]$y; w = [int]($r - $x); h = [int]($b - $y) }
}
[Console]::OutputEncoding = [Text.Encoding]::UTF8
ConvertTo-Json @($out) -Compress
