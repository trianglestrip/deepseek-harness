@echo off
set LOG=%TEMP%\dsh-doc-sync.log
cd /d D:\gitProject\testCAD\portable\deepseek-harness
echo START %DATE% %TIME% > "%LOG%"
call pnpm run doc-sync >> "%LOG%" 2>&1
echo EXIT=%ERRORLEVEL% >> "%LOG%"
