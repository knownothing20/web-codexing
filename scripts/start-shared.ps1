param([Parameter(Mandatory=$true)][int]$LauncherPid, [switch]$ReuseOnly)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$runtimePath = Join-Path $root '.local/shared-host.json'
$trayExe = Join-Path $root 'RemoteCoding.exe'
$owner = $null
$signalSent = $false

function Answer([string]$Value) {
    [Console]::WriteLine($Value)
    [Console]::Out.Flush()
    $script:signalSent = $true
}

function DesktopRunning {
    Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -eq $desktopExe -or $_.Path -like '*\WindowsApps\OpenAI.Codex_*\app\ChatGPT.exe'
    }
}

function StartDesktop([string]$Endpoint) {
    if (!(Get-Process -Id $LauncherPid -ErrorAction SilentlyContinue)) { throw 'Launcher exited' }
    if (DesktopRunning) { throw 'Desktop started separately' }
    $previous = $env:CODEX_APP_SERVER_WS_URL
    try {
        $env:CODEX_APP_SERVER_WS_URL = $Endpoint
        Start-Process -FilePath $desktopExe -WorkingDirectory (Split-Path -Parent $desktopExe)
    } finally { $env:CODEX_APP_SERVER_WS_URL = $previous }
}

function OwnedListener([int]$Port, [int]$ProcessId) {
    @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -OwningProcess $ProcessId -State Listen -ErrorAction SilentlyContinue).Count -gt 0
}

try {
    $package = Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
    if (!$package -or [version]$package.Version -lt [version]'26.1117.3838.0') { Answer 'legacy'; return }
    $desktopExe = Join-Path $package.InstallLocation 'app/ChatGPT.exe'
    $codexExe = Join-Path $package.InstallLocation 'app/resources/codex.exe'
    if (!(Test-Path -LiteralPath $desktopExe -PathType Leaf) -or !(Test-Path -LiteralPath $codexExe -PathType Leaf)) { Answer 'legacy'; return }
    if ($env:CODEX_APP_SERVER_FORCE_CLI -eq '1') { Answer 'legacy'; return }

    $saved = $null
    try {
        $candidate = Get-Content -Raw -LiteralPath $runtimePath | ConvertFrom-Json
        $existing = Get-Process -Id ([int]$candidate.pid) -ErrorAction Stop
        if ($existing.Path -eq $codexExe -and $existing.StartTime.ToFileTimeUtc().ToString() -eq $candidate.started -and
            $candidate.port -ge 1024 -and $candidate.port -le 65535 -and (OwnedListener $candidate.port $existing.Id)) { $saved = $candidate }
    } catch { }
    if ($saved) {
        $endpoint = "ws://127.0.0.1:$($saved.port)"
        if (!$ReuseOnly -and !(DesktopRunning)) { StartDesktop $endpoint }
        Answer $endpoint
        return
    }
    if (DesktopRunning) { Answer 'desktop-running'; return }
    if ($ReuseOnly) { Answer 'legacy'; return }

    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try { $listener.Start(); $port = $listener.LocalEndpoint.Port } finally { $listener.Stop() }
    $endpoint = "ws://127.0.0.1:$port"
    $owner = Start-Process -FilePath $codexExe -ArgumentList @('app-server', '--listen', $endpoint) -WorkingDirectory $root -WindowStyle Hidden -PassThru
    $ready = $false
    for ($attempt = 0; $attempt -lt 40 -and !$owner.HasExited; $attempt++) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/readyz" -TimeoutSec 1
            if ($response.StatusCode -eq 200 -and (OwnedListener $port $owner.Id)) { $ready = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 250
    }
    if (!$ready -or $owner.HasExited) { throw 'Shared App Server did not become ready' }
    @{
        pid = $owner.Id
        started = $owner.StartTime.ToFileTimeUtc().ToString()
        port = $port
    } | ConvertTo-Json -Compress | Set-Content -LiteralPath $runtimePath -Encoding ASCII
    StartDesktop $endpoint
    Answer $endpoint

    Start-Sleep -Seconds 4
    while (!$owner.HasExited) {
        $bridgeRunning = Get-Process -Name RemoteCoding -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $trayExe }
        if (!(DesktopRunning) -and !$bridgeRunning) { break }
        Start-Sleep -Seconds 3
    }
} catch {
    if (!$signalSent) {
        [Console]::Error.WriteLine($_.Exception.Message)
        Answer 'failed'
    }
} finally {
    if ($owner) {
        if (!$owner.HasExited) { $owner.Kill() }
        $owner.Dispose()
    }
}
