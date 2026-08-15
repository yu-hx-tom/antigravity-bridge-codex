$ErrorActionPreference = 'Stop'

$dataDir = if ($env:BRIDGE_DATA_DIR) {
  $env:BRIDGE_DATA_DIR
} else {
  Join-Path $env:LOCALAPPDATA 'AntigravityCodexBridge'
}
$settingsPath = Join-Path $dataDir 'settings.json'
if (-not (Test-Path -LiteralPath $settingsPath)) {
  throw 'Bridge settings were not found. Start Antigravity Codex Bridge first.'
}
$settings = Get-Content -Raw -LiteralPath $settingsPath | ConvertFrom-Json
$bridgePort = if ($env:BRIDGE_PORT) { $env:BRIDGE_PORT } else { '8787' }
$bridgeUrl = 'http://127.0.0.1:' + $bridgePort
$headers = @{ 'X-Bridge-Key' = $settings.uiKey }
$body = @{ model = $settings.defaultModel } | ConvertTo-Json

$codexProcesses = Get-Process -Name ChatGPT -ErrorAction SilentlyContinue
foreach ($process in $codexProcesses) { [void]$process.CloseMainWindow() }
$deadline = (Get-Date).AddSeconds(10)
while ((Get-Process -Name ChatGPT -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 250
}
Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Stop-Process -ErrorAction Stop
Write-Output 'Codex has exited.'

$package = Get-AppxPackage | Where-Object {
  $_.Name -match '^OpenAI\.(Codex|ChatGPT)$' -or $_.PackageFamilyName -match '^OpenAI\.(Codex|ChatGPT)_'
} | Select-Object -First 1
if (-not $package) { throw 'The Microsoft Store Codex package was not found.' }
$appId = $package.PackageFamilyName + '!App'

$activated = $false
try {
  Invoke-RestMethod -Method Post -Uri ($bridgeUrl + '/api/codex/activate') -Headers $headers -ContentType 'application/json' -Body $body | Out-Null
  $activated = $true
  Start-Process -FilePath 'explorer.exe' -ArgumentList @('shell:AppsFolder\' + $appId) -ErrorAction Stop | Out-Null
  Write-Output ('Codex API Service activation sent: ' + $appId)

  $deadline = (Get-Date).AddSeconds(20)
  while (-not (Get-Process -Name ChatGPT -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
  }
  if (-not (Get-Process -Name ChatGPT -ErrorAction SilentlyContinue)) {
    throw 'Codex did not start within 20 seconds.'
  }

  Start-Sleep -Seconds 3
  Invoke-RestMethod -Method Post -Uri ($bridgeUrl + '/api/codex/reapply') -Headers $headers -ContentType 'application/json' -Body '{}' | Out-Null
  Write-Output ('Codex API Service is active with model: ' + $settings.defaultModel)
} catch {
  if ($activated) {
    try {
      Invoke-RestMethod -Method Post -Uri ($bridgeUrl + '/api/codex/restore') -Headers $headers -ContentType 'application/json' -Body '{}' | Out-Null
    } catch {}
  }
  throw
}
