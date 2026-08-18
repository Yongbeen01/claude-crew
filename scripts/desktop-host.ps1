# claude-crew - desktop host
#
# One long-lived PowerShell process that answers questions about the windows
# currently open on this PC, and opens / hides them again on request.
#
# It speaks JSON lines: one request object per line on stdin, one reply object
# per line on stdout. Spawning powershell.exe costs ~600ms, and the office asks
# every few seconds, so a per-poll process was never an option.
#
# ASCII ONLY. This file is executed with -File, and PowerShell 5.1 reads a
# BOM-less script as ANSI - a single Korean character in the source would break
# parsing. Window titles are Korean of course, but those arrive at runtime and
# leave through [Console]::OutputEncoding, which is set to UTF-8 below.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
# ...and the same going IN. Every command until now carried only ASCII payloads
# (ids, window handles), so this was invisible; the first request holding a
# window title - which is Korean, or has the "..." a truncated one ends in -
# arrived mangled, failed to parse, and was silently skipped. The caller then
# waited out its whole timeout for a reply that was never coming.
[Console]::InputEncoding = [Text.Encoding]::UTF8

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class CrewWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint c);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
}
"@

$uia = $false
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $uia = $true
} catch {
  # No UI Automation on this box: browsers still show up, just as one person
  # per window instead of one per tab.
}

$SW_MINIMIZE = 6
$SW_RESTORE = 9
$GW_OWNER = 4
$WS_EX_TOOLWINDOW = 0x00000080
$DWMWA_CLOAKED = 14

# Processes whose windows are a tab strip rather than a single document.
$BROWSERS = @('chrome', 'msedge', 'brave', 'whale', 'vivaldi', 'opera', 'opera_gx', 'firefox', 'librewolf', 'arc')

# Shell surfaces that are technically top-level windows but are not "something
# the user opened" - listing them would put the desktop itself in the office.
$SKIP_CLASSES = @(
  'Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd',
  'Windows.UI.Core.CoreWindow', 'ForegroundStaging', 'XamlExplorerHostIslandWindow',
  'MultitaskingViewFrame', 'TaskListThumbnailWnd', 'Xaml_WindowedPopupClass'
)
$SKIP_PROCS = @('TextInputHost', 'SearchHost', 'StartMenuExperienceHost', 'ShellExperienceHost', 'LockApp', 'PeopleExperienceHost')

function Get-Windows {
  $list = New-Object System.Collections.ArrayList
  $cb = [CrewWin+EnumProc] {
    param($h, $l)
    try {
      if (-not [CrewWin]::IsWindowVisible($h)) { return $true }
      $len = [CrewWin]::GetWindowTextLength($h)
      if ($len -le 0) { return $true }

      $sb = New-Object System.Text.StringBuilder ($len + 2)
      [void][CrewWin]::GetWindowText($h, $sb, $sb.Capacity)
      $title = $sb.ToString().Trim()
      if (-not $title) { return $true }

      # Owned windows are dialogs of something already in the list.
      if ([CrewWin]::GetWindow($h, $GW_OWNER) -ne [IntPtr]::Zero) { return $true }
      if (([CrewWin]::GetWindowLong($h, -20) -band $WS_EX_TOOLWINDOW) -ne 0) { return $true }

      # A cloaked window is on another virtual desktop or is a suspended UWP
      # shell - visible to Win32, invisible to the user.
      $cloaked = 0
      [void][CrewWin]::DwmGetWindowAttribute($h, $DWMWA_CLOAKED, [ref]$cloaked, 4)
      if ($cloaked -ne 0) { return $true }

      $cn = New-Object System.Text.StringBuilder 256
      [void][CrewWin]::GetClassName($h, $cn, 256)
      $cls = $cn.ToString()
      if ($SKIP_CLASSES -contains $cls) { return $true }

      $wpid = 0
      [void][CrewWin]::GetWindowThreadProcessId($h, [ref]$wpid)
      $proc = ''
      try { $proc = (Get-Process -Id $wpid -ErrorAction Stop).ProcessName } catch { }
      if ($SKIP_PROCS -contains $proc) { return $true }

      [void]$list.Add([pscustomobject]@{
        hwnd      = $h.ToInt64()
        title     = $title
        cls       = $cls
        pid       = $wpid
        proc      = $proc
        minimized = [bool][CrewWin]::IsIconic($h)
        browser   = ($BROWSERS -contains $proc.ToLower())
      })
    } catch { }
    return $true
  }
  [void][CrewWin]::EnumWindows($cb, [IntPtr]::Zero)
  return $list
}

# Real browser tabs, told apart from tab widgets inside the page.
#
# FindAll(Descendants, TabItem) walks into the rendered document too, so a site
# with its own tab bar would otherwise contribute half a dozen phantom people.
# The one reliable difference is the ancestor chain: a page's tabs sit under a
# Document, the browser's own do not.
function Get-Tabs($hwnd) {
  $out = New-Object System.Collections.ArrayList
  if (-not $uia) { return $out }
  try {
    $A = [System.Windows.Automation.AutomationElement]
    $root = $A::FromHandle([IntPtr][int64]$hwnd)
    if ($null -eq $root) { return $out }
    $cond = New-Object System.Windows.Automation.PropertyCondition(
      $A::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
    $found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $i = 0
    foreach ($t in $found) {
      $p = $walker.GetParent($t)
      $inDoc = $false
      $depth = 0
      while ($null -ne $p -and $depth -lt 24) {
        $pct = $p.Current.ControlType.ProgrammaticName
        if ($pct -eq 'ControlType.Document') { $inDoc = $true; break }
        if ($pct -eq 'ControlType.Window') { break }
        $p = $walker.GetParent($p)
        $depth++
      }
      if ($inDoc) { continue }
      $name = $t.Current.Name
      if (-not $name) { continue }
      $selected = $false
      try {
        $sp = $t.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
        $selected = [bool]$sp.Current.IsSelected
      } catch { }
      [void]$out.Add([pscustomobject]@{
        hwnd     = [int64]$hwnd
        rt       = ($t.GetRuntimeId() -join '.')
        name     = $name
        index    = $i
        selected = $selected
      })
      $i++
    }
  } catch { }
  return $out
}

function Select-Tab($hwnd, $rt) {
  if (-not $uia -or -not $rt) { return $false }
  try {
    $A = [System.Windows.Automation.AutomationElement]
    $root = $A::FromHandle([IntPtr][int64]$hwnd)
    if ($null -eq $root) { return $false }
    $cond = New-Object System.Windows.Automation.PropertyCondition(
      $A::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
    foreach ($t in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) {
      if (($t.GetRuntimeId() -join '.') -ne $rt) { continue }
      $sp = $t.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
      $sp.Select()
      return $true
    }
  } catch { }
  return $false
}

# SetForegroundWindow only obeys a process that already owns the foreground.
# Borrowing the current foreground thread's input queue is the long-standing way
# to ask politely; if it still refuses, the restore above has done the useful
# part anyway.
function Show-Window($hwnd, $foreground) {
  $h = [IntPtr][int64]$hwnd
  if (-not [CrewWin]::IsWindow($h)) { return $false }
  if ([CrewWin]::IsIconic($h)) { [void][CrewWin]::ShowWindow($h, $SW_RESTORE) }
  if (-not $foreground) { return $true }
  $fg = [CrewWin]::GetForegroundWindow()
  $a = 0; $b = 0
  [void][CrewWin]::GetWindowThreadProcessId($fg, [ref]$a)
  $me = [CrewWin]::GetWindowThreadProcessId($fg, [ref]$b)
  $target = [CrewWin]::GetWindowThreadProcessId($h, [ref]$b)
  [void][CrewWin]::AttachThreadInput($me, $target, $true)
  [void][CrewWin]::BringWindowToTop($h)
  [void][CrewWin]::SetForegroundWindow($h)
  [void][CrewWin]::AttachThreadInput($me, $target, $false)
  return $true
}

function Hide-Window($hwnd) {
  $h = [IntPtr][int64]$hwnd
  if (-not [CrewWin]::IsWindow($h)) { return $false }
  # Minimize, never ShowWindow(SW_HIDE): a hidden window leaves the taskbar too
  # and the user has no way left to get it back.
  [void][CrewWin]::ShowWindow($h, $SW_MINIMIZE)
  return $true
}

function Reply($obj) {
  Write-Output ($obj | ConvertTo-Json -Compress -Depth 5)
  [Console]::Out.Flush()
}

Reply ([pscustomobject]@{ ready = $true; uia = $uia })

# ---- saving a group, and putting it back ---------------------------------
#
# What a window IS, in enough detail to open it again later: the program, the
# arguments it was started with (which is where a document path lives), and for
# a browser the page in front.
#
# Only the FRONT tab's address can be read. A background tab's URL is not in the
# accessibility tree - the omnibox shows one page at a time - and the only way
# to see the others would be to click through them, stealing focus. So a saved
# browser window remembers the page you were on when you saved it.

function Get-ActiveUrl($h) {
  if (-not $uia) { return '' }
  try {
    $A = [System.Windows.Automation.AutomationElement]
    $root = $A::FromHandle([IntPtr]$h)
    if ($null -eq $root) { return '' }
    $cond = New-Object System.Windows.Automation.PropertyCondition(
      $A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
    foreach ($e in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) {
      try {
        $vp = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        $v = [string]$vp.Current.Value
        if (-not $v) { continue }
        if ($v -match '^(https?|file)://') { return $v }
        # The omnibox hides the scheme: "docs.anthropic.com/en/x". Put it back.
        # The port has to be allowed for - "127.0.0.1:4321/x" is a URL too, and
        # requiring a slash straight after the host silently dropped every one
        # of them.
        if ($v -match '^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(/|$)') { return "http://$v" }
        if ($v -match '^[\w-]+(\.[\w-]+)+(:\d+)?(/|$)') { return "https://$v" }
      } catch { }
    }
  } catch { }
  return ''
}

# Windows hands programs one command-line STRING, not an argv array, so the
# document path has to be cut back out of it.
function Split-CommandLine($cmd) {
  $out = New-Object System.Collections.ArrayList
  $cur = ''
  $inQ = $false
  foreach ($ch in ([string]$cmd).ToCharArray()) {
    if ($ch -eq '"') { $inQ = -not $inQ; continue }
    if (($ch -eq ' ') -and (-not $inQ)) {
      if ($cur.Length -gt 0) { [void]$out.Add($cur); $cur = '' }
      continue
    }
    $cur += $ch
  }
  if ($cur.Length -gt 0) { [void]$out.Add($cur) }
  return $out
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  $line = $line.Trim()
  if (-not $line) { continue }
  $req = $null
  # A line we cannot parse used to vanish without trace, and the caller sat
  # through its timeout wondering. Say so on stderr - desktop.js keeps it.
  try { $req = $line | ConvertFrom-Json } catch {
    [Console]::Error.WriteLine("bad request line: " + $line.Substring(0, [Math]::Min(120, $line.Length)))
    continue
  }
  if ($req.cmd -eq 'quit') { break }

  try {
    switch ($req.cmd) {
      'list' {
        $wins = Get-Windows
        $tabs = New-Object System.Collections.ArrayList
        foreach ($w in $wins) {
          if (-not $w.browser -or $w.minimized) { continue }
          foreach ($t in (Get-Tabs $w.hwnd)) { [void]$tabs.Add($t) }
        }
        Reply ([pscustomobject]@{ id = $req.id; ok = $true; windows = @($wins); tabs = @($tabs); uia = $uia })
      }
      'show' {
        $n = 0
        foreach ($h in @($req.windows)) { if (Show-Window $h $false) { $n++ } }
        # Foreground the last one only - racing every window to the front just
        # shuffles them.
        $last = @($req.windows) | Select-Object -Last 1
        if ($null -ne $last) { [void](Show-Window $last $true) }
        Reply ([pscustomobject]@{ id = $req.id; ok = $true; count = $n })
      }
      'hide' {
        $n = 0
        foreach ($h in @($req.windows)) { if (Hide-Window $h) { $n++ } }
        Reply ([pscustomobject]@{ id = $req.id; ok = $true; count = $n })
      }
      'focus' {
        [void](Show-Window $req.hwnd $true)
        $ok = $true
        if ($req.rt) { $ok = Select-Tab $req.hwnd $req.rt }
        Reply ([pscustomobject]@{ id = $req.id; ok = $ok })
      }
      'capture' {
        $out = New-Object System.Collections.ArrayList
        foreach ($h in @($req.windows)) {
          $exe = ''; $cmdline = ''; $url = ''
          $wpid = 0
          [void][CrewWin]::GetWindowThreadProcessId([IntPtr][int64]$h, [ref]$wpid)
          if ($wpid -gt 0) {
            $pn = ''
            try {
              $p = Get-Process -Id $wpid -ErrorAction Stop
              $pn = $p.ProcessName.ToLower()
              $exe = [string]$p.Path
            } catch { }
            try {
              $ci = Get-CimInstance Win32_Process -Filter "ProcessId=$wpid" -ErrorAction Stop
              $cmdline = [string]$ci.CommandLine
            } catch { }
            if ($BROWSERS -contains $pn) { $url = Get-ActiveUrl $h }
          }
          # The document, dug back out of the argument string. Opening THE FILE
          # is better than opening the program: Windows picks the right app, and
          # it still works when the program itself cannot be started by path.
          $doc = ''
          if ($cmdline) {
            $parts = Split-CommandLine $cmdline
            for ($i = 1; $i -lt $parts.Count; $i++) {
              $cand = [string]$parts[$i]
              if ($cand.StartsWith('-') -or $cand.StartsWith('/')) { continue }
              try { if (Test-Path -LiteralPath $cand -PathType Leaf) { $doc = $cand; break } } catch { }
            }
          }
          [void]$out.Add([pscustomobject]@{ hwnd = $h; exe = $exe; cmd = $cmdline; url = $url; doc = $doc })
        }
        Reply ([pscustomobject]@{ id = $req.id; ok = $true; items = @($out) })
      }
      'launch' {
        # Pages that share a browser are opened in ONE call, so they come back
        # as tabs of a single window instead of a window each.
        $byBrowser = @{}
        $plain = New-Object System.Collections.ArrayList
        foreach ($it in @($req.items)) {
          if ($it.url) {
            $key = [string]$it.exe
            if (-not $byBrowser.ContainsKey($key)) { $byBrowser[$key] = New-Object System.Collections.ArrayList }
            [void]$byBrowser[$key].Add([string]$it.url)
          } else {
            [void]$plain.Add($it)
          }
        }
        $n = 0
        foreach ($key in $byBrowser.Keys) {
          $urls = @($byBrowser[$key])
          try {
            if ($key -and (Test-Path -LiteralPath $key)) { Start-Process -FilePath $key -ArgumentList $urls }
            else { foreach ($u in $urls) { Start-Process $u } }
            $n += $urls.Count
          } catch { }
        }
        # Three ways to bring a program back, best first.
        #
        # An executable path is NOT always usable: a Store app lives under
        # C:\Program Files\WindowsApps, which is ACL'd away from the user, so
        # Test-Path is false and Start-Process on it fails. Those apps are still
        # reachable by their bare name through the App Execution Alias - which
        # is also how you started them from Run in the first place.
        $failed = New-Object System.Collections.ArrayList
        foreach ($it in $plain) {
          $done = $false
          $exe = [string]$it.exe
          $doc = [string]$it.doc
          # 1. the document itself - Windows picks the app
          if ($doc) {
            try { Start-Process -FilePath $doc; $done = $true } catch { }
          }
          # 2. the program by full path, with whatever it was started with
          if (-not $done -and $exe) {
            try {
              if (Test-Path -LiteralPath $exe) {
                $parts = Split-CommandLine $it.cmd
                # $argv, not $args - the latter is a PowerShell automatic variable
                $argv = @()
                if ($parts.Count -gt 1) { $argv = @($parts[1..($parts.Count - 1)]) }
                if ($argv.Count -gt 0) { Start-Process -FilePath $exe -ArgumentList $argv }
                else { Start-Process -FilePath $exe }
                $done = $true
              }
            } catch { }
          }
          # 3. by bare name, through PATH / App Execution Alias
          if (-not $done -and $exe) {
            try { Start-Process -FilePath (Split-Path -Leaf $exe); $done = $true } catch { }
          }
          if ($done) { $n++ } else { [void]$failed.Add([string]$it.title) }
        }
        Reply ([pscustomobject]@{ id = $req.id; ok = $true; count = $n; failed = @($failed) })
      }
      default { Reply ([pscustomobject]@{ id = $req.id; ok = $false; error = 'unknown cmd' }) }
    }
  } catch {
    Reply ([pscustomobject]@{ id = $req.id; ok = $false; error = $_.Exception.Message })
  }
}
