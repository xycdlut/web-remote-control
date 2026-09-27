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

# 使用 D 盘 Anaconda 的专用 conda 环境 remote_control
$conda = "conda.exe"
$envDir = "C:\path\to\python-env"
$py = Join-Path $envDir "python.exe"

if (-not (Test-Path $py)) {
    Write-Host "[*] 首次运行，创建 conda 环境 remote_control 并安装依赖 ..." -ForegroundColor Cyan
    & $conda create -n remote_control python=3.9.13 -y --override-channels -c https://mirror.nju.edu.cn/anaconda/pkgs/main
    if (-not $?) { throw "conda 环境创建失败" }
}

# conda 环境未激活时需手动把 Library\bin 加入 PATH，否则 python 的 ssl 模块不可用
$env:PATH = "$envDir;$envDir\Library\mingw-w64\bin;$envDir\Library\usr\bin;$envDir\Library\bin;$envDir\Scripts;$envDir\bin;$env:PATH"

if (-not (Test-Path (Join-Path $envDir "Lib\site-packages\aiortc"))) {
    & $py -m pip install --only-binary=:all: -r (Join-Path $root "requirements.txt")
    if (-not $?) { throw "依赖安装失败" }
}

$bind = if ($Public) { "0.0.0.0" } else { "127.0.0.1" }

Write-Host "[*] 启动 Agent: $bind`:$Port  monitor=$Monitor fps=$Fps" -ForegroundColor Cyan
& $py (Join-Path $root "agent\main.py") --host $bind --port $Port --fps $Fps --bitrate $Bitrate --monitor $Monitor
