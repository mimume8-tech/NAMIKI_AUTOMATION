Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\NAMIKI_AUTOMATION"
WshShell.Run "cmd /c node scripts/print-rx.js > scripts/print-rx.log 2>&1", 0, False
