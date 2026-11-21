param([ValidateRange(1024, 65535)][int]$AppServerPort = 3211)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$package = Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
if (!$package) { throw '找不到 Windows 版 Codex 客户端。' }
$desktopExe = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
$codexExe = Join-Path $package.InstallLocation 'app\resources\codex.exe'
$trayExe = Join-Path $root 'RemoteCoding.exe'
foreach ($exe in @($desktopExe, $codexExe, $trayExe)) {
    if (!(Test-Path -LiteralPath $exe -PathType Leaf)) { throw "找不到启动文件：$exe" }
}

if (Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $desktopExe }) {
    throw '请等当前任务结束，完整退出电脑上的 Codex，再打开这个启动入口。'
}
if (Get-Process -Name RemoteCoding -ErrorAction SilentlyContinue) {
    throw '请在托盘菜单选择“退出 Remote Coding”，然后重新打开这个启动入口。'
}
if ($env:CODEX_APP_SERVER_FORCE_CLI -eq '1') {
    throw '当前 Codex 设置固定使用内置 CLI。请在未设置 CODEX_APP_SERVER_FORCE_CLI 的环境中使用共享入口。'
}

$endpoint = "ws://127.0.0.1:$AppServerPort"
$listener = New-Object Net.Sockets.TcpListener ([Net.IPAddress]::Loopback, $AppServerPort)
try { $listener.Start() } finally { $listener.Stop() }

$owner = Start-Process -FilePath $codexExe -ArgumentList @('app-server', '--listen', $endpoint) -WorkingDirectory $root -WindowStyle Hidden -PassThru
try {
    $ready = $false
    for ($attempt = 0; $attempt -lt 40 -and !$owner.HasExited; $attempt++) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$AppServerPort/readyz" -TimeoutSec 1
            if ($response.StatusCode -eq 200) { $ready = $true; break }
        } catch { Start-Sleep -Milliseconds 250 }
    }
    if (!$ready -or $owner.HasExited) { throw '共享 App Server 启动失败，请检查本机端口和 Codex 版本。' }

    $previousDesktop = $env:CODEX_APP_SERVER_WS_URL
    try {
        $env:CODEX_APP_SERVER_WS_URL = $endpoint
        Start-Process -FilePath $desktopExe -WorkingDirectory (Split-Path -Parent $desktopExe)
    } finally { $env:CODEX_APP_SERVER_WS_URL = $previousDesktop }

    $previousWeb = $env:REMOTE_CODING_APP_SERVER_URL
    $previousTokenFile = $env:REMOTE_CODING_APP_SERVER_TOKEN_FILE
    try {
        $env:REMOTE_CODING_APP_SERVER_URL = $endpoint
        $env:REMOTE_CODING_APP_SERVER_TOKEN_FILE = $null
        Start-Process -FilePath $trayExe -WorkingDirectory $root -ArgumentList '--background' -WindowStyle Hidden
    } finally {
        $env:REMOTE_CODING_APP_SERVER_URL = $previousWeb
        $env:REMOTE_CODING_APP_SERVER_TOKEN_FILE = $previousTokenFile
    }

    Write-Host '共享 App Server 已启动。请在电脑 Codex 打开要继续的会话，然后刷新手机网页。'
    Write-Host '退出桌面和托盘后，此窗口会自动关闭共享 App Server。'
    Start-Sleep -Seconds 5
    while (!$owner.HasExited) {
        $desktopRunning = Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $desktopExe }
        $bridgeRunning = Get-Process -Name RemoteCoding -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $trayExe }
        if (!$desktopRunning -and !$bridgeRunning) { break }
        Start-Sleep -Seconds 3
    }
} finally {
    if (!$owner.HasExited) { $owner.Kill() }
    $owner.Dispose()
}
