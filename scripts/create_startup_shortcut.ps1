$startup = [Environment]::GetFolderPath('Startup')
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut("$startup\print-rx.lnk")
$sc.TargetPath = 'C:\NAMIKI_AUTOMATION\scripts\print-rx-startup.vbs'
$sc.WorkingDirectory = 'C:\NAMIKI_AUTOMATION'
$sc.Description = 'print-rx daemon'
$sc.Save()
Write-Host "Created: $startup\print-rx.lnk"
