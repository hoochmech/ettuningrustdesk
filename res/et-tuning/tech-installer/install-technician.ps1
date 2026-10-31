# Runs inside the technician installer built by .github/workflows/et-tuning-tech-installer.yml.
# Installs ET Tuning Remote Client (if it is not installed yet), puts the X: drive
# technician key in place and sets up the technician's own X: drive.
param(
    # The person signed in at the screen, even when an administrator approves the UAC prompt.
    [string]$User = $(
        $u = (Get-CimInstance Win32_ComputerSystem).UserName
        if ($u) { $u } else { "$env:USERDOMAIN\$env:USERNAME" }
    )
)
$ErrorActionPreference = "Stop"

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    # The installer's temporary folder is removed when this returns, so wait for the elevated copy.
    $p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList `
        "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -User `"$User`""
    exit $p.ExitCode
}

$keyDir = "C:\ProgramData\ETTuning"
$keyFile = Join-Path $keyDir "xdrive-tech-key.json"
$exitCode = 0
try {
    Write-Host "Setting up ET Tuning Remote Client for technician $User"

    if (Test-Path "$env:ProgramFiles\ETTuningRemote\ETTuningRemote.exe") {
        Write-Host "ET Tuning Remote Client is already installed; it keeps updating itself."
    } else {
        Write-Host "Installing ET Tuning Remote Client..."
        $msi = Get-ChildItem -Path $PSScriptRoot -Filter "ETTuningRemote-*.msi" | Select-Object -First 1
        if (-not $msi) { throw "The client installer is missing from this package." }
        $log = Join-Path $env:TEMP "ettuning-remote-install.log"
        $p = Start-Process msiexec -Wait -PassThru -ArgumentList "/i `"$($msi.FullName)`" /qn /norestart /l*v `"$log`""
        if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { throw "Client install failed: $($p.ExitCode). Details: $log" }
    }

    Write-Host "Installing the X: drive technician key..."
    New-Item -ItemType Directory -Force -Path $keyDir | Out-Null
    Copy-Item (Join-Path $PSScriptRoot "xdrive-tech-key.json") $keyFile -Force

    & (Join-Path $PSScriptRoot "xdrive-tech-setup.ps1") -KeyFile $keyFile -User $User
    Write-Host ""
    Write-Host "Done. Restart ET Tuning Remote Client if it was already open."
} catch {
    Write-Host ""
    Write-Host "Setup failed: $_" -ForegroundColor Red
    $exitCode = 1
}
Read-Host "Press Enter to close"
exit $exitCode
