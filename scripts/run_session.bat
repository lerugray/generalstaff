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

REM Resolve PROJECT_ROOT relative to this script's location — %~dp0 is
REM the directory containing the .bat, so scripts\..  is the repo root.
REM Users can override by setting PROJECT_ROOT in their environment
REM before launching this script.
if "%PROJECT_ROOT%"=="" set "PROJECT_ROOT=%~dp0.."

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

REM Export the log path so session.ts can include it in its end-of-session
REM Telegram notification (see src/notify.ts).
set "GENERALSTAFF_SESSION_LOG=%LOG%"

REM Provider-specific credential loading. OpenRouter needs an API key;
REM Ollama and claude need nothing (ollama talks to localhost:11434,
REM claude -p uses its own subscription auth).
REM
REM Precedence for OPENROUTER_API_KEY:
REM   1. Already set in the environment — used as-is
REM   2. OPENROUTER_ENV_FILE points at a .env-style file containing
REM      "OPENROUTER_API_KEY=..." or "OPENAI_API_KEY=..." — first match wins
REM   3. Default path %USERPROFILE%\.generalstaff\.env if it exists
REM   4. Missing — loud warning, cycles fail-safe to verification_failed
REM
REM Loading is factored through `call :load_openrouter_key` so each
REM env-file check runs in a fresh subroutine scope. This sidesteps a
REM cmd.exe delayed-expansion quirk where nested `for /f ... do set`
REM inside `if (...)` blocks produced a false-positive warning even
REM when loading succeeded (observed 2026-04-19, multiple sessions).
REM
REM Scoped to this subprocess; not exported session-wide.
if /i "%PROVIDER%"=="openrouter" (
  if not defined OPENROUTER_API_KEY call :load_openrouter_key
  if not defined OPENROUTER_API_KEY call :warn_openrouter_missing
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

REM End-of-session Telegram notification is now fired from session.ts
REM itself (src/notify.ts) so any launcher path — including this .bat
REM when spawned in a detached context — produces the notification.
REM The legacy scripts\notify_telegram.ps1 script is still around for
REM manual re-sends but is no longer invoked automatically here.

endlocal & exit /b %EXITCODE%

REM === Subroutines (reached only via `call :label`) ===
REM Placed after `exit /b` so main flow never falls through into them.

:load_openrouter_key
REM Try user-specified OPENROUTER_ENV_FILE first
if defined OPENROUTER_ENV_FILE (
  if exist "%OPENROUTER_ENV_FILE%" (
    call :parse_env_file "%OPENROUTER_ENV_FILE%"
    if defined OPENROUTER_API_KEY goto :eof
  )
)
REM Fall back to default path at %USERPROFILE%\.generalstaff\.env
if exist "%USERPROFILE%\.generalstaff\.env" (
  call :parse_env_file "%USERPROFILE%\.generalstaff\.env"
)
goto :eof

:parse_env_file
REM Arg %1: quoted path to a .env-style file. Sets OPENROUTER_API_KEY
REM from the first matching line. Prefers OPENROUTER_API_KEY=... over
REM OPENAI_API_KEY=... (the MiroShark .env uses the latter name).
for /f "usebackq tokens=1,* delims==" %%a in (`findstr /b "OPENROUTER_API_KEY=" %1`) do set "OPENROUTER_API_KEY=%%b"
if not defined OPENROUTER_API_KEY (
  for /f "usebackq tokens=1,* delims==" %%a in (`findstr /b "OPENAI_API_KEY=" %1`) do set "OPENROUTER_API_KEY=%%b"
)
goto :eof

:warn_openrouter_missing
echo WARNING: OPENROUTER_API_KEY not set and no .env file found.
echo          Checked:
if defined OPENROUTER_ENV_FILE (
  echo            - OPENROUTER_ENV_FILE = %OPENROUTER_ENV_FILE%
) else (
  echo            - OPENROUTER_ENV_FILE is unset
)
echo            - %USERPROFILE%\.generalstaff\.env
echo          Reviewer will return 'REVIEWER ERROR' every cycle and
echo          fail-safe to verification_failed. Either:
echo            set OPENROUTER_API_KEY=sk-or-...
echo            set OPENROUTER_ENV_FILE=C:\path\to\.env
echo            create %USERPROFILE%\.generalstaff\.env with OPENROUTER_API_KEY=...
echo          Or pass a different provider:
echo            scripts\run_session.bat %BUDGET% ollama
echo            scripts\run_session.bat %BUDGET% claude
goto :eof
