# 启动被控机 Agent（首次运行会自动创建虚拟环境并安装依赖）
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File scripts\start_agent.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\start_agent.ps1 -Public
#   powershell -ExecutionPolicy Bypass -File scripts\start_agent.ps1 -Port 8443 -Fps 60
param(
    [int]$Port = 8443,
    [int]$Fps = 60,
    [int]$Bitrate = 8000000,
    [int]$Monitor = 0,
    [switch]$Public
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$py = Join-Path $root ".venv\Scripts\python.exe"

if (-not (Test-Path $py)) {
    Write-Host "[*] 首次运行，创建虚拟环境并安装依赖 ..." -ForegroundColor Cyan
    python -m venv (Join-Path $root ".venv")
    & $py -m pip install --upgrade pip
    & $py -m pip install --only-binary=:all: -r (Join-Path $root "requirements.txt")
    if (-not $?) { throw "依赖安装失败" }
}

$bind = if ($Public) { "0.0.0.0" } else { "127.0.0.1" }

Write-Host "[*] 启动 Agent: $bind`:$Port  monitor=$Monitor fps=$Fps" -ForegroundColor Cyan
& $py (Join-Path $root "agent\main.py") --host $bind --port $Port --fps $Fps --bitrate $Bitrate --monitor $Monitor
