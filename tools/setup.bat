@echo off
chcp 65001 >nul 2>&1

echo.
echo ========================================
echo   デジカル カルテ起動 - 初期セットアップ
echo ========================================
echo.

REM デスクトップショートカットを作成
echo デスクトップにショートカットを作成します...
cscript //nologo "C:\NAMIKI_AUTOMATION\tools\create-desktop-shortcut.vbs"

echo.
echo セットアップ完了！
echo.
echo デスクトップの「デジカル カルテ起動」をダブルクリックすると
echo Chrome がデバッグモードで起動し、カルテ画面まで自動で開きます。
echo.
pause
