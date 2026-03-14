@echo off
echo Chrome をデバッグモードで起動します...
echo.
echo ※ 先に Chrome を完全に閉じてから実行してください
echo    （タスクトレイのアイコンも右クリック→終了）
echo.
taskkill /F /IM chrome.exe >nul 2>&1
timeout /t 3 /nobreak >nul
if exist "C:\NAMIKI_AUTOMATION\tools\auto-confirm-cert-dialog.ps1" start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\NAMIKI_AUTOMATION\tools\auto-confirm-cert-dialog.ps1" -TimeoutSeconds 45
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --new-window --kiosk-printing --show-bookmark-bar --user-data-dir="C:\ChromeDebugProfile" --profile-directory=Default https://digikar.jp/reception/
echo Chrome を起動しました。
echo デジカルにログインして受付画面を表示したら、
echo 別のターミナルで node scripts/digikar_auto.js を実行してください。
pause
