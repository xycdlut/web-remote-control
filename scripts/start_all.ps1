# 一键启动被控机两件事：Agent + frpc（都后台隐藏运行）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\start_all.ps1
param(
    [string]$ServerAddr = "YOUR_SERVER_IP",
    [string]$Token = "YOUR_FRP_TOKEN",
    [int]$ServerPort = 7000,
    [int]$LocalPort = 8443,
    [int]$RemotePort = 8443
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# ---------- 1) Agent ----------
$py = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) { $py = "python" }
$agentRunning = Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -like "*agent*main.py*" }
if (-not $agentRunning) {
    $agentArgs = @((Join-Path $root "agent\main.py"))
    Start-Process -FilePath $py -ArgumentList $agentArgs -RedirectStandardOutput (Join-Path $logDir "agent.out") -RedirectStandardError (Join-Path $logDir "agent.err") -WindowStyle Hidden
    Write-Host "[*] Agent started"
} else {
    Write-Host "[=] Agent already running"
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
Write-Host "Done. Master: https://remote.example.com"
