$ErrorActionPreference = 'Stop'
$appId = 'OpenAI.Codex_2p2nqsd0c76g0!App'
$uiKey = 'agui_hiAOxFP2fBzJzk4t21EpsUW3CzCb_t6k'
$bridgeUrl = 'http://127.0.0.1:8787'
$model = 'gemini-3.7-flash-high'
$headers = @{ 'X-Bridge-Key' = $uiKey }
$body = @{ model = $model } | ConvertTo-Json

$codexProcesses = Get-Process -Name ChatGPT -ErrorAction SilentlyContinue
foreach ($process in $codexProcesses) { [void]$process.CloseMainWindow() }
$deadline = (Get-Date).AddSeconds(10)
while ((Get-Process -Name ChatGPT -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 250
}
Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Stop-Process -ErrorAction Stop
Write-Output 'Codex has exited.'

$activated = $false
try {
  Invoke-RestMethod -Method Post -Uri ($bridgeUrl + '/api/codex/activate') -Headers $headers -ContentType 'application/json' -Body $body | Out-Null
  $activated = $true
  $target = 'shell:AppsFolder\' + $appId
  Start-Process -FilePath 'explorer.exe' -ArgumentList @($target) -ErrorAction Stop | Out-Null
  Write-Output ('Codex API Service activation sent: ' + $appId)

  $deadline = (Get-Date).AddSeconds(20)
  while (-not (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^(ChatGPT|OpenAI.Codex)$' }) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
  }
  if (-not (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^(ChatGPT|OpenAI.Codex)$' })) {
    throw 'Codex did not start within 20 seconds.'
  }

  Start-Sleep -Seconds 3
  Invoke-RestMethod -Method Post -Uri ($bridgeUrl + '/api/codex/reapply') -Headers $headers -ContentType 'application/json' -Body '{}' | Out-Null
  Write-Output ('Codex API Service is active with model: ' + $model)
} catch {
  if ($activated) {
    try {
      Invoke-RestMethod -Method Post -Uri ($bridgeUrl + '/api/codex/restore') -Headers $headers -ContentType 'application/json' -Body '{}' | Out-Null
    } catch {}
  }
  throw
}
