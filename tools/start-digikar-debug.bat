@echo off
chcp 65001 >nul 2>&1

title デジカル 統合起動

echo.
echo ========================================
echo   デジカル 統合起動
echo   Chrome + 自動ログイン + 印刷パネル
echo   + 下書き一括保存ボタン
echo ========================================
echo.
echo ※ この画面は閉じないでください
echo   （バックグラウンドで常駐します）
echo.

cd /d C:\NAMIKI_AUTOMATION
node scripts\print-rx.js

echo.
echo [終了] print-rx.js が停止しました。
pause
