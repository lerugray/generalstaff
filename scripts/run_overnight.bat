@echo off
REM GeneralStaff overnight launcher -- double-click safe.
REM
REM Spawns run_session.bat in a detached, minimized window so you can
REM close this one (or your Claude Code session) and the run continues.
REM Telegram notification fires on completion regardless of whether
REM this window is still open.
REM
REM Usage:
REM   Double-click this file in Explorer, or
REM   scripts\run_overnight.bat                (120 min, openrouter reviewer)
REM   scripts\run_overnight.bat 180            (3 hr, openrouter reviewer)
REM   scripts\run_overnight.bat 90 ollama      (90 min, local Ollama reviewer)

setlocal

set "BUDGET=%~1"
if "%BUDGET%"=="" set "BUDGET=120"

set "PROVIDER=%~2"
if "%PROVIDER%"=="" set "PROVIDER=openrouter"

set "PROJECT_ROOT=C:\Users\rweis\OneDrive\Documents\GeneralStaff"
cd /d "%PROJECT_ROOT%" || (
  echo ERROR: project root not found: %PROJECT_ROOT%
  pause
  exit /b 1
)

echo =============================================
echo   GeneralStaff overnight launcher
echo =============================================
echo   Budget:   %BUDGET% min
echo   Reviewer: %PROVIDER%
echo   Started:  %date% %time%
echo.
echo   This launcher closes in a few seconds.
echo   The session runs in a minimized background
echo   window. You will get a Telegram ping on
echo   your phone when it finishes.
echo.
echo   To stop early: find the minimized window
echo   titled "GeneralStaff overnight" and close
echo   it, or run:
echo     generalstaff stop
echo =============================================

REM Spawn run_session.bat in a new, minimized, detached window.
REM /B would keep it attached to this console; we want it free.
start "GeneralStaff overnight" /MIN cmd /c "scripts\run_session.bat %BUDGET% %PROVIDER%"

REM Give the spawned process a moment to initialize before the
REM launcher window closes.
timeout /t 4 /nobreak > nul
endlocal
