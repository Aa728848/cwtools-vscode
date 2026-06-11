@echo off
setlocal
if not "%~1"=="" goto run

:menu
set "MODE="
echo Select Stellaris rules sync mode:
echo   1. scan   - generate rules.generated.json and CWT candidates
echo   2. check  - generate and compare with current config
echo   3. update - generate append-only candidates for review
echo   4. report - visual HTML comparison report (opens in browser)
echo   Q. quit
choice /C 1234Q /N /M "Choose 1, 2, 3, 4, or Q: "
if errorlevel 5 exit /b 0
if errorlevel 4 set "MODE=report"
if errorlevel 3 set "MODE=update"
if errorlevel 2 set "MODE=check"
if errorlevel 1 set "MODE=scan"
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
