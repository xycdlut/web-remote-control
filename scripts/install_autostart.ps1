# 注册计划任务：登录后自动运行 start_all.ps1（Agent + frpc），以最高权限、隐藏窗口
# 需以【管理员】运行。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\install_autostart.ps1
#
# 卸载：
#   Unregister-ScheduledTask -TaskName RemoteControlAgent -Confirm:$false
param(
    [string]$ServerAddr = "YOUR_SERVER_IP",
    [string]$Token = "YOUR_FRP_TOKEN"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $root "scripts\start_all.ps1"
$argStr = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`" -ServerAddr $ServerAddr -Token $Token"

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argStr
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest

Register-ScheduledTask -TaskName "RemoteControlAgent" `
    -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "已注册计划任务 [RemoteControlAgent]：每次登录后自动启动 Agent + frpc" -ForegroundColor Green
Write-Host "现在可立即测试： Start-ScheduledTask -TaskName RemoteControlAgent"
Write-Host ""
Write-Host "提示：本任务在【用户登录后】触发。若被控机需要无人值守，请在 Windows 设置里开启自动登录，"
Write-Host "      或用下方命令开启自动登录（请自行替换密码）："
Write-Host "      netplwiz  ->  取消勾选“要使用本计算机，用户必须输入用户名和密码”"
