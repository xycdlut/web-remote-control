# 一键启动被控机两件事：Agent + frpc（都后台隐藏运行）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\start_all.ps1
param(
    [string]$ServerAddr = "",
    [string]$Token = "",
    [int]$ServerPort = 7000,
    [int]$LocalPort = 8443,
    [int]$RemotePort = 8443
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($ServerAddr) -or [string]::IsNullOrWhiteSpace($Token)) {
    throw "请提供 -ServerAddr <服务器IP> 与 -Token <FRP令牌>"
}
$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# ---------- 1) Agent ----------
$envDir = "C:\path\to\python-env"
$py = Join-Path $envDir "python.exe"
# conda 环境未激活时需手动把 Library\bin 加入 PATH，否则 python 的 ssl 模块不可用
$env:PATH = "$envDir;$envDir\Library\mingw-w64\bin;$envDir\Library\usr\bin;$envDir\Library\bin;$envDir\Scripts;$envDir\bin;$env:PATH"
$agentRunning = [bool](Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue)
if (-not $agentRunning) {
    $agentRunning = [bool](Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -like "*agent*main.py*" })
}
if (-not $agentRunning) {
    $agentArgs = @((Join-Path $root "agent\main.py"))
    Start-Process -FilePath $py -ArgumentList $agentArgs -RedirectStandardOutput (Join-Path $logDir "agent.out") -RedirectStandardError (Join-Path $logDir "agent.err") -WindowStyle Hidden
    Write-Host "[*] Agent started"
} else {
    Write-Host "[=] Agent already running (port $LocalPort in use)"
}

Start-Sleep -Seconds 2

# ---------- 2) frpc ----------
$frpc = Join-Path $root "tools\frpc.exe"
if (-not (Test-Path $frpc)) { throw "missing tools\frpc.exe, run scripts\start_frpc.ps1 first" }

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
