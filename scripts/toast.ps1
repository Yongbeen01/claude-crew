# claude-crew - Windows toast
#
# Text arrives in environment variables, never on the command line: a task name
# can hold quotes and Korean, and pasting that into a script string is how a
# stray apostrophe becomes a syntax error - or worse, a command.
#
# ASCII only in this file. It is run with -File, and PowerShell 5.1 reads a
# BOM-less script as ANSI; anything non-ASCII here would arrive mangled. The
# Korean is all runtime data.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime] > $null

  $title = [Security.SecurityElement]::Escape("$env:CREW_TOAST_TITLE")
  $body = [Security.SecurityElement]::Escape("$env:CREW_TOAST_BODY")
  $urgent = "$env:CREW_TOAST_URGENT" -eq '1'
  $ok = [Security.SecurityElement]::Escape("$env:CREW_TOAST_OK")
  if (-not $ok) { $ok = 'OK' }

  if ($urgent) {
    # reminder: stays on screen until dismissed, and keeps making noise.
    $raw = @"
<toast scenario="reminder" launch="crew-timer">
  <visual><binding template="ToastGeneric">
    <text>$title</text>
    <text>$body</text>
  </binding></visual>
  <audio src="ms-winsoundevent:Notification.Looping.Alarm2" loop="true"/>
  <actions>
    <action content="$ok" arguments="ok" activationType="background"/>
  </actions>
</toast>
"@
  } else {
    $raw = @"
<toast launch="crew-timer">
  <visual><binding template="ToastGeneric">
    <text>$title</text>
    <text>$body</text>
  </binding></visual>
  <audio src="ms-winsoundevent:Notification.Reminder"/>
</toast>
"@
  }

  # An AppUserModelID that Windows already knows. Ours is not registered - a
  # shortcut carrying the id would be needed - and an unknown id is allowed to
  # be dropped silently, which is not a way to deliver "your time is up".
  $aumid = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'

  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml($raw)
  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show($toast)

  # Read it back: Show() returns nothing, so this is the only way to know the
  # notification actually reached the system rather than being dropped.
  Start-Sleep -Milliseconds 250
  # @(...) matters: GetHistory returns a WinRT collection with no .Count member,
  # so PowerShell enumerates it and hands back each ITEM's Count instead - three
  # toasts read as "1 1 1". Forcing an array asks the question we meant.
  $n = @([Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory($aumid)).Count
  if ($n -gt 0) { "ok $n" } else { "no-history" }
} catch {
  "error: $($_.Exception.Message)"
}
