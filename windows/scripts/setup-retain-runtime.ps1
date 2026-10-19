$ErrorActionPreference = 'Stop'

$windowsRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $windowsRoot '.retain-runtime'
$python = $null
$pythonArgs = @()

$launcher = Get-Command py -ErrorAction SilentlyContinue
if ($launcher) {
  foreach ($version in @('3.12', '3.11')) {
    & $launcher.Source "-$version" -c 'import sys; print(sys.executable)' *> $null
    if ($LASTEXITCODE -eq 0) {
      $python = $launcher.Source
      $pythonArgs = @("-$version")
      break
    }
  }
}

if (-not $python) {
  $configured = $env:READX_PYTHON
  if (-not $configured) { $configured = 'python' }
  $resolved = Get-Command $configured -ErrorAction SilentlyContinue
  if (-not $resolved) { throw 'Install Python 3.11 or 3.12, or set READX_PYTHON to python.exe.' }
  & $resolved.Source -c "import sys; raise SystemExit(0 if sys.version_info[:2] in {(3, 11), (3, 12)} else 1)"
  if ($LASTEXITCODE -ne 0) { throw 'RetainPDF dependencies currently support Python 3.11 or 3.12.' }
  $python = $resolved.Source
}

if (-not (Test-Path (Join-Path $runtimeRoot 'Scripts/python.exe'))) {
  & $python @pythonArgs -m venv $runtimeRoot
}
$runtimePython = Join-Path $runtimeRoot 'Scripts/python.exe'
$env:PIP_CACHE_DIR = Join-Path $windowsRoot '.retain-pip-cache'
 $env:TEMP = Join-Path $windowsRoot '.retain-tmp'
 $env:TMP = $env:TEMP
 New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
& $runtimePython -m pip install --only-binary=:all: --disable-pip-version-check `
  Pillow==10.4.0 PyMuPDF==1.26.5 pikepdf==10.13.0.post1 requests==2.32.5 urllib3==2.5.0
if ($LASTEXITCODE -ne 0) { throw 'RetainPDF wheel install failed. Only prebuilt wheels are accepted; no C/C++ build tools are used.' }

Write-Host "Retain runtime ready: $runtimePython"
