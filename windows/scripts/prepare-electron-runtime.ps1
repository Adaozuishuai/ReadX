$ErrorActionPreference = 'Stop'
$readxRoot = Split-Path $PSScriptRoot -Parent
$readxPackage = Get-Content -LiteralPath (Join-Path $readxRoot 'node_modules\electron\package.json') -Raw | ConvertFrom-Json
$readxSource = Join-Path $readxRoot 'node_modules\electron\dist'
$readxRuntime = Join-Path $env:LOCALAPPDATA ('ReadX\runtime\electron-' + $readxPackage.version + '-x64')
$readxExecutable = Join-Path $readxRuntime 'electron.exe'
$readxHash = [System.Security.Cryptography.SHA256]::Create()
$readxStream = [System.IO.File]::OpenRead((Join-Path $readxSource 'electron.exe'))
try { $readxFingerprint = [System.BitConverter]::ToString($readxHash.ComputeHash($readxStream)).Replace('-', '') }
finally { $readxStream.Dispose(); $readxHash.Dispose() }
$readxStamp = Join-Path $readxRuntime '.readx-runtime-source'
if ((Test-Path -LiteralPath $readxExecutable) -and (Test-Path -LiteralPath $readxStamp) -and
    (Get-Content -LiteralPath $readxStamp -Raw).Trim() -eq $readxFingerprint) {
    Write-Output $readxExecutable
    exit 0
}

# Keep Chromium's sandbox enabled. Stage runtime files with their own ACL instead
# of inheriting workspace capability entries that can crash Electron on startup.
# Only this runtime cache receives these permissions; user data is stored elsewhere.
New-Item -ItemType Directory -Path $readxRuntime -Force | Out-Null
$readxAcl = New-Object System.Security.AccessControl.DirectorySecurity
$readxAcl.SetAccessRuleProtection($true, $false)
$readxUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
foreach ($readxAce in @(@($readxUser, 'FullControl'), @('S-1-5-18', 'FullControl'),
    @('S-1-5-32-544', 'FullControl'), @('S-1-15-2-1', 'ReadAndExecute'), @('S-1-15-2-2', 'ReadAndExecute'))) {
    $readxSid = New-Object System.Security.Principal.SecurityIdentifier($readxAce[0])
    $readxRule = New-Object System.Security.AccessControl.FileSystemAccessRule($readxSid, $readxAce[1], 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $readxAcl.AddAccessRule($readxRule)
}
[System.IO.Directory]::SetAccessControl($readxRuntime, $readxAcl)
Get-ChildItem -LiteralPath $readxSource -Force | Copy-Item -Destination $readxRuntime -Recurse -Force
Set-Content -LiteralPath $readxStamp -Value $readxFingerprint -Encoding ascii
Write-Output $readxExecutable
