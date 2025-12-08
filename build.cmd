@echo off
cls

dotnet tool restore
REM Ensure git submodules (cwtools) are available when not using a local override
git submodule update --init --recursive

dotnet run --project build -- -t %*
