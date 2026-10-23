@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem ============================================================
rem  寻迹 · 本地版
rem  双击本文件即可使用。第一次运行会自动准备环境（需联网，约 2-4 分钟），
rem  之后每次都是秒开。
rem ============================================================

set "NODE_EXE=%~dp0runtime\node\node.exe"
set "NPM_CLI=%~dp0runtime\node\node_modules\npm\bin\npm-cli.js"
set "APP_DIR=%~dp0app"
set "SERVER_DIR=%APP_DIR%\web\server"
set "DATA_DIR=%~dp0data"
set "ENV_FILE=%APP_DIR%\web\.env"
set "PORT=3001"

if not exist "%NODE_EXE%" (
  echo.
  echo   首次运行：正在准备运行环境（需联网，约 1-2 分钟）...
  echo.
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-runtime.ps1"
  if errorlevel 1 (
    echo.
    echo   [失败] 运行环境准备失败，请检查网络后重试。
    echo.
    pause
    exit /b 1
  )
)

if not exist "%SERVER_DIR%\node_modules" (
  echo.
  echo   首次运行：正在安装组件（需联网，约 2-4 分钟）...
  echo.
  "%NODE_EXE%" "%NPM_CLI%" install --omit=dev --no-audit --no-fund --prefix "%SERVER_DIR%"
  if errorlevel 1 (
    echo.
    echo   [失败] 组件安装失败，请检查网络后重试。
    echo.
    pause
    exit /b 1
  )
)

if not exist "%ENV_FILE%" (
  echo.
  echo   首次运行：正在生成配置...
  echo.
  call :make_env
  if errorlevel 1 exit /b 1
)

rem ---------- 启动服务 ----------
rem  DATA_DIR 与 PORT 用环境变量注入：.env 里虽然也写了，
rem 但 .env 是在服务启动时才读的，路径相关的量必须先由外部定下来。
set "DATA_DIR=%DATA_DIR%"
set "PORT=%PORT%"
set "NODE_ENV=production"
set "COOKIE_SECURE=false"

echo.
echo   正在启动寻迹...
echo.

start "" /b "%NODE_EXE%" "%SERVER_DIR%\index.js" > "%~dp0server.log" 2>&1

rem ---------- 等待服务就绪 ----------
set "READY="
for /l %%i in (1,1,45) do (
  if not defined READY (
    powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:%PORT%/api/health' -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
    if not errorlevel 1 set "READY=1"
    if not defined READY timeout /t 1 /nobreak >nul
  )
)

if not defined READY (
  echo   [失败] 服务没能启动。下面的日志说明了原因：
  echo.
  type "%~dp0server.log"
  echo.
  pause
  exit /b 1
)

start "" "http://127.0.0.1:%PORT%/"
echo   已启动，正在打开浏览器...
echo.
echo   停止方法：双击「停止寻迹.cmd」，或直接关掉这个黑窗口。
echo.

rem 窗口留着方便看日志；服务进程退出后自动结束
:wait_loop
timeout /t 2 /nobreak >nul
tasklist /fi "IMAGENAME eq node.exe" /nh 2>nul | find /i "node.exe" >nul
if not errorlevel 1 goto wait_loop

echo.
echo   服务已停止。
pause
exit /b 0


rem ============================================================
rem  生成 .env：随机登录密码 + 端口 + 本地 cookie 设置
rem ============================================================
:make_env
rem 整个 .env 交给 PowerShell 生成。
rem 在 cmd 里手写多行重定向块容易踩到括号与变量展开的坑，
rem 交给 PowerShell 处理更稳，也顺便把随机密码一起做了。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0make-config.ps1" -EnvFile "%ENV_FILE%" -DataDir "%DATA_DIR%" -Port "%PORT%"
if errorlevel 1 (
  echo   [失败] 无法写入配置文件，请确认解压后的文件夹不是只读的。
  pause
  exit /b 1
)

goto :eof
