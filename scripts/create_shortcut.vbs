Set WshShell = WScript.CreateObject("WScript.Shell")
strDesktop = WshShell.SpecialFolders("Desktop")

Set oShortcut = WshShell.CreateShortcut(strDesktop & Chr(92) & "デジカル下書き保存.lnk")
oShortcut.TargetPath = "C:" & Chr(92) & "NAMIKI_AUTOMATION" & Chr(92) & "デジカル自動処理.bat"
oShortcut.WorkingDirectory = "C:" & Chr(92) & "NAMIKI_AUTOMATION"
oShortcut.IconLocation = "C:" & Chr(92) & "Program Files" & Chr(92) & "Google" & Chr(92) & "Chrome" & Chr(92) & "Application" & Chr(92) & "chrome.exe,0"
oShortcut.Description = "デジカル カルテ下書き一括保存"
oShortcut.Save

WScript.Echo "OK"
