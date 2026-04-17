#
# GeneralStaff end-of-session Telegram notifier.
#
# Reads the bot token from ~/.claude/.mcp.json (mcpServers."telegram-channel".env
# .TELEGRAM_BOT_TOKEN - note: hyphenated server key) and the recipient chat_id
# from ~/.claude/channels/telegram/access.json (allowFrom[0]). Posts a short
# summary message via the Bot API; bails quietly if either credential is
# missing, so a missing config never crashes the session.
#
# Non-fatal: all failures log via Write-Output only; the script always exits
# 0 so the session's exit code is unaffected.
#
# ASCII-only by design: Windows PowerShell 5.1 reads .ps1 files as Windows-1252,
# which mangles UTF-8 multi-byte characters and causes silent string-parse
# errors. Do not add em-dashes, smart quotes, or non-ASCII punctuation here.
#
# Usage:
#   powershell -File scripts/notify_telegram.ps1 `
#     -ExitCode 0 -BudgetMin 360 -LogPath logs/session_...log -DigestDir digests
#

param(
  [string]$ExitCode = "?",
  [string]$BudgetMin = "?",
  [string]$LogPath = "",
  [string]$DigestDir = "digests"
)

$ErrorActionPreference = 'Continue'

$mcpPath    = Join-Path $env:USERPROFILE '.claude\.mcp.json'
$accessPath = Join-Path $env:USERPROFILE '.claude\channels\telegram\access.json'

if (-not (Test-Path $mcpPath) -or -not (Test-Path $accessPath)) {
  Write-Output "[telegram] config not found - skipping notification"
  exit 0
}

$token = $null
$chatId = $null

try {
  $mcp = Get-Content $mcpPath -Raw | ConvertFrom-Json
  $server = $mcp.mcpServers.'telegram-channel'
  if ($server -and $server.env -and $server.env.TELEGRAM_BOT_TOKEN) {
    $token = [string]$server.env.TELEGRAM_BOT_TOKEN
  }
} catch {
  Write-Output "[telegram] could not parse .mcp.json: $_"
}

try {
  $access = Get-Content $accessPath -Raw | ConvertFrom-Json
  if ($access.allowFrom -and $access.allowFrom.Count -gt 0) {
    $chatId = [string]$access.allowFrom[0]
  }
} catch {
  Write-Output "[telegram] could not parse access.json: $_"
}

if (-not $token -or $token.Length -eq 0 -or -not $chatId -or $chatId.Length -eq 0) {
  Write-Output "[telegram] token or chat_id missing after load - skipping notification"
  exit 0
}

$digestSummary = ""
try {
  $latest = Get-ChildItem -Path $DigestDir -Filter "digest_*.md" -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1
  if ($latest) {
    # Force UTF-8 so em-dashes / non-ASCII chars in the digest aren't
    # mangled into invalid bytes by the default Windows-1252 reader.
    $digestLines = Get-Content $latest.FullName -Encoding UTF8 -TotalCount 30
    $digestSummary = ($digestLines -join "`n")
  }
} catch { }

$status = if ($ExitCode -eq "0") { "OK" } else { "FAIL" }

$msg = "[$status] GeneralStaff session complete`n`n" +
       "Exit code: $ExitCode`n" +
       "Budget: $BudgetMin min`n" +
       "Log: $LogPath`n`n" +
       $digestSummary

if ($msg.Length -gt 3900) {
  $msg = $msg.Substring(0, 3890) + "`n[...truncated]"
}

$body = @{
  chat_id = $chatId
  text    = $msg
} | ConvertTo-Json -Compress

try {
  $uri = "https://api.telegram.org/bot" + $token + "/sendMessage"
  # Encode the JSON body as UTF-8 bytes explicitly. Without this, Windows
  # PowerShell will send the string in its default codepage and Telegram
  # rejects the request with "strings must be encoded in UTF-8" when the
  # message contains any non-ASCII character (em-dashes, smart quotes, etc.
  # which commonly appear in digest markdown).
  $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)
  Invoke-RestMethod -Uri $uri -Method Post -ContentType "application/json; charset=utf-8" -Body $bodyBytes | Out-Null
  Write-Output "[telegram] notification sent"
} catch {
  Write-Output "[telegram] send failed: $_"
}
