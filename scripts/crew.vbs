' 콘솔 창 없이 launch.ps1 을 실행합니다. 바로가기가 가리키는 대상입니다.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
args = "-NoProfile -ExecutionPolicy Bypass -File """ & here & "\launch.ps1"""
If WScript.Arguments.Count > 0 Then
  args = args & " " & WScript.Arguments(0)
End If

shell.Run "powershell.exe " & args, 0, False
