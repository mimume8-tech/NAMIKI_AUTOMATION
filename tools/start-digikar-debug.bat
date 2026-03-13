@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion

REM ============================================================
REM  デジカル デバッグChrome 起動 + 自動ログイン + カルテ表示
REM  ワンクリックでカルテ画面が見えるところまで自動実行
REM ============================================================

title デジカル カルテ起動

echo.
echo ========================================
echo   デジカル カルテ自動起動
echo ========================================
echo.

REM --- Chrome.exe を探す ---
set "CHROME_PATH="

REM 標準インストール場所を順に探す
for %%P in (
    "C:\Program Files\Google\Chrome\Application\chrome.exe"
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
    "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
    "%PROGRAMFILES%\Google\Chrome\Application\chrome.exe"
    "%PROGRAMFILES(X86)%\Google\Chrome\Application\chrome.exe"
) do (
    if exist %%P (
        set "CHROME_PATH=%%~P"
        goto :found_chrome
    )
)

REM レジストリからも探す
for /f "tokens=2*" %%a in ('reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" /ve 2^>nul') do (
    if exist "%%b" (
        set "CHROME_PATH=%%b"
        goto :found_chrome
    )
)

echo [エラー] Chrome が見つかりません。
echo Google Chrome をインストールしてから再実行してください。
pause
exit /b 1

:found_chrome
echo [OK] Chrome: %CHROME_PATH%

REM --- 設定 ---
set "DEBUG_PORT=9222"
set "USER_DATA_DIR=C:\NAMIKI_AUTOMATION\chrome-debug-profile"
set "PROFILE_DIR=Default"
set "OPEN_URL=https://digikar.jp/reception/"
set "PROJECT_DIR=C:\NAMIKI_AUTOMATION"

REM --- デバッグポートが既に使われているか確認 ---
echo.
echo デバッグポート %DEBUG_PORT% を確認中...

curl -s -o nul -w "%%{http_code}" http://127.0.0.1:%DEBUG_PORT%/json/version > "%TEMP%\chrome_debug_check.txt" 2>nul
set /p HTTP_CODE=<"%TEMP%\chrome_debug_check.txt"
del "%TEMP%\chrome_debug_check.txt" 2>nul

if "%HTTP_CODE%"=="200" (
    echo [OK] デバッグ Chrome は既に起動しています。再利用します。
    goto :run_karte_script
)

REM --- 専用プロファイルフォルダ作成 ---
if not exist "%USER_DATA_DIR%" (
    echo 専用プロファイルフォルダを作成: %USER_DATA_DIR%
    mkdir "%USER_DATA_DIR%"
)

REM --- Chrome をデバッグモードで起動 ---
echo.
echo Chrome をデバッグモードで起動します...
start "" "%CHROME_PATH%" ^
    --remote-debugging-port=%DEBUG_PORT% ^
    --remote-debugging-address=127.0.0.1 ^
    --user-data-dir="%USER_DATA_DIR%" ^
    --profile-directory=%PROFILE_DIR% ^
    --no-first-run ^
    --new-window ^
    --kiosk-printing ^
    --show-bookmark-bar ^
    "%OPEN_URL%"

REM --- Chrome 起動を待つ ---
echo Chrome の起動を待っています...
set "WAIT_COUNT=0"

:wait_loop
if %WAIT_COUNT% GEQ 30 (
    echo.
    echo [エラー] Chrome がデバッグモードで起動しませんでした。
    echo 手動で確認: ブラウザで http://127.0.0.1:%DEBUG_PORT%/json/version を開いてください。
    pause
    exit /b 1
)

timeout /t 1 /nobreak >nul
set /a WAIT_COUNT+=1

curl -s -o nul -w "%%{http_code}" http://127.0.0.1:%DEBUG_PORT%/json/version > "%TEMP%\chrome_debug_check.txt" 2>nul
set /p HTTP_CODE=<"%TEMP%\chrome_debug_check.txt"
del "%TEMP%\chrome_debug_check.txt" 2>nul

if not "%HTTP_CODE%"=="200" (
    goto :wait_loop
)

echo [OK] Chrome デバッグモード起動完了 (ポート %DEBUG_PORT%)

:run_karte_script
echo.
echo 自動ログイン + カルテ表示を開始します...
echo.

cd /d "%PROJECT_DIR%"
node tools\open-karte.js

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [警告] 自動ログインでエラーが発生しました。
    echo Chrome は起動済みなので、手動でログインしてください。
)

echo.
echo ========================================
echo   完了！ カルテ画面を確認してください。
echo ========================================
echo.
pause
