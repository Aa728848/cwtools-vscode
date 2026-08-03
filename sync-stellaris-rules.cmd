@echo off
setlocal
if not "%~1"=="" goto run

:menu
set "MODE="
echo Select Stellaris rules sync mode:
echo   1. scan   - generate rules.generated.json and CWT candidates
echo   2. check  - generate and compare with current config
echo   3. update - generate append-only candidates for review
echo   4. report - visual HTML comparison report (opens in browser, auto-merges Shader ABI)
echo   Q. quit
choice /C 1234Q /N /M "Choose 1, 2, 3, 4, or Q: "
if "%ERRORLEVEL%"=="5" exit /b 0
if "%ERRORLEVEL%"=="4" set "MODE=report"
if "%ERRORLEVEL%"=="3" set "MODE=update"
if "%ERRORLEVEL%"=="2" set "MODE=check"
if "%ERRORLEVEL%"=="1" set "MODE=scan"
node "%~dp0tools\rules-sync\stellaris-rules-sync.js" %MODE%
set "LAST_SYNC_EXIT=%ERRORLEVEL%"
echo.
echo Completed with exit code %LAST_SYNC_EXIT%.
echo Returning to menu. Press Q to quit.
echo.
goto menu

:run
node "%~dp0tools\rules-sync\stellaris-rules-sync.js" %*
exit /b %ERRORLEVEL%
