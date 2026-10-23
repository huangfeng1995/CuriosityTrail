param(
    [Parameter(Mandatory = $true)][string]$EnvFile,
    [Parameter(Mandatory = $true)][string]$DataDir,
    [Parameter(Mandatory = $true)][string]$Port
)

$ErrorActionPreference = 'Stop'

# 切到 UTF-8 码页，中文提示才不会乱码。
# chcp 是 Windows 命令，非 Windows 环境没有它——加个判断，
# 这样脚本在别的系统上也能跑（方便开发机自测）。
if (Get-Command chcp -ErrorAction SilentlyContinue) {
    chcp 65001 > $null
}

# 去掉易混字符（0/O、1/l/I），让人抄密码时少出错
$chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
$password = -join ($chars.ToCharArray() | Get-Random -Count 16)

if (-not (Test-Path $DataDir)) {
    New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
}

# 写成 UTF-8（无 BOM）。dotenv 读得了 BOM，但记事本另存为可能带 BOM，
# 这里统一用无 BOM，省得以后出现「第一个变量名带个看不见的字符」这种怪事。
$lines = @(
    '# 寻迹 本地版配置（自动生成，请勿删除）'
    '# 登录密码是下面 APP_PASSWORD 等号后面那串字符'
    "APP_PASSWORD=$password"
    "PORT=$Port"
    'BACKUP_HOUR=3'
    '# DeepSeek API key：填在这里才能用 AI 写作，留空则只能手动编辑正文'
    '# 申请地址：https://platform.deepseek.com'
    'DEEPSEEK_API_KEY='
)

$content = ($lines -join "`n") + "`n"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($EnvFile, $content, $utf8NoBom)

Write-Host ''
Write-Host '   ============================================'
Write-Host "     登录密码：$password"
Write-Host '     第一次打开网页时用它登录，记住可以勾选「记住我」。'
Write-Host '     想改密码就改这个文件里的 APP_PASSWORD。'
Write-Host '   ============================================'
Write-Host ''

exit 0
