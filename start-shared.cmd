@echo off
chcp 65001 >nul
powershell.exe -NoProfile -File "%~dp0scripts\start-shared.ps1" %*
if errorlevel 1 pause
