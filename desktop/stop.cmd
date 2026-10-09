@echo off
REM ===========================================================================
REM  关闭「吉卜力桌面宠物」悬浮层
REM
REM  也可以直接右键宠物 → 退出桌面宠物。
REM  注意：这只会关掉桌面上的宠物窗口，不会关掉后端（npm start 那个终端）。
REM ===========================================================================
setlocal

tasklist /FI "IMAGENAME eq PetOverlay.exe" 2>nul | find /I "PetOverlay.exe" >nul
if errorlevel 1 (
    echo [pet] 桌面宠物当前没有在运行。
) else (
    taskkill /IM PetOverlay.exe /F >nul 2>&1
    if errorlevel 1 (
        echo [pet] 关闭失败，请手动右键宠物选择「退出桌面宠物」。
    ) else (
        echo [pet] 桌面宠物已关闭。
    )
)

echo.
echo [提示] 后端（npm start）不受影响，仍在运行。
echo [提示] 想再召唤出来，双击 start.cmd 或执行 npm run pet。
endlocal
