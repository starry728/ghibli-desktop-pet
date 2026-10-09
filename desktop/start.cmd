@echo off
REM ===========================================================================
REM  Start / summon the Ghibli desktop pet overlay
REM
REM  * Requires the backend to be running:  npm start
REM    (run it from the project folder, in another terminal)
REM  * If the pet is already running, running this again will NOT create a
REM    second one - it signals the existing instance to return to the
REM    bottom-right corner of the screen.
REM
REM  NOTE: this file is intentionally ASCII-only. cmd.exe parses .cmd files
REM  using the system ANSI codepage (GBK on Chinese Windows), so UTF-8 Chinese
REM  text in here would become mojibake and break the script.
REM ===========================================================================
setlocal
cd /d "%~dp0"

REM --- quick check: is the backend listening on 8787? ---
powershell -NoProfile -Command "$c=New-Object Net.Sockets.TcpClient; try { $c.Connect('127.0.0.1',8787); exit 0 } catch { exit 1 } finally { $c.Dispose() }" >nul 2>&1
if errorlevel 1 (
    echo.
    echo [pet] WARNING: no backend on 127.0.0.1:8787
    echo [pet] The pet will still show up, but with a grey "offline" badge,
    echo [pet] and it cannot switch pets or speak.
    echo [pet] Start the backend first, from the project folder:  npm start
    echo.
)

if not exist "PetOverlay.exe" (
    echo [pet] PetOverlay.exe not found - building it with the system csc.exe ...
    powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0build.ps1"
    if errorlevel 1 (
        echo [pet] Build failed.
        pause
        exit /b 1
    )
)

echo [pet] Starting the desktop pet overlay ...
start "" "%~dp0PetOverlay.exe" --api http://127.0.0.1:8787
endlocal
