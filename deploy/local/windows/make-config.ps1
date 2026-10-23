param(
    [Parameter(Mandatory = $true)][string]$EnvFile,
    [Parameter(Mandatory = $true)][string]$DataDir,
    [Parameter(Mandatory = $true)][string]$Port,
    [string]$ApiKey = ''
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

if (-not (Test-Path $DataDir)) {
    New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
}

# ------------------------------------------------------------------
# 读已有的配置
#
# 打包时可能已经预置了 AI 密钥，所以不能一上来就把文件重写——
# 那样会把密钥冲掉。这里读出来，只补空缺的值。
# ------------------------------------------------------------------
$settings = @{}
if (Test-Path $EnvFile) {
    foreach ($line in [System.IO.File]::ReadAllLines($EnvFile)) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
        $idx = $trimmed.IndexOf('=')
        if ($idx -lt 1) { continue }
        $key = $trimmed.Substring(0, $idx).Trim()
        $val = $trimmed.Substring($idx + 1).Trim()
        $settings[$key] = $val
    }
}

$isNew = -not $settings.ContainsKey('APP_PASSWORD') -or [string]::IsNullOrWhiteSpace($settings['APP_PASSWORD'])

if ($isNew) {
    $settings['APP_PASSWORD'] = -join ($chars.ToCharArray() | Get-Random -Count 16)
}

if (-not $settings.ContainsKey('PORT') -or [string]::IsNullOrWhiteSpace($settings['PORT'])) {
    $settings['PORT'] = $Port
}

if (-not $settings.ContainsKey('BACKUP_HOUR') -or [string]::IsNullOrWhiteSpace($settings['BACKUP_HOUR'])) {
    $settings['BACKUP_HOUR'] = '3'
}

# 密钥优先级：命令行参数 > 已有配置。已有的不能被空值冲掉。
if ($ApiKey) {
    $settings['DEEPSEEK_API_KEY'] = $ApiKey
} elseif (-not $settings.ContainsKey('DEEPSEEK_API_KEY')) {
    $settings['DEEPSEEK_API_KEY'] = ''
}

$hasKey = -not [string]::IsNullOrWhiteSpace($settings['DEEPSEEK_API_KEY'])

# ------------------------------------------------------------------
# 写回文件
# ------------------------------------------------------------------
$lines = @(
    '# 寻迹 本地版配置'
    '# 登录密码是下面 APP_PASSWORD 等号后面那串字符'
    "APP_PASSWORD=$($settings['APP_PASSWORD'])"
    "PORT=$($settings['PORT'])"
    "BACKUP_HOUR=$($settings['BACKUP_HOUR'])"
    '# DeepSeek API key：AI 写作要用它'
    "DEEPSEEK_API_KEY=$($settings['DEEPSEEK_API_KEY'])"
)

$content = ($lines -join "`n") + "`n"
# 写成 UTF-8 无 BOM。记事本另存为可能带 BOM，
# 这里统一用无 BOM，省得以后出现「第一个变量名带个看不见的字符」这种怪事。
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($EnvFile, $content, $utf8NoBom)

Write-Host ''
if ($isNew) {
    Write-Host '   ============================================'
    Write-Host "     登录密码：$($settings['APP_PASSWORD'])"
    Write-Host '     第一次打开网页时用它登录，记住可以勾选「记住我」。'
    Write-Host '     想改密码就改这个文件里的 APP_PASSWORD。'
    Write-Host '   ============================================'
} else {
    Write-Host '   配置已就绪。'
}

if ($hasKey) {
    Write-Host '   AI 写作已就绪（DeepSeek 密钥已配置）。'
} else {
    Write-Host '   注意：没有 AI 密钥，只能手动编辑正文。' -ForegroundColor Yellow
    Write-Host '   可在此文件填入 DEEPSEEK_API_KEY=sk-... 启用 AI 写作。' -ForegroundColor Yellow
}
Write-Host ''

exit 0
