# Foreground window probe (Windows).
#
# NOT the collector. The product's collector is Rust behind ActiveWindowProvider (ADR 0002 D-11), is
# event-driven via SetWinEventHook, and writes to SQLite. This is a throwaway measurement rig whose
# only job is to produce real window titles so anchor extraction can be validated against reality
# instead of against fixtures we authored ourselves (ticket P0-005 risk note).
#
# It polls, which the real collector must not do (§91). At one second on a struct read the cost is
# negligible and the simplicity is worth it for a probe.
#
# Emits one JSON object per line on stdout. Writes nothing to disk.

$ErrorActionPreference = 'Stop'

# Without this, "Comptabilité" and "Pépithèque" arrive as "Comptabilit?" and anchor matching fails
# on exactly the titles this user's work produces.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public class RewindProbe {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern int GetWindowTextLengthW(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [DllImport("kernel32.dll")] public static extern uint GetTickCount();

  public static string Title(IntPtr h) {
    int len = GetWindowTextLengthW(h);
    if (len <= 0) return "";
    StringBuilder sb = new StringBuilder(len + 1);
    GetWindowTextW(h, sb, sb.Capacity);
    return sb.ToString();
  }

  public static uint IdleMs() {
    LASTINPUTINFO lii = new LASTINPUTINFO();
    lii.cbSize = (uint)Marshal.SizeOf(lii);
    if (!GetLastInputInfo(ref lii)) return 0;
    return GetTickCount() - lii.dwTime;
  }
}
'@

$lastKey = ''

while ($true) {
  try {
    $h = [RewindProbe]::GetForegroundWindow()
    if ($h -ne [IntPtr]::Zero) {
      $title = [RewindProbe]::Title($h)
      $procId = 0
      [void][RewindProbe]::GetWindowThreadProcessId($h, [ref]$procId)

      $exe = 'unknown'
      try {
        $proc = Get-Process -Id $procId -ErrorAction Stop
        $exe = $proc.ProcessName
      } catch {}

      $idle = [RewindProbe]::IdleMs()
      $key = "$exe|$title"

      # Emit only on change, plus a heartbeat so the consumer can close spans and see idleness.
      if ($key -ne $lastKey) {
        $lastKey = $key
        $obj = [ordered]@{
          t      = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
          kind   = 'focus'
          pid    = $procId
          exe    = $exe
          title  = $title
          idleMs = [long]$idle
        }
        Write-Output ($obj | ConvertTo-Json -Compress)
      } elseif ($idle -gt 60000) {
        $obj = [ordered]@{
          t      = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
          kind   = 'idle'
          idleMs = [long]$idle
        }
        Write-Output ($obj | ConvertTo-Json -Compress)
      }
    }
  } catch {
    # A probe must never die on one bad read — but a silent catch hides real bugs, so say so.
    [Console]::Error.WriteLine("probe: " + $_.Exception.Message)
  }
  Start-Sleep -Milliseconds 1000
}
