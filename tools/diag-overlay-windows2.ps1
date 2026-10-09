# 枚举 PetOverlay 进程的所有顶层窗口（而不是依赖 MainWindowHandle 启发式）
Add-Type -ReferencedAssemblies 'System.Drawing' -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class WinEnum {
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

    public static List<string> ForProcess(int targetPid) {
        var list = new List<string>();
        EnumWindows(delegate(IntPtr h, IntPtr p) {
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (pid != (uint)targetPid) return true;
            RECT r; GetWindowRect(h, out r);
            var title = new StringBuilder(512); GetWindowTextW(h, title, 512);
            var cls = new StringBuilder(512); GetClassNameW(h, cls, 512);
            int style = GetWindowLong(h, -16), ex = GetWindowLong(h, -20);
            list.Add(string.Format(
                "hwnd=0x{0:X8} visible={1} parent=0x{2:X8} owner?=0x{3:X8}\n" +
                "   class='{4}'  title='{5}'\n" +
                "   rect=({6},{7})-({8},{9}) size={10}x{11}\n" +
                "   style=0x{12:X8} exstyle=0x{13:X8}  [WS_VISIBLE={14} WS_EX_TOPMOST={15} WS_EX_LAYERED={16} WS_EX_TOOLWINDOW={17} WS_EX_TRANSPARENT={18}]",
                h.ToInt64(), IsWindowVisible(h), 0, GetParent(h).ToInt64(),
                cls.ToString(), title.ToString(),
                r.Left, r.Top, r.Right, r.Bottom, r.Right - r.Left, r.Bottom - r.Top,
                style, ex,
                (style & 0x10000000) != 0, (ex & 0x00000008) != 0, (ex & 0x00080000) != 0,
                (ex & 0x00000080) != 0, (ex & 0x00000020) != 0));
            return true;
        }, IntPtr.Zero);
        return list;
    }
}
"@

$procs = Get-Process PetOverlay -ErrorAction SilentlyContinue
if (-not $procs) { Write-Host "PetOverlay 未在运行"; exit 1 }

foreach ($p in $procs) {
    Write-Host ("=== 进程 {0} 的顶层窗口 ===" -f $p.Id)
    $wins = [WinEnum]::ForProcess($p.Id)
    if ($wins.Count -eq 0) { Write-Host "  (没有任何顶层窗口)" }
    foreach ($w in $wins) { Write-Host $w }
}
