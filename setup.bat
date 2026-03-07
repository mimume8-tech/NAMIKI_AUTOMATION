@echo off
chcp 65001 >nul
title DigiKar セットアップ
echo.
echo ========================================
echo   DigiKar 初期セットアップ
echo ========================================
echo.
echo 1. 必要なパッケージをインストール中...
cd /d "C:\NAMIKI_AUTOMATION"
call npm install
echo.
echo 2. デスクトップにショートカットを作成中...
node scripts\update_shortcut.js
echo.
echo ========================================
echo   セットアップ完了！
echo   デスクトップの「DigiKar下書き保存」を
echo   ダブルクリックで使えます。
echo ========================================
echo.
pause
