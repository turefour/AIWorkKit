# AIWorkKit Eco - build a portable package on the Desktop.
# Output: Desktop\AIWorkKit-Eco-portable\ (ready to run) + .zip (ready to copy).
# Runtime state (.eco, logs) and editor backups are excluded on purpose.
$ErrorActionPreference = 'Stop'

$pluginRoot = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$outDir = Join-Path $desktop 'AIWorkKit-Eco-portable'
$zipPath = Join-Path $desktop 'AIWorkKit-Eco-portable.zip'
$targetPlugin = Join-Path $outDir 'eco'
$packageSrc = Join-Path $pluginRoot 'package'

Write-Host '构建便携安装包' -ForegroundColor Cyan
Write-Host ('  源插件 : ' + $pluginRoot)
Write-Host ('  输出   : ' + $outDir)

if (-not (Test-Path (Join-Path $packageSrc 'install.ps1'))) {
  throw 'package\install.ps1 缺失，无法打包'
}

if (Test-Path $outDir) { Remove-Item $outDir -Recurse -Force }
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
New-Item -ItemType Directory -Force -Path $targetPlugin | Out-Null

Write-Host '  1/4 复制插件（排除运行态）'
$excludeDirs = @(
  (Join-Path $pluginRoot '.eco'),
  (Join-Path $pluginRoot 'logs'),
  (Join-Path $pluginRoot 'node_modules'),
  (Join-Path $pluginRoot 'package')
)
$args = @($pluginRoot, $targetPlugin, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/XF', '*.bak_*', '*.bak_incremental')
$args += '/XD'
$args += $excludeDirs
& robocopy.exe @args | Out-Null
if ($LASTEXITCODE -ge 8) { throw ('robocopy 失败，退出码 ' + $LASTEXITCODE) }

Write-Host '  2/4 放入安装器与规则模板'
Copy-Item -Path (Join-Path $packageSrc '*') -Destination $outDir -Recurse -Force

Write-Host '  3/4 生成校验清单'
$files = Get-ChildItem $outDir -Recurse -File | Where-Object { $_.FullName -notlike '*.zip' }
$totalBytes = ($files | Measure-Object -Property Length -Sum).Sum
$lines = $files | ForEach-Object {
  $rel = $_.FullName.Substring($outDir.Length + 1).Replace('\', '/')
  ('{0}  {1}' -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower(), $rel)
}
[System.IO.File]::WriteAllText((Join-Path $outDir 'SHA256SUMS.txt'), ($lines -join "`n") + "`n", (New-Object System.Text.UTF8Encoding($false)))

Write-Host '  4/4 打包 zip'
Compress-Archive -Path (Join-Path $outDir '*') -DestinationPath $zipPath -CompressionLevel Optimal

Write-Host ''
Write-Host '打包完成' -ForegroundColor Green
Write-Host ('  目录 : ' + $outDir)
Write-Host ('  压缩 : ' + $zipPath + '  (' + [math]::Round((Get-Item $zipPath).Length / 1KB, 1) + ' KB)')
Write-Host ('  文件 : ' + $files.Count + ' 个，未压缩 ' + [math]::Round($totalBytes / 1KB, 1) + ' KB')
Write-Host ''
Get-ChildItem $outDir | Select-Object Mode, Name, @{n = 'KB'; e = { [math]::Round($_.Length / 1KB, 1) } } | Format-Table -AutoSize | Out-String -Width 100 | Write-Host
