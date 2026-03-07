@echo off
chcp 65001 >nul
cd /d "C:\NAMIKI_AUTOMATION"
title ADHD Distribution Auto
echo.
echo ========================================
echo   ADHD Distribution Auto
echo ========================================
echo.
node scripts\adhd_distribution_auto.js
echo.
pause
