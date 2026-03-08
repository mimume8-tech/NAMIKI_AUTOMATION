Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\NAMIKI_AUTOMATION"
WshShell.Run "cmd /c """"C:\Program Files\nodejs\node.exe"" ""C:\NAMIKI_AUTOMATION\scripts\print-rx.js"" > ""C:\NAMIKI_AUTOMATION\scripts\print-rx.log"" 2>&1""", 0, False
