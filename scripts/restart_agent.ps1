# 一键重启被控机 Agent：先结束正在运行的 Agent，再后台隐藏启动（加载最新代码）
#
# 用法（普通窗口即可，脚本会自动弹 UAC 提权）：
#   powershell -ExecutionPolicy Bypass -File scripts\restart_agent.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\restart_agent.ps1 -Port 8443 -PyExe <python.exe>
#
# 说明：Agent 通常以管理员身份运行，结束其进程需要管理员权限；
#       若当前不是管理员，本脚本会自动提权重启自己。
param(
    [int]$Port = 8443,
    [string]$PyExe = ""
)

$ErrorActionPreference = "Stop"

# ---------- 0) 需要管理员权限才能结束高权限的 Agent ----------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "[*] 需要管理员权限，正在提权（请在 UAC 弹窗点“是”）..." -ForegroundColor Yellow
    $argList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"", "-Port", $Port)
    if ($PyExe) { $argList += @("-PyExe", "`"$PyExe`"") }
    Start-Process -FilePath "powershell.exe" -ArgumentList $argList -Verb RunAs
    exit
}

$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
. (Join-Path $PSScriptRoot "_env.ps1")

# ---------- 1) 结束正在运行的 Agent ----------
$killed = 0

# 1a) 按命令行匹配：python ... agent\main.py
Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and ($_.CommandLine -like "*agent\main.py*" -or $_.CommandLine -like "*agent/main.py*") } |
    ForEach-Object {
        try {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop
            $killed++
            Write-Host "[-] 已结束 Agent 进程 PID $($_.ProcessId)"
        } catch {
            Write-Host "[!] 结束 PID $($_.ProcessId) 失败：$($_.Exception.Message)" -ForegroundColor Red
        }
    }

# 1b) 兜底：占用目标端口的进程（防止命令行读不到而漏杀）
$owners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ -and $_ -ne 0 })
foreach ($procId in $owners) {
    try {
        Stop-Process -Id $procId -Force -ErrorAction Stop
        $killed++
        Write-Host "[-] 已结束占用端口 $Port 的进程 PID $procId"
    } catch {
        Write-Host "[!] 结束 PID $procId 失败：$($_.Exception.Message)" -ForegroundColor Red
    }
}

if ($killed -eq 0) { Write-Host "[=] 未发现正在运行的 Agent" }
Start-Sleep -Seconds 2

# ---------- 2) 启动 Agent ----------
$py = Prepare-RcPython -PyExe $PyExe
Start-Process -FilePath $py -ArgumentList @((Join-Path $root "agent\main.py")) `
    -RedirectStandardOutput (Join-Path $logDir "agent.out") `
    -RedirectStandardError (Join-Path $logDir "agent.err") `
    -WorkingDirectory $root -WindowStyle Hidden
Write-Host "[*] Agent 已重新启动" -ForegroundColor Cyan

# ---------- 3) 校验 ----------
Start-Sleep -Seconds 3
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    Write-Host "[OK] Agent 正在监听 $Port" -ForegroundColor Green
} else {
    Write-Host "[!] 端口 $Port 尚未监听，请查看 logs\agent.err" -ForegroundColor Red
}
