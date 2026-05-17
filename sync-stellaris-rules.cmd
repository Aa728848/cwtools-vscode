@echo off
setlocal
if not "%~1"=="" goto run

echo Select Stellaris rules sync mode:
echo   1. scan   - generate rules.generated.json and CWT candidates
echo   2. check  - generate and compare with current config
echo   3. update - generate append-only candidates for review
choice /C 123 /N /M "Choose 1, 2, or 3: "
if errorlevel 3 set "MODE=update"
if errorlevel 2 set "MODE=check"
if errorlevel 1 set "MODE=scan"
node "%~dp0tools\rules-sync\stellaris-rules-sync.js" %MODE%
exit /b %ERRORLEVEL%

:run
node "%~dp0tools\rules-sync\stellaris-rules-sync.js" %*
exit /b %ERRORLEVEL%
