Set WshShell = WScript.CreateObject("WScript.Shell")
strDesktop = WshShell.SpecialFolders("Desktop")

Set oShortcut = WshShell.CreateShortcut(strDesktop & Chr(92) & "デジカル カルテ起動.lnk")
oShortcut.TargetPath = "C:" & Chr(92) & "NAMIKI_AUTOMATION" & Chr(92) & "tools" & Chr(92) & "start-digikar-debug.bat"
oShortcut.WorkingDirectory = "C:" & Chr(92) & "NAMIKI_AUTOMATION"
oShortcut.IconLocation = "C:" & Chr(92) & "Program Files" & Chr(92) & "Google" & Chr(92) & "Chrome" & Chr(92) & "Application" & Chr(92) & "chrome.exe,0"
oShortcut.Description = "デジカル カルテ画面をワンクリック起動"
oShortcut.WindowStyle = 1
oShortcut.Save

WScript.Echo "デスクトップに「デジカル カルテ起動」ショートカットを作成しました。"
