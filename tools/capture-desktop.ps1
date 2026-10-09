# 截取整个虚拟桌面到 PNG
#
# 关键：WPF 的 AllowsTransparency=true 窗口是「分层窗口」（WS_EX_LAYERED），
# Graphics.CopyFromScreen 用的是普通 SRCCOPY，**不会**把分层窗口画进去，
# 所以必须自己调 BitBlt 并带上 CAPTUREBLT(0x40000000) 才能截到悬浮宠物。
param(
    [string]$Out = "$env:TEMP\desktop-capture.png"
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies 'System.Drawing' -TypeDefinition @"
using System;
using System.Drawing;
using System.Runtime.InteropServices;

public class ScreenCap {
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int w, int h);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr hdc, IntPtr h);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hdc);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
    [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, int rop);

    const int SRCCOPY = 0x00CC0020;
    const int CAPTUREBLT = 0x40000000;

    public static Bitmap Capture(int x, int y, int w, int h) {
        IntPtr screenDc = GetDC(IntPtr.Zero);
        IntPtr memDc = CreateCompatibleDC(screenDc);
        IntPtr hBmp = CreateCompatibleBitmap(screenDc, w, h);
        IntPtr old = SelectObject(memDc, hBmp);
        BitBlt(memDc, 0, 0, w, h, screenDc, x, y, SRCCOPY | CAPTUREBLT);
        Bitmap bmp = Image.FromHbitmap(hBmp);
        SelectObject(memDc, old);
        DeleteObject(hBmp);
        DeleteDC(memDc);
        ReleaseDC(IntPtr.Zero, screenDc);
        return bmp;
    }
}
"@

$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
Write-Host ("[capture] 捕获 {0}x{1} @ ({2},{3})，含分层窗口" -f $bounds.Width, $bounds.Height, $bounds.X, $bounds.Y)

$bmp = [ScreenCap]::Capture($bounds.X, $bounds.Y, $bounds.Width, $bounds.Height)
try {
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Host "[capture] 已保存 -> $Out"
} finally {
    $bmp.Dispose()
}
