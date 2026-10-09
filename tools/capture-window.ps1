# 用 PrintWindow 直接抓取某个进程主窗口的内容
#
# 为什么不用桌面截图：WPF 的 AllowsTransparency=true 窗口是分层窗口（WS_EX_LAYERED），
# 用 GetDC(NULL)+BitBlt 抓桌面时未必能拿到它的像素。PrintWindow 直接让窗口自己绘制到
# 我们给的 DC 上，可以确定性地验证「窗口到底渲染出什么」。
param(
    [string]$Process = 'PetOverlay',
    [string]$Out = "$env:TEMP\window-capture.png"
)

Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies 'System.Drawing' -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;

public class WinCap {
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

    public static IntPtr FindMain(int targetPid) {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr h, IntPtr p) {
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (pid != (uint)targetPid) return true;
            if (!IsWindowVisible(h)) return true;
            RECT r; GetWindowRect(h, out r);
            if (r.Right - r.Left < 40 || r.Bottom - r.Top < 40) return true;
            found = h; return false;
        }, IntPtr.Zero);
        return found;
    }

    public static Bitmap Capture(IntPtr hwnd, uint flags, out bool ok) {
        RECT r; GetWindowRect(hwnd, out r);
        int w = r.Right - r.Left, h = r.Bottom - r.Top;
        Bitmap bmp = new Bitmap(w, h);
        using (Graphics g = Graphics.FromImage(bmp)) {
            IntPtr hdc = g.GetHdc();
            ok = PrintWindow(hwnd, hdc, flags);
            g.ReleaseHdc(hdc);
        }
        return bmp;
    }
}
"@

$proc = Get-Process $Process -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { Write-Host "$Process 未在运行"; exit 1 }

$hwnd = [WinCap]::FindMain($proc.Id)
if ($hwnd -eq [IntPtr]::Zero) { Write-Host "没找到可见的顶层窗口"; exit 1 }
Write-Host ("[wincap] hwnd=0x{0:X8}" -f $hwnd.ToInt64())

foreach ($flag in @(2, 0)) {
    $ok = $false
    $bmp = [WinCap]::Capture($hwnd, [uint32]$flag, [ref]$ok)
    $suffix = if ($flag -eq 2) { 'renderfull' } else { 'plain' }
    $path = $Out -replace '\.png$', "-$suffix.png"
    try {
        $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
        Write-Host ("[wincap] flags={0} ok={1} size={2}x{3} -> {4}" -f $flag, $ok, $bmp.Width, $bmp.Height, $path)
    } finally { $bmp.Dispose() }
}
