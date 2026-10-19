$ErrorActionPreference = 'Stop'

$windowsRoot = Split-Path -Parent $PSScriptRoot
$stageRoot = Join-Path $windowsRoot '.release-staging'
$resourceRoot = Join-Path $stageRoot 'resources'
$resolvedRoot = [System.IO.Path]::GetFullPath($windowsRoot).TrimEnd('\') + '\'
$resolvedStage = [System.IO.Path]::GetFullPath($stageRoot)
if (-not $resolvedStage.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to prepare release outside the Windows workspace: $resolvedStage"
}
if (Test-Path -LiteralPath $stageRoot) {
  Remove-Item -LiteralPath $stageRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $resourceRoot -Force | Out-Null

$python = $env:READX_RELEASE_PYTHON
if (-not $python) { $python = (Get-Command python -ErrorAction Stop).Source }
$pythonInfo = & $python -c 'import sys; print(sys.version_info.major, sys.version_info.minor); print(sys.base_prefix)'
if ($LASTEXITCODE -ne 0 -or $pythonInfo.Count -lt 2) { throw 'Unable to inspect the release Python runtime.' }
$pythonVersion = ($pythonInfo[0] -split '\s+') -join '.'
if ($pythonVersion -notin @('3.11', '3.12')) {
  throw "Release packaging requires Python 3.11 or 3.12; found $pythonVersion."
}
$pythonHome = $pythonInfo[1].Trim()
$env:PIP_CACHE_DIR = Join-Path $windowsRoot '.retain-pip-cache'
$env:TEMP = Join-Path $windowsRoot '.retain-tmp'
$env:TMP = $env:TEMP
$env:npm_config_cache = Join-Path $windowsRoot '.npm-cache'
New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
$portablePython = Join-Path $resourceRoot 'python'
New-Item -ItemType Directory -Path $portablePython -Force | Out-Null
$runtimeFiles = @('python.exe', 'python3.dll', 'python312.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'LICENSE.txt')
foreach ($file in $runtimeFiles) {
  $source = Join-Path $pythonHome $file
  if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $portablePython -Force }
}
foreach ($directory in @('DLLs', 'Lib')) {
  Copy-Item -Path (Join-Path $pythonHome $directory) -Destination $portablePython -Recurse -Force
}
$baseSitePackages = Join-Path $portablePython 'Lib/site-packages'
if (Test-Path -LiteralPath $baseSitePackages) {
  Remove-Item -LiteralPath $baseSitePackages -Recurse -Force
}
$pythonSite = Join-Path $portablePython 'Lib/site-packages'
New-Item -ItemType Directory -Path $pythonSite -Force | Out-Null
& $python -m pip install --upgrade --only-binary=:all: --disable-pip-version-check --no-warn-script-location `
  --target $pythonSite Pillow==10.4.0 PyMuPDF==1.26.5 pikepdf==10.13.0.post1 requests==2.32.5 urllib3==2.5.0
if ($LASTEXITCODE -ne 0) { throw 'Installing bundled RetainPDF Python wheels failed.' }

$backendSource = Join-Path $windowsRoot 'vendor/retainpdf/backend'
Copy-Item -Path $backendSource -Destination (Join-Path $resourceRoot 'vendor/retainpdf/backend') -Recurse -Force
Copy-Item -Path (Join-Path $windowsRoot 'resources/rendering-engine') -Destination (Join-Path $resourceRoot 'rendering-engine') -Recurse -Force
Copy-Item -Path (Join-Path $windowsRoot 'resources/fonts') -Destination (Join-Path $resourceRoot 'fonts') -Recurse -Force
New-Item -ItemType Directory -Path (Join-Path $resourceRoot 'licenses') -Force | Out-Null
Copy-Item -Path (Join-Path $windowsRoot 'vendor/retainpdf/LICENSE') -Destination (Join-Path $resourceRoot 'licenses/retainpdf-LICENSE') -Force
New-Item -ItemType Directory -Path (Join-Path $resourceRoot 'scripts') -Force | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot 'render-translated-pdf.cjs') -Destination (Join-Path $resourceRoot 'scripts/render-translated-pdf.cjs') -Force

$nodePackage = Join-Path $resourceRoot 'package.json'
@'
{
  "private": true,
  "dependencies": {
    "fontkit": "2.0.4",
    "mathjax-full": "3.2.1",
    "pdf-lib": "1.17.1"
  }
}
'@ | Set-Content -LiteralPath $nodePackage -Encoding utf8
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
& $npm install --prefix $resourceRoot --omit=dev --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'Installing bundled Node.js rendering dependencies failed.' }

Write-Host "Release runtime prepared: $resourceRoot"
