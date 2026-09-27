# 被控机：启动 frpc，把本地 Agent(8443) 通过国内服务器中转出去
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\start_frpc.ps1 `
#       -ServerAddr 1.2.3.4 -Token MySecretToken123
param(
    [Parameter(Mandatory = $true)][string]$ServerAddr,
    [Parameter(Mandatory = $true)][string]$Token,
    [int]$ServerPort = 7000,
    [int]$LocalPort = 8443,
    [int]$RemotePort = 8443
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $root "tools"
New-Item -ItemType Directory -Force -Path $tools | Out-Null

$frpc = Join-Path $tools "frpc.exe"
if (-not (Test-Path $frpc)) {
    Write-Host "[*] 下载 frp ..." -ForegroundColor Cyan
    $ver = "0.61.0"
    $url = "https://github.com/fatedier/frp/releases/download/v$ver/frp_${ver}_windows_amd64.zip"
    $zip = Join-Path $tools "frp_win.zip"
    $ok = $false
    foreach ($prefix in @("", "https://ghfast.top/", "https://gh-proxy.com/", "https://mirror.ghproxy.com/")) {
        try {
            Write-Host "    $prefix$url"
            Invoke-WebRequest "$prefix$url" -OutFile $zip -TimeoutSec 120
            if (Test-Path $zip) { $ok = $true; break }
        } catch { }
    }
    if (-not $ok) { throw "frp 下载失败，请检查网络或手动下载 frp 的 frpc.exe 到 tools\" }
    Expand-Archive $zip -DestinationPath $tools -Force
    $inner = Get-ChildItem -Path $tools -Recurse -Filter "frpc.exe" | Select-Object -First 1
    if ($inner.FullName -ne $frpc) { Copy-Item $inner.FullName $frpc -Force }
    Remove-Item $zip -Force
}

$cfgDir = Join-Path $root "frp"
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
$cfg = Join-Path $cfgDir "frpc.toml"
@"
serverAddr = "$ServerAddr"
serverPort = $ServerPort
auth.method = "token"
auth.token = "$Token"

[[proxies]]
name = "agent"
type = "tcp"
localIP = "127.0.0.1"
localPort = $LocalPort
remotePort = $RemotePort
"@ | Set-Content -Path $cfg -Encoding UTF8

Write-Host "[*] 启动 frpc: $ServerAddr`:$ServerPort  本地 $LocalPort -> 远端 $RemotePort" -ForegroundColor Cyan
& $frpc -c $cfg
