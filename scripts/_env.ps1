# 公共函数：解析被控机 Agent 的 Python 解释器（可复用，不绑定任何机器的绝对路径）
# 规则：优先 -PyExe 参数 -> 环境变量 RC_PY -> 项目内 .venv\Scripts\python.exe -> PATH 上的 python
# 用法：. "$PSScriptRoot\_env.ps1" 之后调用 Prepare-RcPython / Test-RcDeps / Install-RcDeps

# 可选：本机私有覆盖（scripts\local.ps1，已 gitignore）。可在此设置 $env:RC_PY 等本机专属值。
$__rc_local = Join-Path $PSScriptRoot "local.ps1"
if (Test-Path $__rc_local) { . $__rc_local }

function Get-RcPython {
    param([string]$PyExe)
    if ($PyExe) { return $PyExe }
    if ($env:RC_PY) { return $env:RC_PY }
    $root = Split-Path -Parent $PSScriptRoot
    $venv = Join-Path $root ".venv\Scripts\python.exe"
    if (Test-Path $venv) { return $venv }
    $c = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    throw "未找到 Python：请安装 Python 3.9+，或设置环境变量 RC_PY 指向 python.exe，或在项目内创建 .venv。"
}

function Prepare-RcPython {
    param([string]$PyExe)
    $py = Get-RcPython -PyExe $PyExe
    $dir = Split-Path -Parent $py
    # conda 环境未激活时需把 Library\bin 加入 PATH，否则 python 的 ssl 模块不可用
    $libbin = Join-Path $dir "Library\bin"
    if (Test-Path $libbin) { $env:PATH = "$dir;$libbin;$env:PATH" } else { $env:PATH = "$dir;$env:PATH" }
    return $py
}

function Test-RcDeps {
    param([string]$PyExe)
    & $PyExe -c "import aiortc, av, cv2" 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
}

function Install-RcDeps {
    param([string]$PyExe, [string]$Root)
    Write-Host "[*] 安装 Python 依赖（首次约几分钟）..." -ForegroundColor Cyan
    & $PyExe -m pip install --only-binary=:all: -r (Join-Path $Root "requirements.txt")
    if (-not $?) { throw "依赖安装失败" }
}
