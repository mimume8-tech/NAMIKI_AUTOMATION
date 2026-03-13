Set WshShell = WScript.CreateObject("WScript.Shell")
Set fso = WScript.CreateObject("Scripting.FileSystemObject")
strDesktop = WshShell.SpecialFolders("Desktop")

strToolsDir = "C:\NAMIKI_AUTOMATION\tools"
strIcoPath = strToolsDir & "\digikar-icon.ico"

Set oShortcut = WshShell.CreateShortcut(strDesktop & "\" & Chr(12487) & Chr(12472) & Chr(12459) & Chr(12523) & Chr(32) & Chr(12459) & Chr(12523) & Chr(12486) & Chr(36215) & Chr(21205) & ".lnk")
oShortcut.TargetPath = strToolsDir & "\start-digikar-debug.bat"
oShortcut.WorkingDirectory = "C:\NAMIKI_AUTOMATION"
oShortcut.Description = Chr(12487) & Chr(12472) & Chr(12459) & Chr(12523) & Chr(32) & Chr(12459) & Chr(12523) & Chr(12486) & Chr(30011) & Chr(38754) & Chr(12434) & Chr(12527) & Chr(12531) & Chr(12463) & Chr(12522) & Chr(12483) & Chr(12463) & Chr(36215) & Chr(21205)
oShortcut.WindowStyle = 1

If fso.FileExists(strIcoPath) Then
    oShortcut.IconLocation = strIcoPath & ",0"
Else
    oShortcut.IconLocation = "C:\Program Files\Google\Chrome\Application\chrome.exe,0"
End If

oShortcut.Save

WScript.Echo "OK"