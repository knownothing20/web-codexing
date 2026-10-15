@echo off
cd /d "%~dp0"
if exist RemoteCoding.exe (
  start "" "%~dp0RemoteCoding.exe"
) else (
  node --disable-warning=ExperimentalWarning src\server.mjs
)
