$ErrorActionPreference = 'Stop'

$windowsRoot = Split-Path -Parent $PSScriptRoot
$target = Join-Path $windowsRoot 'node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js'
if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
  throw "electron-builder NSIS target was not found: $target"
}

$source = [System.IO.File]::ReadAllText($target)
$original = 'if ((0, macosVersion_1.isMacOsCatalina)()) {'
$patched = 'if (process.platform === "win32" || (0, macosVersion_1.isMacOsCatalina)()) {'

if ($source.Contains($patched)) {
  Write-Host 'electron-builder Windows NSIS uninstaller extraction patch is already applied.'
  return
}
if (-not $source.Contains($original)) {
  throw 'Unsupported app-builder-lib NSIS target. Review its uninstaller extraction flow before packaging.'
}

$source = $source.Replace($original, $patched)
[System.IO.File]::WriteAllText($target, $source, [System.Text.UTF8Encoding]::new($false))
Write-Host 'Patched electron-builder to extract the NSIS uninstaller directly on Windows.'
