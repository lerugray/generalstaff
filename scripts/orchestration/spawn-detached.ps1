# spawn-detached.ps1 - Tier 3 spawn primitive for inter-session orchestration.
#
# Spawns a fully-detached Claude Code session in a visible cmd window.
# Survives the spawning session ending (the canonical "outlive my overload"
# pattern). Mirrors the proven scripts/run_session.bat pattern: same PATH
# setup, same env loading, same visible window for ambient confirmation
# per Ray's workflow conventions (CLAUDE.local.md § "Detached bot launches
# default to visible cmd windows").
#
# Usage examples:
#   # Spawn a generic session in the orchestration workspace
#   .\spawn-detached.ps1 -RoleName deep-dive -Task "research X"
#
#   # Spawn in a specific project repo with --brief for SendUserMessage
#   .\spawn-detached.ps1 -RoleName deep-dive -ProjectPath "C:\path\to\retrogaze" `
#     -Task "investigate fantasy-bias rg-013" -Brief
#
#   # Spawn the bot launcher (special case - wraps run_session.bat, not claude)
#   .\spawn-detached.ps1 -RoleName bot-launcher -BudgetMinutes 600
#
# Design intent: this is the "must survive primary session" path. Lighter
# alternatives are available - prefer them when they fit:
#   - In-session parallel work    -> Agent tool (subagent)
#   - Bounded one-shot side-quest -> claude -p in background (spawn-tier2.sh)
#   - Coordinated parallel work   -> Agent Teams (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1)
# Tier 3 (this script) is the heaviest tier; only use when the spawned
# work genuinely needs to outlive the primary session.

param(
    [Parameter(Mandatory=$true)]
    [string]$RoleName,                # bot-launcher | deep-dive | monitor | <custom>

    [string]$Task = "",               # one-line task description (used in role.md)
    [string]$ProjectPath = "",        # if set, spawned session cd's here; else uses orch workspace
    [string]$SpawnId = "",            # explicit spawn id; auto-generated if omitted
    [int]$BudgetMinutes = 0,          # bot-launcher: passed through to run_session.bat
    [switch]$Brief,                   # enable --brief flag (SendUserMessage tool)
    [switch]$EnableAgentTeams,        # set CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 in spawned env
    [string]$Model = "",              # override model (sonnet | opus | haiku); empty = default
    [string]$AppendSystemPromptFile = "", # path to an additional .md file appended to system prompt
    [string]$InitialPrompt = "",      # initial user message - required for non-bot-launcher roles, since interactive claude waits for one
    [string]$PermissionMode = "auto", # default to auto so spawned sessions don't hang on permission prompts; override to "default" for prompt-on-each-tool, "acceptEdits" for edits-only auto, "bypassPermissions" for full bypass
    [switch]$NotifyOnExit,            # Phase 6: when set, the exit-marker step also writes notify-ray.flag so primary's next watch tick triggers PushNotification
    [ValidateSet("claude","openrouter")]
    [string]$Provider = "claude",     # v2: provider selector. claude=Anthropic API (default). openrouter=OpenRouter API via env-var compat (ANTHROPIC_BASE_URL trick).
    [string]$OpenRouterModel = "moonshotai/kimi-k2.6",  # v2: when -Provider openrouter, this model overrides all CC tier defaults. Cheap defaults: kimi-k2.6 (~$0.74/$4.65 per M, leads SWE-Bench Pro), qwen/qwen3-coder-plus (~$0.65/$3.25 per M), google/gemini-3.1-pro-preview, qwen/qwen3-coder-flash (~$0.20/$0.98 per M).
    [string]$OpenRouterEnvFile = "C:\Users\rweis\OneDrive\Documents\MiroShark\.env"  # v2: .env file holding OPENROUTER_API_KEY (or OPENAI_API_KEY — legacy field name in MiroShark .env per CLAUDE.local.md).
)

$ErrorActionPreference = "Stop"

# --- Auto-generate spawn id if not provided ---------------------------------
if ([string]::IsNullOrEmpty($SpawnId)) {
    $stamp = Get-Date -Format "yyyyMMddTHHmmss"
    $SpawnId = "${stamp}_${RoleName}"
}

# --- Locate the canonical run_session.bat pattern's PATH --------------------
# This is the same PATH front-loading as scripts/run_session.bat line 43,
# extracted so all spawn primitives stay in lockstep. If run_session.bat's
# PATH ever changes, update this too.
$canonicalPath = "C:\Program Files\Git\bin;C:\Program Files\Git\usr\bin;${env:USERPROFILE}\.bun\bin;${env:USERPROFILE}\.local\bin;${env:APPDATA}\npm"

# --- Set up orchestration state directory -----------------------------------
$orchRoot = Join-Path $env:USERPROFILE ".claude\orchestration"
$spawnDir = Join-Path $orchRoot "spawns\$SpawnId"
New-Item -ItemType Directory -Force -Path $spawnDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $spawnDir "inbox") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $spawnDir "outbox") | Out-Null

# --- Determine working directory for the spawned session --------------------
if ([string]::IsNullOrEmpty($ProjectPath)) {
    $cwd = $spawnDir
} else {
    if (-not (Test-Path $ProjectPath)) {
        Write-Error "ProjectPath does not exist: $ProjectPath"
        exit 1
    }
    $cwd = $ProjectPath
}

# --- Build role.md (loaded by spawned session) ------------------------------
$roleTemplatePath = Join-Path $PSScriptRoot "roles\$RoleName.md"
$roleContent = ""
if (Test-Path $roleTemplatePath) {
    $roleContent = Get-Content $roleTemplatePath -Raw
} else {
    Write-Warning "No role template at $roleTemplatePath - using minimal default"
    $roleContent = "# Spawn role: $RoleName`n`n(No role template found at $roleTemplatePath)"
}

$spawnedAt = (Get-Date).ToString('o')
$roleMd = @'
# Spawn session: __SPAWN_ID__

**Role:** __ROLE_NAME__
**Spawned at:** __SPAWNED_AT__
**Mailbox dir:** __MAILBOX_DIR__
**Working dir:** __CWD__

## Task

__TASK__

## Inter-session conventions

You are a detached Claude Code session spawned via the GeneralStaff
orchestration layer. Your operational pattern:

1. Read your inbox. Files in inbox/ are numbered messages from the
   primary session or other spawns (e.g., 001-task.md). Process the
   oldest unprocessed message; move processed files to inbox/processed/.
2. Write status. Update status.json with a heartbeat on each turn.
3. Write outputs to outbox/. Use numbered filenames matching the
   inbox message that triggered them when applicable.
4. Escalate to Ray via needs-ray.md when you genuinely need user
   input (taste call, strategic decision, ambiguous failure). The
   primary session monitors for this file and surfaces to Ray.
5. With --brief enabled, you also have the SendUserMessage tool for
   direct messages to Ray. Prefer needs-ray.md for primary-mediated
   escalation; use SendUserMessage for time-sensitive direct heads-ups.

## Role-specific guidance

__ROLE_CONTENT__
'@

$roleMd = $roleMd.Replace('__SPAWN_ID__', $SpawnId)
$roleMd = $roleMd.Replace('__ROLE_NAME__', $RoleName)
$roleMd = $roleMd.Replace('__SPAWNED_AT__', $spawnedAt)
$roleMd = $roleMd.Replace('__MAILBOX_DIR__', $spawnDir)
$roleMd = $roleMd.Replace('__CWD__', $cwd)
$roleMd = $roleMd.Replace('__TASK__', $Task)
$roleMd = $roleMd.Replace('__ROLE_CONTENT__', $roleContent)

$roleMdPath = Join-Path $spawnDir "role.md"
Set-Content -Path $roleMdPath -Value $roleMd -Encoding utf8

# --- Build initial status.json ----------------------------------------------
$status = @{
    spawn_id = $SpawnId
    role = $RoleName
    spawned_at = (Get-Date).ToUniversalTime().ToString("o")
    spawned_by = "interactive-claude-orchestration"
    cwd = $cwd
    project_path = $ProjectPath
    state = "starting"
    task = $Task
    last_heartbeat = $null
} | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText((Join-Path $spawnDir "status.json"), $status, [System.Text.UTF8Encoding]::new($false))

# --- Build a per-spawn .bat file with the actual launch commands ------------
# Writing to a .bat file (rather than embedding && chains in PS strings) keeps
# us out of PowerShell 5.1's parser, which has no && operator and gets
# confused by it inside string literals. cmd.exe parses && correctly when it
# reads the .bat at runtime.
$batPath = Join-Path $spawnDir "launch.bat"
$batLines = New-Object System.Collections.ArrayList
[void]$batLines.Add('@echo off')
[void]$batLines.Add("set PATH=$canonicalPath;%PATH%")

# Special case: bot-launcher routes to run_session.bat instead of claude
if ($RoleName -eq "bot-launcher") {
    $gsRoot = "C:\Users\rweis\OneDrive\Documents\GeneralStaff"
    if ($BudgetMinutes -le 0) { $BudgetMinutes = 360 }

    # Inherit OPENROUTER_ENV_FILE from current shell if set; else default to MiroShark
    if (-not $env:OPENROUTER_ENV_FILE) {
        $env:OPENROUTER_ENV_FILE = "C:\Users\rweis\OneDrive\Documents\MiroShark\.env"
    }

    [void]$batLines.Add("set OPENROUTER_ENV_FILE=$($env:OPENROUTER_ENV_FILE)")
    [void]$batLines.Add("cd /d `"$gsRoot`"")
    [void]$batLines.Add("call scripts\run_session.bat $BudgetMinutes")

    # Update status.json with launcher specifics
    $status = @{
        spawn_id = $SpawnId
        role = $RoleName
        spawned_at = (Get-Date).ToUniversalTime().ToString("o")
        spawned_by = "interactive-claude-orchestration"
        cwd = $gsRoot
        state = "running"
        task = "GS bot session, budget $BudgetMinutes min"
        budget_minutes = $BudgetMinutes
        expected_end = (Get-Date).AddMinutes($BudgetMinutes).ToUniversalTime().ToString("o")
        log_dir = "$gsRoot\logs"
        wrapper = "scripts/run_session.bat"
    } | ConvertTo-Json -Depth 4
    [System.IO.File]::WriteAllText((Join-Path $spawnDir "status.json"), $status, [System.Text.UTF8Encoding]::new($false))

    # Also mirror to launches/ for the legacy bot-launcher view
    $launchesDir = Join-Path $orchRoot "launches"
    New-Item -ItemType Directory -Force -Path $launchesDir | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $launchesDir "$SpawnId.json"), $status, [System.Text.UTF8Encoding]::new($false))
} else {
    # Generic claude session spawn
    $claudeArgs = New-Object System.Collections.ArrayList

    if ($Brief) { [void]$claudeArgs.Add("--brief") }
    if (-not [string]::IsNullOrEmpty($Model)) {
        [void]$claudeArgs.Add("--model")
        [void]$claudeArgs.Add($Model)
    }

    # Permission mode - default "auto" so spawned autonomous sessions don't
    # hang waiting for operator clicks in the cmd window. Operator can
    # override via -PermissionMode "default" if they want prompt-on-each-tool.
    if (-not [string]::IsNullOrEmpty($PermissionMode)) {
        [void]$claudeArgs.Add("--permission-mode")
        [void]$claudeArgs.Add($PermissionMode)
    }

    # Build spawn-local settings.json with the heartbeat hook. Stop hook fires
    # at end of every LLM turn, calls spawn-heartbeat.sh which updates
    # status.json's last_heartbeat + transitions starting->active. The
    # SPAWN_STATUS_FILE env tells the hook which file to update.
    $heartbeatScript = Join-Path $PSScriptRoot "spawn-heartbeat.sh"
    $heartbeatBashPath = ($heartbeatScript -replace '\\','/')
    $statusBashPath = ((Join-Path $spawnDir "status.json") -replace '\\','/')
    $spawnSettings = @{
        env = @{
            SPAWN_STATUS_FILE = $statusBashPath
        }
        hooks = @{
            Stop = @(
                @{
                    hooks = @(
                        @{
                            type = "command"
                            command = "bash `"$heartbeatBashPath`""
                        }
                    )
                }
            )
        }
    } | ConvertTo-Json -Depth 8
    $spawnSettingsPath = Join-Path $spawnDir "settings.json"
    Set-Content -Path $spawnSettingsPath -Value $spawnSettings -Encoding utf8

    [void]$claudeArgs.Add("--settings")
    [void]$claudeArgs.Add("`"$spawnSettingsPath`"")

    # Always append the role.md so the spawned session has its operational context
    [void]$claudeArgs.Add("--append-system-prompt-file")
    [void]$claudeArgs.Add("`"$roleMdPath`"")

    if (-not [string]::IsNullOrEmpty($AppendSystemPromptFile)) {
        if (Test-Path $AppendSystemPromptFile) {
            [void]$claudeArgs.Add("--append-system-prompt-file")
            [void]$claudeArgs.Add("`"$AppendSystemPromptFile`"")
        }
    }

    # If the project path is outside the cwd, --add-dir it
    if (-not [string]::IsNullOrEmpty($ProjectPath) -and ($ProjectPath -ne $cwd)) {
        [void]$claudeArgs.Add("--add-dir")
        [void]$claudeArgs.Add("`"$ProjectPath`"")
    }

    # Set Agent Teams env var only for this spawned process if requested
    if ($EnableAgentTeams) {
        [void]$batLines.Add("set CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1")
    }

    # v2: -Provider openrouter routes the spawned `claude` to OpenRouter's
    # Anthropic-compatible API endpoint. This is the simplest "use a non-Anthropic
    # model" path — no CCR proxy required, just three env vars.
    # See: https://openrouter.ai/docs/guides/coding-agents/claude-code-integration
    # CLAUDE_CODE_SUBAGENT_MODEL routes the Agent tool's subagents to the
    # same model so subagent calls don't fall back to Anthropic.
    if ($Provider -eq "openrouter") {
        # Load OPENROUTER_API_KEY from .env file at run time. Mirrors
        # scripts/run_session.bat's :load_openrouter_key subroutine. The MiroShark
        # .env uses the legacy field name OPENAI_API_KEY per CLAUDE.local.md.
        [void]$batLines.Add("REM === v2 OpenRouter provider ===")
        [void]$batLines.Add("if not defined OPENROUTER_API_KEY (")
        [void]$batLines.Add("  if exist `"$OpenRouterEnvFile`" (")
        # Note: cmd's command-substitution backticks (around findstr) must be
        # written as `` in PowerShell here, not just `, because PS interprets
        # `f as form-feed escape. Each `` produces one literal backtick in the
        # output line that cmd then parses correctly.
        [void]$batLines.Add("    for /f `"usebackq tokens=1,* delims==`" %%a in (``findstr /b `"OPENROUTER_API_KEY=`" `"$OpenRouterEnvFile`"``) do set `"OPENROUTER_API_KEY=%%b`"")
        [void]$batLines.Add("    if not defined OPENROUTER_API_KEY (")
        [void]$batLines.Add("      for /f `"usebackq tokens=1,* delims==`" %%a in (``findstr /b `"OPENAI_API_KEY=`" `"$OpenRouterEnvFile`"``) do set `"OPENROUTER_API_KEY=%%b`"")
        [void]$batLines.Add("    )")
        [void]$batLines.Add("  )")
        [void]$batLines.Add(")")
        [void]$batLines.Add("if not defined OPENROUTER_API_KEY (")
        [void]$batLines.Add("  echo ERROR: OPENROUTER_API_KEY not found in env or in $OpenRouterEnvFile")
        [void]$batLines.Add("  echo Spawn cannot proceed without an API key.")
        [void]$batLines.Add("  exit /b 78")
        [void]$batLines.Add(")")
        [void]$batLines.Add("set ANTHROPIC_BASE_URL=https://openrouter.ai/api")
        [void]$batLines.Add("set ANTHROPIC_AUTH_TOKEN=%OPENROUTER_API_KEY%")
        [void]$batLines.Add("set ANTHROPIC_API_KEY=")
        [void]$batLines.Add("set ANTHROPIC_DEFAULT_OPUS_MODEL=$OpenRouterModel")
        [void]$batLines.Add("set ANTHROPIC_DEFAULT_SONNET_MODEL=$OpenRouterModel")
        [void]$batLines.Add("set ANTHROPIC_DEFAULT_HAIKU_MODEL=$OpenRouterModel")
        [void]$batLines.Add("set CLAUDE_CODE_SUBAGENT_MODEL=$OpenRouterModel")
        [void]$batLines.Add("REM === end OpenRouter provider ===")

        # Also annotate status.json so orch-status shows which provider/model.
        # Deferred to the post-Start-Process status write below.
    }

    [void]$batLines.Add("cd /d `"$cwd`"")
    $argsJoined = $claudeArgs -join " "

    # Default initial prompt if none provided — tells the spawn to read its
    # role.md and inbox and begin work. Without an initial user message,
    # interactive claude just waits.
    if ([string]::IsNullOrEmpty($InitialPrompt)) {
        $InitialPrompt = "Read your role context (already loaded as appended system prompt) and the inbox at the mailbox dir. Process the oldest unread inbox message and begin work."
    }

    # The prompt is the last positional argument to `claude`. Quote it for cmd.
    $promptEscaped = '"' + ($InitialPrompt -replace '"','\"') + '"'
    [void]$batLines.Add("claude $argsJoined $promptEscaped")
}

# Append exit-marker step to launch.bat — runs after claude (or run_session.bat)
# returns, regardless of LLM behavior. Provides an independent process-completion
# signal that orch-status can detect even if status.json was never updated.
[void]$batLines.Add("echo {""exit_code"": %ERRORLEVEL%, ""exited_at"": ""%DATE% %TIME%""} > `"$spawnDir\outbox\exit-marker.json`"")

# If -NotifyOnExit, also write a notify-ray.flag that primary's next watch tick
# detects and surfaces via PushNotification. Distinct from needs-ray.md (which
# escalates mid-task); this fires only on terminal exit.
if ($NotifyOnExit) {
    [void]$batLines.Add("echo Spawn $SpawnId exited at %DATE% %TIME% > `"$spawnDir\notify-ray.flag`"")
}

# Write the .bat file
$batLines | Set-Content -Path $batPath -Encoding ascii

# --- Spawn the detached cmd window ------------------------------------------
Write-Output "Spawning: $SpawnId (role=$RoleName, cwd=$cwd)"
Write-Output "Mailbox: $spawnDir"
Write-Output "Launcher: $batPath"

# -PassThru returns the Process object so we can capture cmd's PID. The cmd
# window is the parent of claude / bun. Tracking its PID lets orch-status check
# liveness via Get-Process and orch-kill --force close the window cleanly.
$cmdProc = Start-Process cmd -ArgumentList "/k", "`"$batPath`"" -PassThru
$cmdPid = $cmdProc.Id

# Update status.json with PID + final spawn metadata. Re-read because
# the bot-launcher branch may have rewritten it earlier in this script.
$statusObj = Get-Content -Raw $spawnDir\status.json | ConvertFrom-Json
$statusObj | Add-Member -NotePropertyName 'cmd_pid' -NotePropertyValue $cmdPid -Force
$statusObj | Add-Member -NotePropertyName 'launch_bat' -NotePropertyValue $batPath -Force
$statusObj | Add-Member -NotePropertyName 'notify_on_exit' -NotePropertyValue ([bool]$NotifyOnExit) -Force
$statusObj | Add-Member -NotePropertyName 'provider' -NotePropertyValue $Provider -Force
if ($Provider -eq "openrouter") {
    $statusObj | Add-Member -NotePropertyName 'openrouter_model' -NotePropertyValue $OpenRouterModel -Force
}
$statusObj | ConvertTo-Json -Depth 6 | ForEach-Object { [System.IO.File]::WriteAllText("$spawnDir\status.json", $_, [System.Text.UTF8Encoding]::new($false)) }

# --- Output spawn id for caller capture -------------------------------------
Write-Output ""
Write-Output "SPAWN_ID=$SpawnId"
Write-Output "CMD_PID=$cmdPid"
Write-Output "STATUS_FILE=$spawnDir\status.json"
Write-Output "ROLE_FILE=$roleMdPath"
