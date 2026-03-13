@echo off
chcp 65001 >nul 2>&1

echo.
echo ========================================
echo   デジカル カルテ起動 - 初期セットアップ
echo ========================================
echo.

REM --- PNG → ICO 変換 ---
if exist "C:\NAMIKI_AUTOMATION\tools\digikar-icon.png" (
    echo アイコン画像を ICO に変換中...
    powershell -ExecutionPolicy Bypass -File "C:\NAMIKI_AUTOMATION\tools\convert-icon.ps1"
    echo.
) else (
    echo [注意] tools\digikar-icon.png が見つかりません。Chrome のアイコンを使用します。
    echo.
)

REM --- デスクトップショートカットを作成 ---
echo デスクトップにショートカットを作成します...
cscript //nologo "C:\NAMIKI_AUTOMATION\tools\create-desktop-shortcut.vbs"

echo.
echo ========================================
echo   セットアップ完了！
echo ========================================
echo.
echo デスクトップの「デジカル カルテ起動」をダブルクリックすると
echo Chrome がデバッグモードで起動し、カルテ画面まで自動で開きます。
echo.
pause
