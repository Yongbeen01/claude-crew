' 콘솔 창 없이 launch.ps1 을 실행합니다. 바로가기가 가리키는 대상입니다.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
args = "-NoProfile -ExecutionPolicy Bypass -File """ & here & "\launch.ps1"""
' 인자는 전부 넘긴다 — 스스로 다시 켤 때는 "-Restart -NoBrowser" 둘이 같이 와야 한다
For i = 0 To WScript.Arguments.Count - 1
  args = args & " " & WScript.Arguments(i)
Next

shell.Run "powershell.exe " & args, 0, False
