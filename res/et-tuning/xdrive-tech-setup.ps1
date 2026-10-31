# Sets up the permanent, read-write X: drive on a technician PC.
#
# Run once, in PowerShell as administrator, while signed in as the technician:
#   powershell -ExecutionPolicy Bypass -File xdrive-tech-setup.ps1
#
# Before running it, put the technician key from the Google Cloud setup at
# C:\ProgramData\ETTuning\xdrive-tech-key.json. The same file lets ET Tuning Remote
# Client hand customers their 15 minute X: drive tokens.
#
# The drive mounts at every sign-in. To remove it:
#   Unregister-ScheduledTask "ET Tuning X drive"; Stop-Process -Name rclone

param(
    [string]$KeyFile = "C:\ProgramData\ETTuning\xdrive-tech-key.json",
    [string]$Bucket = "ettuning-fileshare-files",
    [string]$User = "$env:USERDOMAIN\$env:USERNAME"
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# Keep in sync with "Bundle rclone and WinFsp" in .github/workflows/et-tuning-windows.yml.
$RcloneVersion = "v1.69.1"
$WinFspUrl = "https://github.com/winfsp/winfsp/releases/download/v2.0/winfsp-2.0.23075.msi"

$dir = "C:\ProgramData\ETTuning\xdrive"

if (-not (Test-Path $KeyFile)) { throw "Put the technician key at $KeyFile first." }
New-Item -ItemType Directory -Force -Path $dir | Out-Null

# Only this technician, administrators and SYSTEM may read the key.
icacls $KeyFile /inheritance:r /grant:r "SYSTEM:F" "*S-1-5-32-544:F" "${user}:R" | Out-Null

$tmp = Join-Path $env:TEMP "et-xdrive-setup"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

if (-not (Test-Path "${env:ProgramFiles(x86)}\WinFsp\bin\winfsp-x64.dll")) {
    Write-Host "Installing WinFsp..."
    $msi = Join-Path $tmp "winfsp.msi"
    Invoke-WebRequest -Uri $WinFspUrl -OutFile $msi
    $sig = Get-AuthenticodeSignature $msi
    if ($sig.Status -ne "Valid" -or $sig.SignerCertificate.Subject -notmatch "Navimatics") {
        throw "WinFsp installer signature is not valid: $($sig.Status)"
    }
    $log = Join-Path $env:TEMP "winfsp-install.log"
    $p = Start-Process msiexec -ArgumentList "/i `"$msi`" /qn /norestart /l*v `"$log`"" -Wait -PassThru
    if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { throw "WinFsp install failed: $($p.ExitCode). Details: $log" }
}

Write-Host "Downloading rclone $RcloneVersion..."
$zipName = "rclone-$RcloneVersion-windows-amd64.zip"
$zip = Join-Path $tmp $zipName
Invoke-WebRequest -Uri "https://downloads.rclone.org/$RcloneVersion/$zipName" -OutFile $zip
$sumsFile = Join-Path $tmp "SHA256SUMS"
Invoke-WebRequest -Uri "https://downloads.rclone.org/$RcloneVersion/SHA256SUMS" -OutFile $sumsFile
$sums = Get-Content $sumsFile -Raw
$expected = [regex]::Match($sums, "(?m)^([0-9a-f]{64})\s+$([regex]::Escape($zipName))\s*$").Groups[1].Value
$actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
if (-not $expected -or $expected -ne $actual) { throw "rclone download is corrupt or tampered with." }
Get-Process rclone -ErrorAction SilentlyContinue | Stop-Process -Force
Expand-Archive $zip -DestinationPath (Join-Path $tmp "rclone") -Force
Copy-Item (Join-Path $tmp "rclone\*\rclone.exe") (Join-Path $dir "rclone.exe") -Force
Remove-Item $tmp -Recurse -Force

$rcloneArgs = @(
    "mount", ":gcs:$Bucket", "X:",
    "--gcs-service-account-file", "`"$KeyFile`"",
    "--gcs-bucket-policy-only",
    "--vfs-cache-mode", "writes",
    "--dir-cache-time", "30s",
    "--volname", "`"ET Tuning X`"",
    "--no-console"
) -join " "

$action = New-ScheduledTaskAction -Execute (Join-Path $dir "rclone.exe") -Argument $rcloneArgs
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "ET Tuning X drive" -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName "ET Tuning X drive"

Start-Sleep -Seconds 5
if (Test-Path "X:\") {
    Write-Host "X: is mounted. Files\ is what customers see; Uploads\ is where their files land."
} else {
    Write-Host "X: did not appear yet. Sign out and back in, or check that the key file is correct."
}
