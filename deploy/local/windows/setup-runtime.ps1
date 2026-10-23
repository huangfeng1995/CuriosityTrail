# 寻迹 本地版 · 运行环境准备
#
# 只需运行一次：下载免安装版 Node.js 到 runtime/ 目录。
# 不写系统 PATH、不装到「程序和功能」列表、不需要管理员权限，
# 卸载就是删掉整个文件夹。
#
# Node.js 官方提供免安装压缩包，解压即用：
#   https://nodejs.org/dist/v22.17.0/node-v22.17.0-win-x64.zip

$ErrorActionPreference = 'Stop'

# 切到 UTF-8 码页，中文提示才不会乱码。
# chcp 是 Windows 命令，非 Windows 环境没有它——加个判断，
# 这样脚本在别的系统上也能跑（方便开发机自测）。
if (Get-Command chcp -ErrorAction SilentlyContinue) {
    chcp 65001 > $null
}

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtimeDir = Join-Path $root 'runtime'
$nodeDir = Join-Path $runtimeDir 'node'
$nodeExe = Join-Path $nodeDir 'node.exe'

if (Test-Path $nodeExe) {
    Write-Host '运行环境已就绪。'
    exit 0
}

$version = 'v22.17.0'
$arch = 'x64'
$fileName = "node-$version-win-$arch.zip"
$url = "https://nodejs.org/dist/$version/$fileName"
$zipPath = Join-Path $runtimeDir $fileName

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

Write-Host "正在下载 Node.js $version ($arch) ..."
Write-Host "  $url"

try {
    # TLS 1.2 在较老的 Windows 10 上默认没开，会握手失败
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
} catch {
    Write-Host ''
    Write-Host '[失败] 下载 Node.js 失败。' -ForegroundColor Red
    Write-Host "  $($_.Exception.Message)"
    Write-Host ''
    Write-Host '可能原因：网络不通。请换网络后重试，' -ForegroundColor Yellow
    Write-Host '或手动下载后解压到 runtime 文件夹：' -ForegroundColor Yellow
    Write-Host "  $url" -ForegroundColor Yellow
    exit 1
}

Write-Host '正在解压...'
if (Test-Path $nodeDir) {
    Remove-Item -Recurse -Force $nodeDir
}
Expand-Archive -Path $zipPath -DestinationPath $runtimeDir -Force

# 解压出来是 node-v22.17.0-win-x64/，改名成 node/，路径更短也好读
$extracted = Join-Path $runtimeDir "node-$version-win-$arch"
if (Test-Path $extracted) {
    Move-Item -Path $extracted -Destination $nodeDir
}
Remove-Item -Force $zipPath

if (-not (Test-Path $nodeExe)) {
    Write-Host '[失败] 解压后没找到 node.exe，请删除 runtime 文件夹后重试。' -ForegroundColor Red
    exit 1
}

$ver = & $nodeExe --version
Write-Host ''
Write-Host "运行环境准备完成（Node $ver）。" -ForegroundColor Green
exit 0
