# 证明悬浮宠物确实「压在所有窗口之上」：
# 用 WindowFromPoint 查询宠物中心点处的最顶层窗口，看它是不是 PetOverlay。
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class TopMost {
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

    public static string At(int x, int y) {
        POINT p; p.X = x; p.Y = y;
        IntPtr h = WindowFromPoint(p);
        if (h == IntPtr.Zero) return "(没有窗口)";
        // 取根窗口
        IntPtr root = GetAncestor(h, 2 /*GA_ROOT*/);
        if (root != IntPtr.Zero) h = root;
        uint pid; GetWindowThreadProcessId(h, out pid);
        var cls = new StringBuilder(300); GetClassNameW(h, cls, 300);
        var title = new StringBuilder(300); GetWindowTextW(h, title, 300);
        RECT r; GetWindowRect(h, out r);
        string procName = "?";
        try { procName = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { }
        return string.Format("hwnd=0x{0:X8} pid={1}({2}) class='{3}' title='{4}' rect=({5},{6})-({7},{8})",
            h.ToInt64(), pid, procName, cls.ToString(), title.ToString(), r.Left, r.Top, r.Right, r.Bottom);
    }
}
"@

$proc = Get-Process PetOverlay -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { Write-Host "PetOverlay 未在运行"; exit 1 }

# 找到它的窗口矩形
Add-Type -ReferencedAssemblies 'System.Drawing' -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class FindWin {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static IntPtr FindMain(int pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      uint wpid; GetWindowThreadProcessId(h, out wpid);
      if (wpid != (uint)pid || !IsWindowVisible(h)) return true;
      RECT r; GetWindowRect(h, out r);
      if (r.Right - r.Left < 40) return true;
      found = h; return false;
    }, IntPtr.Zero);
    return found;
  }
}
"@

$hwnd = [FindWin]::FindMain($proc.Id)
$rect = New-Object 'FindWin+RECT'
[void][FindWin]::GetWindowRect($hwnd, [ref]$rect)
Write-Host ("PetOverlay 窗口: ({0},{1})-({2},{3})" -f $rect.Left, $rect.Top, $rect.Right, $rect.Bottom)
Write-Host ""

# 宠物在窗口右下角：取窗口内靠右下但仍在宠物圆内的点
$points = @(
    @{ name = '宠物中心';        x = $rect.Right - 64; y = $rect.Bottom - 64 },
    @{ name = '宠物左边缘';      x = $rect.Right - 120; y = $rect.Bottom - 64 },
    @{ name = '窗口左上空白区';  x = $rect.Left + 10;  y = $rect.Top + 10 },
    @{ name = '气泡区域(顶部右侧)'; x = $rect.Right - 40; y = $rect.Top + 20 }
)

foreach ($p in $points) {
    Write-Host ("[{0}] ({1},{2})" -f $p.name, $p.x, $p.y)
    Write-Host ("    -> {0}" -f [TopMost]::At($p.x, $p.y))
}
