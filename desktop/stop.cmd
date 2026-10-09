@echo off
REM ===========================================================================
REM  Stop the Ghibli desktop pet overlay
REM
REM  You can also right-click the pet and choose the quit item.
REM  The Node backend keeps running - go to its window and press Ctrl+C to
REM  stop that too.
REM
REM  ASCII-only on purpose - see start.cmd for why.
REM ===========================================================================
taskkill /IM PetOverlay.exe /F >nul 2>&1
if errorlevel 1 (
    echo [pet] The desktop pet is not running.
) else (
    echo [pet] Desktop pet stopped. The backend is unaffected.
)
