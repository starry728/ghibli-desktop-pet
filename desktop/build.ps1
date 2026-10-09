# ============================================================================
#  编译桌面宠物悬浮层（PetOverlay.exe）
#
#  只用 Windows 自带的 .NET Framework 编译器，不需要安装任何东西。
#  WPF 程序集位于 Framework 目录的 WPF\ 子目录下。
#
#  用法：
#    powershell -ExecutionPolicy Bypass -File desktop\build.ps1
#    powershell -ExecutionPolicy Bypass -File desktop\build.ps1 -Run
#    powershell -ExecutionPolicy Bypass -File desktop\build.ps1 -Run -Force   # 强制重新编译
# ============================================================================
param(
    [switch]$Run,
    [switch]$Force,
    [string]$Api = 'http://127.0.0.1:8787',
    [string]$Pet = ''
)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Definition
$out  = Join-Path $here 'PetOverlay.exe'
$src  = Join-Path $here 'PetOverlay.cs'

# ---- 0. 增量编译：源码没变就不重编 ----
# 这一条很重要：桌宠正在运行时 PetOverlay.exe 是被占用的，
# 如果每次 npm run pet 都无脑重编，会直接报「无法写入输出文件」而失败。
if ((Test-Path $out) -and (Test-Path $src) -and (-not $Force)) {
    $exeTime = (Get-Item $out).LastWriteTimeUtc
    $srcTime = (Get-Item $src).LastWriteTimeUtc
    $running = Get-Process PetOverlay -ErrorAction SilentlyContinue
    if ($srcTime -le $exeTime) {
        $why = if ($running) { '桌宠正在运行，跳过编译' } else { '源码未改动' }
        Write-Host "[build] $why，直接使用现有 PetOverlay.exe" -ForegroundColor DarkGray
        Write-Host ("[build] 产物 -> " + $out) -ForegroundColor Green

        if ($Run) {
            $runArgs = @('--api', $Api)
            if ($Pet) { $runArgs += @('--pet', $Pet) }
            Write-Host '[build] 启动悬浮宠物…'
            try {
                Start-Process -FilePath $out -ArgumentList $runArgs -WorkingDirectory $here | Out-Null
            } catch {
                # 已有实例时新进程会秒退（只负责唤醒老实例），
                # PowerShell 对秒退进程可能误报 ERROR_CANCELLED，属于预期内。
                Write-Host '[build] （新实例已退出：桌宠本来就在运行，它只是去唤醒那只）' -ForegroundColor DarkGray
            }
        }
        exit 0
    }
}

# ---- 1. 定位 csc.exe ----
$cscCandidates = @(
    "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
    "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)
$csc = $cscCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) {
    Write-Error "找不到 csc.exe，请确认已安装 .NET Framework 4.x"
}
$fwDir = Split-Path -Parent $csc
$wpfDir = Join-Path $fwDir 'WPF'

Write-Host "[build] 编译器 : $csc"
Write-Host "[build] 源码   : $src"

# ---- 2. 定位 WPF / 其它程序集 ----
function Resolve-Asm([string]$name) {
    foreach ($dir in @($wpfDir, $fwDir)) {
        $p = Join-Path $dir $name
        if (Test-Path $p) { return $p }
    }
    return $null
}

$refNames = @(
    'WindowsBase.dll',
    'PresentationCore.dll',
    'PresentationFramework.dll',
    'System.Xaml.dll',
    'System.Web.Extensions.dll'
)
$refs = @()
foreach ($n in $refNames) {
    $p = Resolve-Asm $n
    if (-not $p) { Write-Error "找不到程序集 $n" }
    $refs += "/r:`"$p`""
    Write-Host "[build] 引用   : $p"
}

# ---- 3. 编译 ----
$cscArgs = @(
    '/nologo',
    '/target:winexe',
    # csc 4.x 只支持 C# 5，源码已按 C# 5 书写
    '/langversion:5',
    '/optimize+',
    "/out:`"$out`"",
    '/main:PetOverlay.Program'
) + $refs + @("`"$src`"")

Write-Host "[build] 编译中…"
& $csc @cscArgs
if ($LASTEXITCODE -ne 0) {
    # 最常见的原因：桌宠正在运行 → PetOverlay.exe 被占用，写不进去
    $running = Get-Process PetOverlay -ErrorAction SilentlyContinue
    if ($running) {
        Write-Host ("[build] 编译失败：桌宠正在运行（PID " + $running.Id + "），PetOverlay.exe 被占用。") -ForegroundColor Red
        Write-Host '[build] 请先关掉桌宠再重试：右键宠物 → 退出桌面宠物，或运行 desktop\stop.cmd' -ForegroundColor Yellow
    }
    Write-Error "编译失败（退出码 $LASTEXITCODE）"
}

$size = [math]::Round((Get-Item $out).Length / 1KB, 1)
Write-Host "[build] 成功 -> $out  ($size KB)" -ForegroundColor Green

# ---- 4. 可选：直接运行 ----
if ($Run) {
    $runArgs = @("--api", $Api)
    if ($Pet) { $runArgs += @('--pet', $Pet) }
    Write-Host "[build] 启动悬浮宠物…"
    try {
        Start-Process -FilePath $out -ArgumentList $runArgs -WorkingDirectory $here | Out-Null
    } catch {
        # 已有实例时新进程会秒退（只负责唤醒老实例），
        # PowerShell 对秒退进程可能误报 ERROR_CANCELLED，属于预期内。
        Write-Host '[build] （新实例已退出：桌宠本来就在运行，它只是去唤醒那只）' -ForegroundColor DarkGray
    }
}
