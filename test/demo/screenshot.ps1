# Takes docs/vscode.png: a real VS Code window with the extension (installed from the .vsix)
# and the made-up "webshop" project of test/demo/setup.js. Runs in a throw-away profile; your
# normal VS Code setup is not touched. The window shows up on the screen for a few seconds.
param(
  [string]$WorkDir = (Join-Path $env:TEMP ("ccg-demo-" + [guid]::NewGuid().ToString('N').Substring(0, 8))),
  [string]$Code = (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\Code.exe'),
  [string]$Vsix = '',
  [string]$Out = '',
  # Window size in screen pixels, the VS Code zoom level (2.2239 = 150 %) and how many times
  # the side bar is widened from its narrowest (60 px each).
  [int]$Width = 1650,
  [int]$Height = 1050,
  [double]$Zoom = 2.2239,
  [int]$Widen = 3
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $Vsix) { $Vsix = Get-ChildItem $repo -Filter '*.vsix' | Sort-Object LastWriteTime | Select-Object -Last 1 -ExpandProperty FullName }
if (-not $Out) { $Out = Join-Path $repo 'docs\vscode.png' }

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
public static class Win {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT rect, int size);
  public static Bitmap Capture(IntPtr hwnd) {
    RECT w, f;
    GetWindowRect(hwnd, out w);
    DwmGetWindowAttribute(hwnd, 9 /* DWMWA_EXTENDED_FRAME_BOUNDS */, out f, Marshal.SizeOf(typeof(RECT)));
    using (var full = new Bitmap(w.Right - w.Left, w.Bottom - w.Top)) {
      using (var g = Graphics.FromImage(full)) {
        IntPtr hdc = g.GetHdc();
        PrintWindow(hwnd, hdc, 2 /* PW_RENDERFULLCONTENT */);
        g.ReleaseHdc(hdc);
      }
      var crop = new Rectangle(f.Left - w.Left, f.Top - w.Top, f.Right - f.Left, f.Bottom - f.Top);
      using (var window = full.Clone(crop, full.PixelFormat)) return Rounded(window, 12);
    }
  }
  // The window with rounded, transparent corners, as Windows 11 draws it.
  static Bitmap Rounded(Bitmap src, int r) {
    var dst = new Bitmap(src.Width, src.Height, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(dst))
    using (var brush = new TextureBrush(src))
    using (var path = new System.Drawing.Drawing2D.GraphicsPath()) {
      int d = 2 * r, x = src.Width - 1, y = src.Height - 1;
      path.AddArc(0, 0, d, d, 180, 90);
      path.AddArc(x - d, 0, d, d, 270, 90);
      path.AddArc(x - d, y - d, d, d, 0, 90);
      path.AddArc(0, y - d, d, d, 90, 90);
      path.CloseFigure();
      g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
      g.FillPath(brush, path);
    }
    return dst;
  }
}
'@
[Win]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null  # per-monitor aware: real pixels

New-Item -ItemType Directory -Force $WorkDir | Out-Null
$extensions = Join-Path $WorkDir 'extensions'
$cli = Get-ChildItem (Split-Path -Parent $Code) -Directory | ForEach-Object { Join-Path $_.FullName 'resources\app\out\cli.js' } | Where-Object { Test-Path $_ } | Select-Object -First 1

# Stand-ins for three running Claude Code processes (only their pids are used).
$keepers = 1..3 | ForEach-Object { Start-Process -FilePath "$env:SystemRoot\System32\PING.EXE" -ArgumentList '-n', '900', '127.0.0.1' -WindowStyle Hidden -PassThru }
try {
  $env:ELECTRON_RUN_AS_NODE = '1'
  $env:CCG_DEMO_ZOOM = "$Zoom"
  $setup = & $Code (Join-Path $PSScriptRoot 'setup.js') $WorkDir @($keepers | ForEach-Object { $_.Id }) | Out-String
  $paths = $setup | ConvertFrom-Json
  # The extension itself, plus a small helper that arranges the window (test/demo/layout).
  & $Code (Join-Path $repo 'scripts\pack.js') (Join-Path $PSScriptRoot 'layout') $WorkDir | Out-Null
  foreach ($v in @($Vsix, (Join-Path $WorkDir 'demo-layout-0.0.1.vsix'))) {
    & $Code $cli --user-data-dir $paths.userData --extensions-dir $extensions --install-extension $v | Out-String | Write-Output
  }
  Remove-Item Env:ELECTRON_RUN_AS_NODE

  $env:CLAUDE_CONFIG_DIR = $paths.config
  $env:CCG_DEMO_FILE = $paths.file
  $env:CCG_DEMO_WIDEN = "$Widen"
  $env:CCG_DEMO_GO = Join-Path $WorkDir 'go'
  $common = @("--user-data-dir=`"$($paths.userData)`"", "--extensions-dir=`"$extensions`"", '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--new-window')

  $vscode = Start-Process -FilePath $Code -ArgumentList ($common + "`"$($paths.workspace)`"") -PassThru
  $hwnd = [IntPtr]::Zero
  for ($i = 0; $i -lt 150 -and $hwnd -eq [IntPtr]::Zero; $i++) { Start-Sleep -Milliseconds 200; $vscode.Refresh(); $hwnd = $vscode.MainWindowHandle }
  if ($hwnd -eq [IntPtr]::Zero) { throw 'No VS Code window' }
  # On a screen without the mouse pointer if there is one, so no row shows a hover state.
  Add-Type -AssemblyName System.Windows.Forms
  $cursor = [System.Windows.Forms.Cursor]::Position
  $screens = [System.Windows.Forms.Screen]::AllScreens
  $screen = @($screens | Where-Object { -not $_.Bounds.Contains($cursor) }) + @($screens) | Select-Object -First 1
  [Win]::ShowWindow($hwnd, 9) | Out-Null  # SW_RESTORE
  [Win]::SetWindowPos($hwnd, [IntPtr]::Zero, $screen.Bounds.X, $screen.Bounds.Y, $Width, $Height, 0x0014) | Out-Null  # NOZORDER | NOACTIVATE
  Start-Sleep -Seconds 1
  New-Item -ItemType File $env:CCG_DEMO_GO | Out-Null  # the helper sets the side bar width now
  Start-Sleep -Seconds 8

  $bitmap = [Win]::Capture($hwnd)
  New-Item -ItemType Directory -Force (Split-Path -Parent $Out) | Out-Null
  $bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output ("{0}: {1}x{2}" -f $Out, $bitmap.Width, $bitmap.Height)
  $bitmap.Dispose()
  Stop-Process -Id $vscode.Id -Force
}
finally {
  Remove-Item Env:CLAUDE_CONFIG_DIR, Env:CCG_DEMO_FILE, Env:CCG_DEMO_WIDEN, Env:CCG_DEMO_GO, Env:CCG_DEMO_ZOOM, Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  $keepers | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
}
