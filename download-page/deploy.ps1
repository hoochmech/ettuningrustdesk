<#
.SYNOPSIS
  Deploys the ET Tuning Remote download page to Firebase Hosting.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\deploy.ps1 -ProjectId my-gcp-project
#>
param(
    [Parameter(Mandatory = $true, HelpMessage = "Your Google Cloud / Firebase project ID")]
    [string]$ProjectId
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js is not installed. Install it with:" -ForegroundColor Red
    Write-Host "  winget install OpenJS.NodeJS.LTS"
    Write-Host "then open a new PowerShell window and run this script again."
    exit 1
}

# npm's global folder may not be on PATH yet in this window.
$npmGlobal = Join-Path $env:APPDATA "npm"
if ($env:Path -notlike "*$npmGlobal*") { $env:Path = "$npmGlobal;$env:Path" }

# Call firebase.cmd rather than firebase.ps1 so a restrictive execution policy does not block it.
if (-not (Get-Command firebase.cmd -ErrorAction SilentlyContinue)) {
    Write-Host "Installing the Firebase CLI..." -ForegroundColor Cyan
    & npm.cmd install -g firebase-tools
    if ($LASTEXITCODE -ne 0) { Write-Host "Installing firebase-tools failed." -ForegroundColor Red; exit 1 }
}

Write-Host "Checking Firebase sign-in..." -ForegroundColor Cyan
& firebase.cmd login
if ($LASTEXITCODE -ne 0) { Write-Host "Firebase sign-in failed." -ForegroundColor Red; exit 1 }

Push-Location $PSScriptRoot
try {
    Write-Host "Deploying to project $ProjectId..." -ForegroundColor Cyan
    & firebase.cmd deploy --only hosting --project $ProjectId
    if ($LASTEXITCODE -ne 0) { Write-Host "Deploy failed." -ForegroundColor Red; exit 1 }
}
finally {
    Pop-Location
}

Write-Host ""
Write-Host "Deployed. Check the page at:" -ForegroundColor Green
Write-Host "  https://$ProjectId.web.app/client-download/"
Write-Host "  https://ettuning.net/client-download/  (once the custom domain is connected)"
