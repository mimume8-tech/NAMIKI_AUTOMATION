$ws = New-Object -ComObject WScript.Shell
$desktop = $ws.SpecialFolders("Desktop")
$sc = $ws.CreateShortcut("$desktopデジカル下書き保存.lnk")
$sc.TargetPath = "C:NAMIKI_AUTOMATIONデジカル自動処理.bat"
$sc.WorkingDirectory = "C:NAMIKI_AUTOMATION"
$sc.IconLocation = "C:Program FilesGoogleChromeApplicationchrome.exe,0"
$sc.Description = "DigiKar"
$sc.Save()
Write-Output "OK"