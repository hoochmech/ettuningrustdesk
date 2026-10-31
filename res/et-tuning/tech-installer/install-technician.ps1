# Body of the technician installer that build.ps1 writes. The lines build.ps1 puts in
# front of it set $CmdPath, $User, $KeyBase64 and $TechSetup.
#
# Installs ET Tuning Remote Client from the latest release (if it is not installed yet),
# puts the X: drive technician key in place and sets up the technician's own X: drive.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (-not $User) {
    # The person signed in at the screen, even when another administrator approves the UAC prompt.
    $User = (Get-CimInstance Win32_ComputerSystem).UserName
    if (-not $User) { $User = "$env:USERDOMAIN\$env:USERNAME" }
}

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $p = Start-Process $CmdPath -Verb RunAs -Wait -PassThru -ArgumentList "`"$User`""
    exit $p.ExitCode
}

$keyDir = "C:\ProgramData\ETTuning"
$keyFile = Join-Path $keyDir "xdrive-tech-key.json"
$tmp = Join-Path $env:TEMP "et-tech-install"
$exitCode = 0
try {
    Write-Host "Setting up ET Tuning Remote Client for technician $User"
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null

    if (Test-Path "$env:ProgramFiles\ETTuningRemote\ETTuningRemote.exe") {
        Write-Host "ET Tuning Remote Client is already installed; it keeps updating itself."
    } else {
        Write-Host "Downloading ET Tuning Remote Client..."
        $release = Invoke-RestMethod "https://api.github.com/repos/hoochmech/ettuningrustdesk/releases/latest" `
            -Headers @{ "User-Agent" = "ETTuning-technician-installer" }
        $asset = $release.assets | Where-Object { $_.name -like "ETTuningRemote-*-x86_64.msi" } | Select-Object -First 1
        if (-not $asset) { throw "The latest release has no MSI." }
        $msi = Join-Path $tmp $asset.name
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $msi
        Write-Host "Installing $($release.tag_name)..."
        $log = Join-Path $env:TEMP "ettuning-remote-install.log"
        $p = Start-Process msiexec -Wait -PassThru -ArgumentList "/i `"$msi`" /qn /norestart /l*v `"$log`""
        if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { throw "Client install failed: $($p.ExitCode). Details: $log" }
    }

    Write-Host "Installing the X: drive technician key..."
    New-Item -ItemType Directory -Force -Path $keyDir | Out-Null
    [IO.File]::WriteAllBytes($keyFile, [Convert]::FromBase64String($KeyBase64))

    $setup = Join-Path $tmp "xdrive-tech-setup.ps1"
    Set-Content -Path $setup -Value $TechSetup -Encoding ascii
    & $setup -KeyFile $keyFile -User $User
    Write-Host ""
    Write-Host "Done. Restart ET Tuning Remote Client if it was already open."
} catch {
    Write-Host ""
    Write-Host "Setup failed: $_" -ForegroundColor Red
    $exitCode = 1
} finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
Read-Host "Press Enter to close"
exit $exitCode
