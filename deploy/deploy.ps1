<#
.SYNOPSIS
  Build the app and update it on the cloud VM in one step.

.DESCRIPTION
  1. python build.py            builds dist\floating-frame.pyz
  2. scp                        copies it and install-vps.sh to the VM
  3. ssh                        backs up the server's data to ~/backups (last 10 kept),
                                then runs install-vps.sh --update, which asks nothing
                                (accounts, address, path and DuckDNS are all kept)
  4. checks the site answers

  Connection details are read from deploy\deploy.local.json, which is not in git:
    { "host": "1.2.3.4", "user": "ubuntu", "key": "C:\\path\\to\\ssh-key.key",
      "url": "https://example.duckdns.org/framingapp/" }
  See deploy\deploy.example.json.

.PARAMETER SkipBuild
  Use the files already in dist\ instead of building first.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\deploy.ps1
#>
param([switch]$SkipBuild)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $PSScriptRoot 'deploy.local.json'
if (-not (Test-Path $configPath)) {
    throw "Missing $configPath - copy deploy.example.json to deploy.local.json and fill it in."
}
$cfg = Get-Content $configPath -Raw | ConvertFrom-Json
if (-not (Test-Path $cfg.key)) { throw "SSH key not found: $($cfg.key)" }

$target = "$($cfg.user)@$($cfg.host)"
# BatchMode: fail instead of ever waiting for a password prompt.
$sshOptions = @('-i', $cfg.key, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=accept-new')

function Step([string]$message) { Write-Host "`n==> $message" -ForegroundColor Cyan }
function Invoke-Native([string]$exe, [string[]]$arguments) {
    & $exe @arguments
    if ($LASTEXITCODE -ne 0) { throw "$exe failed (exit code $LASTEXITCODE)" }
}

if (-not $SkipBuild) {
    Step 'Building'
    Push-Location $root
    try { Invoke-Native 'python' @('build.py') } finally { Pop-Location }
}

Step "Copying to $target"
$files = @((Join-Path $root 'dist\floating-frame.pyz'), (Join-Path $root 'dist\install-vps.sh'))
Invoke-Native 'scp' ($sshOptions + $files + @("${target}:~"))

Step 'Backing up the server data, then installing'
# Keep a dated copy of all accounts and paintings (last 10) before every update.
$remote = 'set -e; mkdir -p ~/backups; ' +
          'if [ -d ~/floating-frame/data ]; then tar czf ~/backups/data-$(date +%Y%m%d-%H%M%S).tgz -C ~/floating-frame data; ' +
          'ls -1t ~/backups/data-*.tgz | tail -n +11 | xargs -r rm -f; echo "Backup saved in ~/backups"; fi; ' +
          'sh install-vps.sh --update'
Invoke-Native 'ssh' ($sshOptions + @($target, $remote))

if ($cfg.url) {
    Step "Checking $($cfg.url)"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $ok = $false
    foreach ($attempt in 1..6) {
        try {
            $response = Invoke-WebRequest -Uri $cfg.url -UseBasicParsing -TimeoutSec 15
            Write-Host "Site is up (HTTP $($response.StatusCode))." -ForegroundColor Green
            $ok = $true
            break
        } catch {
            Start-Sleep -Seconds 5
        }
    }
    if (-not $ok) { throw "The site didn't answer at $($cfg.url). On the server, check: sudo journalctl -u floating-frame -n 50" }
}

Write-Host "`nDeployed." -ForegroundColor Green
