@echo off
REM ===========================================================================
REM  启动 / 召唤「吉卜力桌面宠物」悬浮层
REM
REM  这个 exe 是一个真正的置顶透明窗口，会悬浮在桌面与所有网页之上：
REM    - 按住宠物可以拖动
REM    - 鼠标右键有菜单（回到右下角 / 让它说一句 / 退出桌面宠物）
REM    - 宠物之外的空白区域鼠标穿透，不会挡住底下的窗口
REM    - 后端连不上时会显示「离线」小角标（宠物本身不受影响）
REM
REM  如果宠物已经在运行，再执行一次本脚本不会多出一只，
REM  而是把已经存在的那只唤回屏幕右下角并置顶。
REM ===========================================================================
setlocal
cd /d "%~dp0"

REM ---- 1. 先确认后端在不在 ----
powershell -NoProfile -Command "$c = New-Object Net.Sockets.TcpClient; try { $c.Connect('127.0.0.1', 8787); exit 0 } catch { exit 1 } finally { $c.Dispose() }" >nul 2>&1
if errorlevel 1 (
    echo.
    echo [pet] 警告：后端似乎没有在运行（127.0.0.1:8787 连不上）
    echo [pet] 桌面宠物仍然会出现，但会显示灰色的「离线」角标，且无法换宠物 / 说话。
    echo.
    choice /C YN /N /M "[pet] 要现在帮你启动后端吗？(Y/N) "
    if errorlevel 2 goto :skip_backend
    echo [pet] 正在新窗口启动后端...
    start "吉卜力桌宠-后端" cmd /k "cd /d "%~dp0.." && npm start"
    echo [pet] 等待后端就绪...
    timeout /t 5 >nul
)
:skip_backend

REM ---- 2. 必要时编译 ----
if not exist "PetOverlay.exe" (
    echo [pet] 未找到 PetOverlay.exe，正在编译...
    powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0build.ps1"
    if errorlevel 1 (
        echo [pet] 编译失败
        pause
        exit /b 1
    )
)

REM ---- 3. 启动（已有实例时会唤回它）----
echo [pet] 启动桌面宠物悬浮层...
echo [pet] 提示：右键宠物可打开菜单；重复运行本脚本 = 把它唤回右下角。
start "" "%~dp0PetOverlay.exe" --api http://127.0.0.1:8787
endlocal
