@echo off
REM GeneralStaff — session launcher (Windows)
REM
REM Usage:
REM   scripts\run_session.bat                   (6 hr, openrouter reviewer)
REM   scripts\run_session.bat 300               (5 hr, openrouter reviewer)
REM   scripts\run_session.bat 90 ollama         (90 min, local Ollama reviewer)
REM   scripts\run_session.bat 120 claude        (2 hr, fallback to claude -p)
REM
REM Runs `generalstaff session --budget=<min>` synchronously, tees output
REM to logs/session_<ts>.log, then writes digests/LAST_RUN.md as a pointer
REM to the log + timestamped digest written by session.ts.
REM
REM Reviewer providers:
REM   openrouter — Qwen3 Coder via OpenRouter (paid, ~$0.02/session; default)
REM   ollama     — local Ollama server, qwen3:8b by default (free, offline)
REM   claude     — claude -p (highest quality but uses Claude quota)
REM
REM Locale-safe timestamps via PowerShell. For Task Scheduler automation,
REM register this .bat with: "Start in" = the GeneralStaff project root,
REM and ensure bun + git + claude are on the task's PATH (see INDEX.md
REM for the Task Scheduler setup notes once we validate a manual run).

setlocal enabledelayedexpansion

set "PROJECT_ROOT=C:\Users\rweis\OneDrive\Documents\GeneralStaff"
set "BUDGET=%~1"
if "%BUDGET%"=="" set "BUDGET=360"

set "PROVIDER=%~2"
if "%PROVIDER%"=="" set "PROVIDER=openrouter"
set "GENERALSTAFF_REVIEWER_PROVIDER=%PROVIDER%"

REM Ensure Git Bash, bun, and claude are on PATH. When launched via
REM Explorer double-click (or Task Scheduler), the inherited PATH may
REM not include these tools even though they're in the terminal PATH.
REM Front-loading them makes the .bat work identically from any launcher.
set "PATH=C:\Program Files\Git\bin;C:\Program Files\Git\usr\bin;%USERPROFILE%\.bun\bin;%USERPROFILE%\.local\bin;%APPDATA%\npm;%PATH%"

cd /d "%PROJECT_ROOT%" || (
  echo ERROR: project root not found: %PROJECT_ROOT%
  exit /b 1
)

if not exist logs mkdir logs
if not exist digests mkdir digests

for /f %%i in ('powershell -nologo -command "Get-Date -Format yyyyMMdd_HHmmss"') do set "TS=%%i"
set "LOG=logs\session_%TS%.log"

REM Provider-specific credential loading. OpenRouter needs an API key
REM from Ray's shared provider .env (stored under OPENAI_API_KEY — that
REM field name predates this routing). Ollama and claude need nothing:
REM ollama talks to localhost:11434, claude -p uses its own subscription
REM auth. Scoped to this subprocess; not exported session-wide.
if /i "%PROVIDER%"=="openrouter" (
  set "PROVIDER_ENV=C:\Users\rweis\OneDrive\Documents\MiroShark\.env"
  for /f "usebackq tokens=1,* delims==" %%a in (`findstr /b "OPENAI_API_KEY=" "!PROVIDER_ENV!"`) do set "OPENROUTER_API_KEY=%%b"
  if "!OPENROUTER_API_KEY!"=="" (
    echo WARNING: OPENROUTER_API_KEY not found at !PROVIDER_ENV! — reviewer
    echo          will fall through to a 'REVIEWER ERROR' string and every
    echo          cycle will fail-safe to verification_failed. Either
    echo          provision the key or pass a different provider, e.g.:
    echo            scripts\run_session.bat %BUDGET% ollama
    echo            scripts\run_session.bat %BUDGET% claude
  )
)

echo === GeneralStaff session launcher ===
echo Root:     %PROJECT_ROOT%
echo Started:  %TS%
echo Budget:   %BUDGET% min
echo Reviewer: %GENERALSTAFF_REVIEWER_PROVIDER%
echo Log:      %LOG%
echo ======================================
echo.

(
  echo === GeneralStaff session launcher ===
  echo Root:     %PROJECT_ROOT%
  echo Started:  %TS%
  echo Budget:   %BUDGET% min
  echo Reviewer: %GENERALSTAFF_REVIEWER_PROVIDER%
  echo Log:      %LOG%
  echo ======================================
  echo.
) > "%LOG%"

bun src/cli.ts session --budget=%BUDGET% >> "%LOG%" 2>&1
set "EXITCODE=%ERRORLEVEL%"

for /f %%i in ('powershell -nologo -command "Get-Date -Format yyyy-MM-ddTHH:mm:ssK"') do set "ENDTS=%%i"

(
  echo # GeneralStaff --- last run
  echo.
  echo **Ended:** %ENDTS%
  echo **Exit code:** %EXITCODE%
  echo **Budget:** %BUDGET% min
  echo **Log:** `%LOG%`
  echo.
  echo See the timestamped digest in `digests/` for the per-cycle breakdown.
) > "digests\LAST_RUN.md"

echo.
echo === Session ended ===
echo Exit code: %EXITCODE%
echo Log:       %LOG%
echo Summary:   digests\LAST_RUN.md

REM Fire an end-of-session Telegram notification. Non-fatal: the script
REM bails quietly if the bot token / chat_id aren't reachable, so an
REM unrelated config issue never crashes a session.
powershell -nologo -noprofile -ExecutionPolicy Bypass -File "scripts\notify_telegram.ps1" -ExitCode "%EXITCODE%" -BudgetMin "%BUDGET%" -LogPath "%LOG%" -DigestDir "digests"

endlocal & exit /b %EXITCODE%
