$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskNode = (Get-Command node.exe -ErrorAction Stop).Source
$taskLogDir = Join-Path $taskRoot '.tmp-smoke\launcher'
New-Item -ItemType Directory -Path $taskLogDir -Force | Out-Null
$taskLogName = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
Start-Process -FilePath $taskNode -ArgumentList 'scripts/browser.mjs' `
    -WorkingDirectory $taskRoot -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $taskLogDir "$taskLogName.log") `
    -RedirectStandardError (Join-Path $taskLogDir "$taskLogName.error.log")
