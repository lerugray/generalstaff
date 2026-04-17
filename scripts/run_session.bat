@echo off
REM GeneralStaff — session launcher (Windows)
REM
REM Usage:
REM   scripts\run_session.bat               (6 hour default)
REM   scripts\run_session.bat 300           (5 hour override)
REM
REM Runs `generalstaff session --budget=<min>` synchronously, tees output
REM to logs/session_<ts>.log, then writes digests/LAST_RUN.md as a pointer
REM to the log + timestamped digest written by session.ts.
REM
REM Locale-safe timestamps via PowerShell. For Task Scheduler automation,
REM register this .bat with: "Start in" = the GeneralStaff project root,
REM and ensure bun + git + claude are on the task's PATH (see INDEX.md
REM for the Task Scheduler setup notes once we validate a manual run).

setlocal enabledelayedexpansion

set "PROJECT_ROOT=C:\Users\rweis\OneDrive\Documents\GeneralStaff"
set "BUDGET=%~1"
if "%BUDGET%"=="" set "BUDGET=360"

cd /d "%PROJECT_ROOT%" || (
  echo ERROR: project root not found: %PROJECT_ROOT%
  exit /b 1
)

if not exist logs mkdir logs
if not exist digests mkdir digests

for /f %%i in ('powershell -nologo -command "Get-Date -Format yyyyMMdd_HHmmss"') do set "TS=%%i"
set "LOG=logs\session_%TS%.log"

REM Route the reviewer agent to OpenRouter Qwen (validated 2026-04-16,
REM 4/4 verdict agreement with claude -p on tonight's cycle samples).
REM Remove or set to "claude" to fall back to claude -p.
set "GENERALSTAFF_REVIEWER_PROVIDER=openrouter"

REM Load the OpenRouter API key from Ray's provider .env. The key is
REM stored under OPENAI_API_KEY (OpenRouter uses OpenAI-compatible
REM auth, and the field was named before this routing existed).
REM Scoped to this subprocess; not exported session-wide.
set "PROVIDER_ENV=C:\Users\rweis\OneDrive\Documents\MiroShark\.env"
for /f "usebackq tokens=1,* delims==" %%a in (`findstr /b "OPENAI_API_KEY=" "%PROVIDER_ENV%"`) do set "OPENROUTER_API_KEY=%%b"
if "%OPENROUTER_API_KEY%"=="" (
  echo WARNING: OPENROUTER_API_KEY not found at %PROVIDER_ENV% — reviewer
  echo          will fall through to a 'REVIEWER ERROR' string and every
  echo          cycle will fail-safe to verification_failed. Either
  echo          provision the key or unset GENERALSTAFF_REVIEWER_PROVIDER
  echo          above to fall back to claude -p.
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

endlocal & exit /b %EXITCODE%
