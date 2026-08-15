$ErrorActionPreference = 'Stop'

$dataDir = if ($env:BRIDGE_DATA_DIR) {
  $env:BRIDGE_DATA_DIR
} else {
  Join-Path $env:LOCALAPPDATA 'AntigravityCodexBridge'
}
$settingsPath = Join-Path $dataDir 'settings.json'
$settings = if (Test-Path -LiteralPath $settingsPath) {
  Get-Content -Raw -LiteralPath $settingsPath | ConvertFrom-Json
} else { $null }
$codexHome = $settings.codexHome
if ([string]::IsNullOrWhiteSpace($codexHome)) {
  $codexHome = Join-Path $HOME '.codex'
}

$configPath = Join-Path $codexHome 'config.toml'
$stagedHome = Join-Path $dataDir 'codex-home'
if (-not (Test-Path -LiteralPath $configPath)) {
  throw 'Codex API Service config is not active. Open the bridge page and apply it first.'
}

$config = Get-Content -Raw -LiteralPath $configPath
if ($config -notmatch 'model_provider\s*=\s*"antigravity_local"') {
  throw 'Codex API Service config is not active. Open the bridge page and apply it first.'
}

$announced = $false
while (Get-Process -Name ChatGPT -ErrorAction SilentlyContinue) {
  if (-not $announced) {
    Write-Output 'Waiting for Codex to exit...'
    Write-Output 'Close every Codex window and tray process. This launcher will continue automatically.'
    $announced = $true
  }
  Start-Sleep -Seconds 1
}

$package = Get-AppxPackage | Where-Object {
  $_.Name -match '^OpenAI\.(Codex|ChatGPT)$' -or $_.PackageFamilyName -match '^OpenAI\.(Codex|ChatGPT)_'
} | Select-Object -First 1
if (-not $package) {
  throw 'The Microsoft Store Codex package was not found.'
}

$appId = $package.PackageFamilyName + '!App'
Start-Process -FilePath 'explorer.exe' -ArgumentList @('shell:AppsFolder\' + $appId) -ErrorAction Stop | Out-Null
Write-Output ('Codex API Service activation sent: ' + $appId)

$deadline = (Get-Date).AddSeconds(20)
while (-not (Get-Process -Name ChatGPT -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 250
}
if (-not (Get-Process -Name ChatGPT -ErrorAction SilentlyContinue)) {
  throw 'Codex did not start within 20 seconds.'
}

# The Store app syncs its official profile during startup, so apply the staged API profile afterwards.
Start-Sleep -Seconds 3
New-Item -ItemType Directory -Path $codexHome -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $stagedHome 'config.toml') -Destination $configPath -Force
Copy-Item -LiteralPath (Join-Path $stagedHome 'auth.json') -Destination (Join-Path $codexHome 'auth.json') -Force
Write-Output 'Codex API Service profile reapplied after desktop startup.'
Start-Sleep -Seconds 2
