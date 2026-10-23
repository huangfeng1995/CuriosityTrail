@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ============================================================
rem  寻迹 · 停止服务
rem
rem  只停本文件夹启动的那个进程：靠命令行里含 index.js 来认。
rem  不用 taskkill /IM node.exe —— 那会把机器上所有 node 程序都杀掉。
rem ============================================================

echo.
echo   正在停止寻迹...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$procs = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*index.js*' }; if (-not $procs) { Write-Host '   没有找到正在运行的寻迹。'; exit 0 }; foreach ($p in $procs) { Write-Host ('   正在结束进程 ' + $p.ProcessId + ' ...'); Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }; Write-Host '   已停止。'"

echo.
pause
