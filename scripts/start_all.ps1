# 一键启动被控机 Agent + frpc（都后台隐藏运行）
# 首次运行会自动：创建 conda 环境 → 安装 Python 依赖 → 下载 frpc。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\start_all.ps1 -ServerAddr <服务器IP> -Token <FRP令牌>
#   可选： -ServerPort 7000 -LocalPort 8443 -RemotePort 8443 -Fps 60 -Bitrate 8000000 -Monitor 0 -Public
param(
    [Parameter(Mandatory = $true)][string]$ServerAddr,
    [Parameter(Mandatory = $true)][string]$Token,
    [int]$ServerPort = 7000,
    [int]$LocalPort = 8443,
    [int]$RemotePort = 8443,
    [int]$Fps = 0,
    [int]$Bitrate = 0,
    [int]$Monitor = -1,
    [switch]$Public
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# ---------- 1) Agent 运行环境（首次自动创建并装依赖） ----------
$conda = "conda.exe"
$envDir = "C:\path\to\python-env"
$py = Join-Path $envDir "python.exe"
if (-not (Test-Path $py)) {
    Write-Host "[*] 首次运行：创建 conda 环境 remote_control ..." -ForegroundColor Cyan
    & $conda create -n remote_control python=3.9.13 -y --override-channels -c https://mirror.nju.edu.cn/anaconda/pkgs/main
    if (-not $?) { throw "conda 环境创建失败" }
}
# conda 环境未激活时需手动把 Library\bin 加入 PATH，否则 python 的 ssl 模块不可用
$env:PATH = "$envDir;$envDir\Library\mingw-w64\bin;$envDir\Library\usr\bin;$envDir\Library\bin;$envDir\Scripts;$envDir\bin;$env:PATH"
if (-not (Test-Path (Join-Path $envDir "Lib\site-packages\aiortc"))) {
    Write-Host "[*] 首次运行：安装 Python 依赖 ..." -ForegroundColor Cyan
    & $py -m pip install --only-binary=:all: -r (Join-Path $root "requirements.txt")
    if (-not $?) { throw "依赖安装失败" }
}

# ---------- 2) Agent ----------
$agentRunning = [bool](Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue)
if (-not $agentRunning) {
    $agentRunning = [bool](Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -like "*agent*main.py*" })
}
if (-not $agentRunning) {
    $bind = if ($Public) { "0.0.0.0" } else { "127.0.0.1" }
    $agentArgs = @((Join-Path $root "agent\main.py"), "--host", $bind, "--port", $LocalPort)
    if ($Fps -gt 0) { $agentArgs += @("--fps", $Fps) }
    if ($Bitrate -gt 0) { $agentArgs += @("--bitrate", $Bitrate) }
    if ($Monitor -ge 0) { $agentArgs += @("--monitor", $Monitor) }
    Start-Process -FilePath $py -ArgumentList $agentArgs -RedirectStandardOutput (Join-Path $logDir "agent.out") -RedirectStandardError (Join-Path $logDir "agent.err") -WindowStyle Hidden
    Write-Host "[*] Agent started ($bind`:$LocalPort)"
} else {
    Write-Host "[=] Agent already running (port $LocalPort in use)"
}

Start-Sleep -Seconds 2

# ---------- 3) frpc（首次自动下载） ----------
$frpc = Join-Path $root "tools\frpc.exe"
if (-not (Test-Path $frpc)) {
    $tools = Join-Path $root "tools"
    New-Item -ItemType Directory -Force -Path $tools | Out-Null
    Write-Host "[*] 首次运行：下载 frp ..." -ForegroundColor Cyan
    $ver = "0.61.0"
    $url = "https://github.com/fatedier/frp/releases/download/v$ver/frp_${ver}_windows_amd64.zip"
    $zip = Join-Path $tools "frp_win.zip"
    $ok = $false
    foreach ($prefix in @("", "https://ghfast.top/", "https://gh-proxy.com/", "https://mirror.ghproxy.com/")) {
        try {
            Invoke-WebRequest "$prefix$url" -OutFile $zip -TimeoutSec 120
            if (Test-Path $zip) { $ok = $true; break }
        } catch { }
    }
    if (-not $ok) { throw "frp 下载失败，请检查网络或手动下载 frpc.exe 到 tools\" }
    Expand-Archive $zip -DestinationPath $tools -Force
    $inner = Get-ChildItem -Path $tools -Recurse -Filter "frpc.exe" | Select-Object -First 1
    if ($inner.FullName -ne $frpc) { Copy-Item $inner.FullName $frpc -Force }
    Remove-Item $zip -Force
}

$cfgDir = Join-Path $root "frp"
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
$cfg = Join-Path $cfgDir "frpc.toml"
$nl = "`r`n"
$content = 'serverAddr = "' + $ServerAddr + '"' + $nl + 'serverPort = ' + $ServerPort + $nl + 'auth.method = "token"' + $nl + 'auth.token = "' + $Token + '"' + $nl + $nl + '[[proxies]]' + $nl + 'name = "agent"' + $nl + 'type = "tcp"' + $nl + 'localIP = "127.0.0.1"' + $nl + 'localPort = ' + $LocalPort + $nl + 'remotePort = ' + $RemotePort + $nl
Set-Content -Path $cfg -Value $content -Encoding ASCII

$frpcRunning = Get-Process frpc -ErrorAction SilentlyContinue
if (-not $frpcRunning) {
    Start-Process -FilePath $frpc -ArgumentList @("-c", $cfg) -RedirectStandardOutput (Join-Path $logDir "frpc.out") -RedirectStandardError (Join-Path $logDir "frpc.err") -WindowStyle Hidden
    Write-Host "[*] frpc started -> $ServerAddr : $ServerPort"
} else {
    Write-Host "[=] frpc already running"
}

Write-Host ""
Write-Host "Done. Master: https://<你的域名>"
