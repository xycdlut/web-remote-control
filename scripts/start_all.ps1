# 一键启动被控机 Agent + frpc（都后台隐藏运行）
# 首次运行会自动：准备 Python 环境 → 安装依赖 → 下载 frpc。
# Python 解释器解析优先级：-PyExe 参数 > 环境变量 RC_PY > 项目内 .venv > PATH 上的 python。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\start_all.ps1 -ServerAddr <服务器IP> -Token <FRP令牌>
# 可选： -ServerPort 7000 -LocalPort 8443 -RemotePort 8443 -Fps 60 -Bitrate 8000000 -Monitor 0 -Public -PyExe <python.exe>
param(
    [Parameter(Mandatory = $true)][string]$ServerAddr,
    [Parameter(Mandatory = $true)][string]$Token,
    [int]$ServerPort = 7000,
    [int]$LocalPort = 8443,
    [int]$RemotePort = 8443,
    [int]$Fps = 0,
    [int]$Bitrate = 0,
    [int]$Monitor = -1,
    [switch]$Public,
    [string]$PyExe = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
. (Join-Path $PSScriptRoot "_env.ps1")

# ---------- 1) Python 环境（首次自动创建 .venv 并装依赖） ----------
$venvPy = Join-Path $root ".venv\Scripts\python.exe"
if (-not $PyExe -and -not $env:RC_PY -and -not (Test-Path $venvPy)) {
    $base = (Get-Command python.exe -ErrorAction SilentlyContinue).Source
    if (-not $base) { $base = (Get-Command py.exe -ErrorAction SilentlyContinue).Source }
    if ($base) {
        Write-Host "[*] 首次运行：创建项目内虚拟环境 .venv ..." -ForegroundColor Cyan
        & $base -m venv (Join-Path $root ".venv")
    }
}
$py = Prepare-RcPython -PyExe $PyExe
if (-not (Test-RcDeps -PyExe $py)) {
    Install-RcDeps -PyExe $py -Root $root
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
