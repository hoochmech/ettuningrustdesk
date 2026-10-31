# Builds the technician installer: one .cmd file with the X: drive technician key inside.
#
# Run it on your own computer, from this repository:
#   powershell -ExecutionPolicy Bypass -File res\et-tuning\tech-installer\build.ps1 -KeyFile C:\path\xdrive-tech-key.json
#
# It writes ETTuning-Technician-Setup.cmd next to the key file. Anyone who has that file
# has the key, so treat it like the key: keep it off customer PCs, out of this repository
# and out of anything public.
param(
    [Parameter(Mandatory = $true)][string]$KeyFile,
    [string]$Out
)
$ErrorActionPreference = "Stop"

$keyPath = (Resolve-Path $KeyFile).Path
$keyBytes = [IO.File]::ReadAllBytes($keyPath)
$key = [Text.Encoding]::UTF8.GetString($keyBytes) | ConvertFrom-Json
if ($key.type -ne "service_account" -or -not $key.private_key -or -not $key.client_email) {
    throw "$KeyFile is not a service account key file."
}
if (-not $Out) { $Out = Join-Path (Split-Path $keyPath) "ETTuning-Technician-Setup.cmd" }

$setup = [IO.File]::ReadAllBytes((Join-Path $PSScriptRoot "..\xdrive-tech-setup.ps1"))
$body = [IO.File]::ReadAllText((Join-Path $PSScriptRoot "install-technician.ps1"))

# cmd.exe runs the first lines and stops at "exit /b"; PowerShell runs what follows the
# second marker (the first one is in the command line itself).
$marker = "#ET-TECH-SCRIPT#"
$lines = @(
    "@echo off",
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command `"`$CmdPath='%~f0'; `$User='%~1'; Invoke-Expression ((Get-Content -LiteralPath `$CmdPath -Raw) -split '$marker')[2]`"",
    "exit /b %errorlevel%",
    $marker,
    "`$KeyBase64 = '$([Convert]::ToBase64String($keyBytes))'",
    "`$TechSetup = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$([Convert]::ToBase64String($setup))'))",
    ($body -replace "`r?`n", "`r`n")
)
[IO.File]::WriteAllText($Out, ($lines -join "`r`n"), [Text.Encoding]::ASCII)
Write-Host "Wrote $Out for $($key.client_email)"
