$ErrorActionPreference = 'Stop'
$readxRoot = Split-Path $PSScriptRoot -Parent
$readxNode = (Get-Command node.exe -ErrorAction Stop).Source
$readxLogDir = Join-Path $readxRoot '.tmp-smoke\launcher'
New-Item -ItemType Directory -Path $readxLogDir -Force | Out-Null
Start-Process -FilePath $readxNode -ArgumentList 'scripts/start-desktop.mjs' `
    -WorkingDirectory $readxRoot -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $readxLogDir 'desktop-start.log') `
    -RedirectStandardError (Join-Path $readxLogDir 'desktop-start.error.log')
