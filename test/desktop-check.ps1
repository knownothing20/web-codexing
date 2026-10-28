param([Parameter(Mandatory=$true)][string]$ProjectRoot, [Parameter(Mandatory=$true)][string]$TestRoot)
$ErrorActionPreference = 'Stop'
$executable = Join-Path $TestRoot 'Remote Coding.exe'
& (Join-Path $ProjectRoot 'build.ps1') -OutputPath $executable | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Launcher build failed.' }

Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ShellIconCheck {
    [DllImport("shell32.dll", CharSet=CharSet.Unicode)]
    public static extern uint ExtractIconEx(string file, int index, IntPtr large, IntPtr small, uint count);
}
'@
if ([ShellIconCheck]::ExtractIconEx($executable, -1, [IntPtr]::Zero, [IntPtr]::Zero, 0) -lt 1) { throw 'EXE has no shell icon.' }
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($executable)
try {
    $bitmap = $icon.ToBitmap()
    try {
        $bitmap.Save((Join-Path $TestRoot 'shell-icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
        $green = $bitmap.GetPixel([int]($bitmap.Width / 2), [int]($bitmap.Height / 6))
        if ($green.G -le $green.R -or $green.G -le $green.B) { throw 'Shell icon does not contain application artwork.' }
    } finally { $bitmap.Dispose() }
} finally { $icon.Dispose() }
$assembly = [Reflection.Assembly]::LoadFile($executable)
# Exercise the exact startup implementation against an isolated HKCU test key.
# Never change this computer's real login startup preference during automated tests.
$startup = $assembly.GetType('StartupSetting', $true)
$flags = [Reflection.BindingFlags]'Static,NonPublic'
$readStartup = $startup.GetMethod('Read', $flags)
$writeStartup = $startup.GetMethod('Write', $flags)
$testKeyPath = 'Software\RemoteCoding\Tests\' + [Guid]::NewGuid().ToString('N')
$testKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($testKeyPath)
try {
    $testKey.SetValue('Unrelated', 'keep')
    if ($readStartup.Invoke($null, @($testKey, $executable.PSObject.BaseObject))) { throw 'Startup unexpectedly enabled.' }
    $writeStartup.Invoke($null, @($testKey, $executable.PSObject.BaseObject, $true))
    if (-not $readStartup.Invoke($null, @($testKey, $executable.PSObject.BaseObject))) { throw 'Startup enable failed.' }
    if ($testKey.GetValue('RemoteCoding') -ne ('"' + $executable + '" --background')) { throw 'Startup executable is not quoted or quiet.' }
    $testKey.Close()
    $testKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($testKeyPath, $true)
    if (-not $readStartup.Invoke($null, @($testKey, $executable.PSObject.BaseObject))) { throw 'Startup did not persist.' }
    if ($readStartup.Invoke($null, @($testKey, [IO.Path]::Combine($TestRoot, 'other.exe')))) { throw 'Different executable treated as enabled.' }
    $writeStartup.Invoke($null, @($testKey, $executable.PSObject.BaseObject, $false))
    $writeStartup.Invoke($null, @($testKey, $executable.PSObject.BaseObject, $false))
    if ($readStartup.Invoke($null, @($testKey, $executable.PSObject.BaseObject))) { throw 'Startup disable failed.' }
    if ($testKey.GetValue('Unrelated') -ne 'keep') { throw 'Unrelated startup item changed.' }
} finally {
    $testKey.Dispose()
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($testKeyPath, $false)
}
$stream = $assembly.GetManifestResourceStream('RemoteCoding.Icon')
try {
    if ($null -eq $stream) { throw 'Missing window/tray icon resource.' }
    $file = [IO.File]::Create((Join-Path $TestRoot 'embedded.ico'))
    try { $stream.CopyTo($file) } finally { $file.Dispose() }
    $stream.Position = 0
    $embedded = New-Object System.Drawing.Icon($stream, 32, 32)
    $embedded.Dispose()
} finally { if ($null -ne $stream) { $stream.Dispose() } }

$desktop = Join-Path $TestRoot ('desktop space ' + [char]0x6D4B + [char]0x8BD5)
New-Item -ItemType Directory -Path $desktop | Out-Null
function Run-Shortcut([string]$Directory) {
    $process = New-Object Diagnostics.Process
    $process.StartInfo.FileName = $executable
    $process.StartInfo.Arguments = '--create-shortcut "' + $Directory + '"'
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.RedirectStandardError = $true
    try {
        if (-not $process.Start()) { throw 'Could not launch shortcut command.' }
        $details = $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        $code = $process.ExitCode
        if ($code -ne 0 -and $details) { Write-Host $details }
        return $code
    } finally { $process.Dispose() }
}
if ((Run-Shortcut $desktop) -ne 0) { throw 'Shortcut creation failed.' }
$path = Join-Path $desktop 'Remote Coding.lnk'
$shell = New-Object -ComObject WScript.Shell
# Independently inspect the saved link through WScript, but use an ASCII link
# filename: WScript itself cannot save a Unicode path on English Windows.
$inspection = Join-Path $TestRoot 'inspect.lnk'
try {
    Copy-Item -LiteralPath $path -Destination $inspection -Force
    $link = $shell.CreateShortcut($inspection)
    try {
        if ($link.TargetPath -ne $executable) { throw 'Shortcut target mismatch.' }
        if ($link.WorkingDirectory.TrimEnd('\') -ne $TestRoot.TrimEnd('\')) { throw 'Shortcut working directory mismatch.' }
        if ($link.IconLocation -ne ($executable + ',0')) { throw 'Shortcut icon mismatch.' }
        if ($link.Arguments -ne '') { throw 'Unexpected shortcut arguments.' }
        if ($link.Description -notlike 'Remote Coding*') { throw 'Shortcut description missing.' }
        $link.Arguments = '--exit'
        $link.Save()
    } finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($link) | Out-Null }
    Copy-Item -LiteralPath $inspection -Destination $path -Force
    if ((Run-Shortcut $desktop) -ne 0) { throw 'Shortcut update failed.' }
    Copy-Item -LiteralPath $path -Destination $inspection -Force
    $link = $shell.CreateShortcut($inspection)
    try {
        if ($link.Arguments -ne '') { throw 'Shortcut update did not clear old arguments.' }
        $link.TargetPath = Join-Path $TestRoot 'unrelated.exe'
        $link.Save()
    } finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($link) | Out-Null }
    Copy-Item -LiteralPath $inspection -Destination $path -Force
    $before = [Convert]::ToBase64String([IO.File]::ReadAllBytes($path))
    if ((Run-Shortcut $desktop) -eq 0) { throw 'Unrelated shortcut was not rejected.' }
    if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($path)) -ne $before) { throw 'Unrelated shortcut was modified.' }
    $missing = Join-Path $TestRoot 'missing'
    if ((Run-Shortcut $missing) -eq 0 -or (Test-Path -LiteralPath $missing)) { throw 'Missing directory was not handled safely.' }
} finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null }
Write-Output 'Desktop checks passed: startup enable/disable/persistence/quoted background command; native EXE icon, embedded tray icon, shortcut target/icon/working directory, Unicode paths, repeat update, conflict preservation, missing directory.'
